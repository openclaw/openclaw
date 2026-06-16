// Proxy capture server tests cover request recording and response handling.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  request as httpRequest,
  createServer as createHttpServer,
  type IncomingMessage,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { DebugProxySettings } from "./env.js";
import { redactHeaders } from "./header-redaction.js";
import { startDebugProxyServer } from "./proxy-server.js";
import { closeDebugProxyCaptureStore, getDebugProxyCaptureStore } from "./store.sqlite.js";

let testRoot: string | undefined;
const originalStateDir = process.env.OPENCLAW_STATE_DIR;

async function cleanupTestRoot(): Promise<void> {
  closeDebugProxyCaptureStore();
  closeOpenClawStateDatabaseForTest();
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  if (!testRoot) {
    return;
  }
  const root = testRoot;
  testRoot = undefined;
  await rm(root, { recursive: true, force: true });
}

async function makeSettings(): Promise<DebugProxySettings> {
  testRoot = await mkdtemp(join(tmpdir(), "openclaw-debug-proxy-server-"));
  const certDir = join(testRoot, "certs");
  await mkdir(certDir, { recursive: true });
  await writeFile(join(certDir, "root-ca.pem"), "test root cert\n", "utf8");
  await writeFile(join(certDir, "root-ca-key.pem"), "test root key\n", "utf8");
  process.env.OPENCLAW_STATE_DIR = testRoot;
  return {
    enabled: true,
    required: false,
    dbPath: join(testRoot, "capture.sqlite"),
    blobDir: join(testRoot, "blobs"),
    certDir,
    sessionId: "debug-proxy-server-test",
    sourceProcess: "test",
  };
}

async function startLargeBodyOrigin(responseBody: string): Promise<{
  receivedRequestBody: () => string;
  responseBody: string;
  stop: () => Promise<void>;
  url: string;
}> {
  let receivedBody = "";
  const server = createHttpServer((req, res) => {
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      receivedBody += chunk;
    });
    req.on("end", () => {
      res.writeHead(200, {
        "content-length": Buffer.byteLength(responseBody),
        "content-type": "text/plain; charset=utf-8",
      });
      res.end(responseBody);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    receivedRequestBody: () => receivedBody,
    responseBody,
    stop: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
    url: `http://127.0.0.1:${address.port}/capture`,
  };
}

async function startResponseErrorOrigin(): Promise<{
  stop: () => Promise<void>;
  url: string;
}> {
  const server = createHttpServer((req, res) => {
    if (req.url === "/before-headers") {
      res.socket?.destroy();
      return;
    }
    if (req.url === "/after-headers") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.flushHeaders();
      res.write("partial");
      setTimeout(() => res.socket?.destroy(), 50);
      return;
    }
    res.writeHead(200, {
      "content-length": 2,
      "content-type": "text/plain; charset=utf-8",
    });
    res.end("ok");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    stop: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
    url: `http://127.0.0.1:${address.port}`,
  };
}

type ProxyResponseResult = {
  body: string;
  complete: boolean;
  errorMessage?: string;
  statusCode?: number;
};

async function getThroughProxy(proxyUrl: string, targetUrl: string): Promise<ProxyResponseResult> {
  const proxy = new URL(proxyUrl);
  return await new Promise<ProxyResponseResult>((resolve) => {
    let settled = false;
    let body = "";
    let response: IncomingMessage | undefined;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        body,
        complete: response?.complete ?? false,
        ...(error ? { errorMessage: error.message } : {}),
        ...(response?.statusCode === undefined ? {} : { statusCode: response.statusCode }),
      });
    };
    const req = httpRequest(
      {
        host: proxy.hostname,
        port: Number(proxy.port),
        method: "GET",
        path: targetUrl,
        headers: { connection: "close" },
      },
      (res) => {
        response = res;
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => finish());
        res.on("error", finish);
        res.on("close", () => {
          if (!res.complete) {
            finish(new Error("response closed before completion"));
          }
        });
      },
    );
    req.on("error", finish);
    req.end();
  });
}

