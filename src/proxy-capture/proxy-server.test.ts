// Proxy capture server tests cover request recording and response handling.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { DebugProxySettings } from "./env.js";
import { redactHeaders } from "./header-redaction.js";
import { parseConnectTarget, startDebugProxyServer } from "./proxy-server.js";
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

async function startLargeBodyOrigin(): Promise<{
  receivedRequestBody: () => string;
  responseBody: string;
  stop: () => Promise<void>;
  url: string;
}> {
  let receivedBody = "";
  const responseBody = "r".repeat(12_000);
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

describe("parseConnectTarget", () => {
  it("parses bracketed IPv6 CONNECT targets safely", () => {
    expect(parseConnectTarget("[::1]:8443")).toEqual({
      hostname: "::1",
      port: 8443,
    });
  });

  it("parses unbracketed host:port CONNECT targets", () => {
    expect(parseConnectTarget("api.openai.com:443")).toEqual({
      hostname: "api.openai.com",
      port: 443,
    });
  });

  it("rejects invalid CONNECT ports", () => {
    expect(() => parseConnectTarget("[::1]:99999")).toThrow("Invalid CONNECT target port");
    expect(() => parseConnectTarget("api.openai.com:1e3")).toThrow("Invalid CONNECT target port");
    expect(() => parseConnectTarget("api.openai.com:0x50")).toThrow("Invalid CONNECT target port");
  });
});

describe("startDebugProxyServer", () => {
  it("caps captured body previews while forwarding full request and response bodies", async () => {
    const settings = await makeSettings();
    const origin = await startLargeBodyOrigin();
    const proxy = await startDebugProxyServer({ settings });
    const requestBody = "q".repeat(12_000);

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
      expect(capturedRequest?.dataText).toBe("q".repeat(8192));
      expect(capturedResponse?.dataText).toBe("r".repeat(8192));
      expect(JSON.parse(String(capturedRequest?.metaJson))).toMatchObject({
        bodyBytes: 12_000,
        capturePreviewBytes: 8192,
        captureTruncated: true,
      });
      expect(JSON.parse(String(capturedResponse?.metaJson))).toMatchObject({
        bodyBytes: 12_000,
        capturePreviewBytes: 8192,
        captureTruncated: true,
      });
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