async function postThroughProxy(params: {
  body: string;
  proxyUrl: string;
  targetUrl: string;
}): Promise<string> {
  const proxy = new URL(params.proxyUrl);
  return await new Promise<string>((resolve, reject) => {
    const req = httpRequest(
      {
        host: proxy.hostname,
        port: Number(proxy.port),
        method: "POST",
        path: params.targetUrl,
        headers: {
          connection: "close",
          "content-length": Buffer.byteLength(params.body),
          "content-type": "text/plain; charset=utf-8",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
      },
    );
    req.on("error", reject);
    req.end(params.body);
  });
}

afterEach(async () => {
  await cleanupTestRoot();
});

describe("startDebugProxyServer", () => {
  it("caps UTF-8 previews on character boundaries while forwarding full bodies", async () => {
    const settings = await makeSettings();
    const origin = await startLargeBodyOrigin(`${"r".repeat(8191)}😀tail`);
    const proxy = await startDebugProxyServer({ settings });
    const requestBody = `${"q".repeat(8191)}étail`;

    try {
      const responseBody = await postThroughProxy({
        body: requestBody,
        proxyUrl: proxy.proxyUrl,
        targetUrl: origin.url,
      });

      expect(origin.receivedRequestBody()).toBe(requestBody);
      expect(responseBody).toBe(origin.responseBody);
      const events = getDebugProxyCaptureStore().getSessionEvents(settings.sessionId, 10);
      const capturedRequest = events.find((event) => event.kind === "request");
      const capturedResponse = events.find((event) => event.kind === "response");
      expect(capturedRequest?.dataText).toBe("q".repeat(8191));
      expect(capturedResponse?.dataText).toBe("r".repeat(8191));
      expect(JSON.parse(String(capturedRequest?.metaJson))).toMatchObject({
        bodyBytes: Buffer.byteLength(requestBody),
        capturePreviewBytes: 8192,
        captureTruncated: true,
      });
      expect(JSON.parse(String(capturedResponse?.metaJson))).toMatchObject({
        bodyBytes: Buffer.byteLength(origin.responseBody),
        capturePreviewBytes: 8192,
        captureTruncated: true,
      });
    } finally {
      await proxy.stop();
      await origin.stop();
    }
  });

  it("returns a complete 502 and survives an upstream failure before response headers", async () => {
    const settings = await makeSettings();
    const origin = await startResponseErrorOrigin();
    const proxy = await startDebugProxyServer({ settings });

    try {
      const failed = await getThroughProxy(proxy.proxyUrl, `${origin.url}/before-headers`);
      expect(failed).toMatchObject({
        body: "Bad Gateway\n",
        complete: true,
        statusCode: 502,
      });

      const healthy = await getThroughProxy(proxy.proxyUrl, `${origin.url}/healthy`);
      expect(healthy).toMatchObject({ body: "ok", complete: true, statusCode: 200 });
      expect(getDebugProxyCaptureStore().getSessionEvents(settings.sessionId, 20)).toContainEqual(
        expect.objectContaining({ direction: "local", kind: "error" }),
      );
    } finally {
      await proxy.stop();
      await origin.stop();
    }
  });

  it("aborts a partial response after headers and survives the upstream stream error", async () => {
    const settings = await makeSettings();
    const origin = await startResponseErrorOrigin();
    const proxy = await startDebugProxyServer({ settings });

    try {
      const failed = await getThroughProxy(proxy.proxyUrl, `${origin.url}/after-headers`);
      expect(failed).toMatchObject({
        body: "partial",
        complete: false,
        statusCode: 200,
      });
      expect(failed.errorMessage).toBeDefined();

      const healthy = await getThroughProxy(proxy.proxyUrl, `${origin.url}/healthy`);
      expect(healthy).toMatchObject({ body: "ok", complete: true, statusCode: 200 });
      expect(getDebugProxyCaptureStore().getSessionEvents(settings.sessionId, 20)).toContainEqual(
        expect.objectContaining({ direction: "inbound", kind: "error" }),
      );
    } finally {
      await proxy.stop();
      await origin.stop();
    }
  });
});

describe("redactHeaders", () => {
  it("redacts all exact-match sensitive header names", () => {
    const headers: Record<string, string> = {
      authorization: "Bearer tok_abc123",
      "proxy-authorization": "Basic cHJveHk6cGFzcw==",
      cookie: "sid=session-value",
      "set-cookie": "sid=response-value",
      "x-api-key": "key-12345",
      "api-key": "key-67890",
      apikey: "key-abcde",
      "x-auth-token": "auth-tok-xyz",
      "auth-token": "auth-tok-abc",
      "x-access-token": "access-tok-xyz",
      "access-token": "access-tok-abc",
    };
    const result = redactHeaders(headers);
    for (const name of Object.keys(headers)) {
      expect(result[name]).toBe("[REDACTED]");
    }
  });

  it("preserves non-sensitive headers unchanged", () => {
    const headers = {
      "content-type": "application/json",
      accept: "text/html",
      "cache-control": "no-cache",
      "x-request-id": "req-123",
      host: "api.example.com",
    };
    const result = redactHeaders(headers);
    expect(result).toStrictEqual(headers);
  });

  it("redacts headers matching sensitive fragments", () => {
    const headers: Record<string, string> = {
      "x-custom-api-key": "my-api-key-value",
      "x-my-apikey-header": "my-apikey-value",
      "x-refresh-token": "refresh-tok-abc",
      "x-client-secret": "secret-value",
      "x-db-password": "db-pass-value",
      "x-aws-credential": "aws-cred-value",
      "x-session-id": "sess-id-value",
    };
    const result = redactHeaders(headers);
    for (const name of Object.keys(headers)) {
      expect(result[name]).toBe("[REDACTED]");
    }
  });

  it("matches header names case-insensitively", () => {
    const headers: Record<string, string> = {
      Authorization: "Bearer tok_case",
      COOKIE: "sid=UPPER",
      "X-API-KEY": "key-upper",
      "X-Api-Key": "key-mixed",
      "Set-Cookie": "sid=mixed-case",
      "Proxy-Authorization": "Basic mixed",
    };
    const result = redactHeaders(headers);
    for (const name of Object.keys(headers)) {
      expect(result[name]).toBe("[REDACTED]");
    }
  });

  it("handles empty headers object", () => {
    expect(redactHeaders({})).toStrictEqual({});
  });

  it("preserves undefined header values for non-sensitive headers", () => {
    const headers: Record<string, string | string[] | undefined> = {
      "x-optional": undefined,
      "content-type": "text/plain",
    };
    const result = redactHeaders(headers);
    expect(result["x-optional"]).toBeUndefined();
    expect(result["content-type"]).toBe("text/plain");
  });

  it("redacts sensitive headers with array values", () => {
    const headers: Record<string, string | string[] | undefined> = {
      "set-cookie": ["sid=val1", "token=val2"],
      "content-type": "text/html",
    };
    const result = redactHeaders(headers);
    expect(result["set-cookie"]).toBe("[REDACTED]");
    expect(result["content-type"]).toBe("text/html");
  });

  it("handles mixed sensitive and non-sensitive headers together", () => {
    const headers = {
      host: "api.openai.com",
      authorization: "Bearer sk-abc",
      "content-type": "application/json",
      cookie: "session=xyz",
      accept: "*/*",
      "x-custom-token": "custom-tok",
      "user-agent": "openclaw/1.0",
    };
    const result = redactHeaders(headers);
    expect(result).toStrictEqual({
      host: "api.openai.com",
      authorization: "[REDACTED]",
      "content-type": "application/json",
      cookie: "[REDACTED]",
      accept: "*/*",
      "x-custom-token": "[REDACTED]",
      "user-agent": "openclaw/1.0",
    });
  });

  it("handles header names with leading/trailing whitespace via trim", () => {
    const headers: Record<string, string | undefined> = {
      " authorization ": "Bearer trimmed",
      " content-type ": "application/json",
    };
    const result = redactHeaders(headers);
    expect(result[" authorization "]).toBe("[REDACTED]");
    expect(result[" content-type "]).toBe("application/json");
  });

  it("does not redact fragment-like values in non-matching header names", () => {
    const headers = {
      "x-request-id": "token-like-value-but-safe-header",
      "content-length": "42",
    };
    const result = redactHeaders(headers);
    expect(result["x-request-id"]).toBe("token-like-value-but-safe-header");
    expect(result["content-length"]).toBe("42");
  });
});
