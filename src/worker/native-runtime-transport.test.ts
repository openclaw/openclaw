import { spawn, type ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import {
  createServer as createHttpServer,
  request,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { PROXY_FIXTURE_CERTIFICATE, PROXY_FIXTURE_KEY } from "../test-helpers/proxy-tls-fixture.js";
import type { NativeRuntimeConfig } from "./native-runtime-config.js";
import { buildNativeRuntimeFetch, isNativeRuntimeEndpoint } from "./native-runtime-transport.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
const servers: Server[] = [];
const children: ChildProcess[] = [];
const apis = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "mistral-conversations",
  "google-generative-ai",
  "google-vertex",
  "google-interactions",
  "openai-chatgpt-responses",
];
const opaque = "external-proxy-fixture-authorization";
const sensitiveHeader = "external-custom-header-fixture";
const providerOnly = "custodian-only-provider-fixture";
const jwt = [
  Buffer.from('{"alg":"none"}').toString("base64url"),
  Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } }),
  ).toString("base64url"),
  "synthetic",
].join(".");
const observed: { path: string; custom: boolean; authenticated: boolean }[] = [];
let sinkHits = 0;
let forwardedSensitiveHeaders = 0;
let wrongNameOrigin: string;
let providerHits = 0;
let tlsOrigin: string;
let httpOrigin: string;
let workspace: string;
let trusted: ChildProcess;
let untrusted: ChildProcess;
let nextId = 0;

async function listen(server: Server, host = "127.0.0.1"): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing fixture listener");
  }
  return host + ":" + address.port;
}
function config(api: string, baseUrl: string): NativeRuntimeConfig {
  return {
    models: [
      {
        provider: "fixture",
        id: "fixture-model",
        api,
        baseUrl,
        contextWindow: 8192,
        maxTokens: 256,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        apiKeyEnv: "NATIVE_PROXY_AUTH",
        headers: { "x-worker-session": sensitiveHeader },
        sensitiveHeaderNames: ["x-worker-session"],
      },
    ],
    workspaces: [{ id: "test", path: workspace, models: ["fixture/fixture-model"] }],
  };
}
function run(
  child: ChildProcess,
  api: string,
  url: string,
): Promise<{ stopReason: string; text?: string }> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const exited = () => {
      child.off("message", received);
      reject(new Error("Transport probe exited"));
    };
    const received = (value: { id: number; stopReason: string; text?: string }) => {
      if (value.id === id) {
        child.off("message", received);
        child.off("exit", exited);
        resolve(value);
      }
    };
    child.on("message", received);
    child.once("exit", exited);
    child.send({
      id,
      config: config(api, url),
      credential: api === "openai-chatgpt-responses" ? jwt : opaque,
    });
  });
}

beforeAll(async () => {
  workspace = dirs.make("native-transport-qualification-");
  const entry = path.join(workspace, "probe.mjs");
  const ca = path.join(workspace, "fixture-ca.pem");
  await writeFile(ca, PROXY_FIXTURE_CERTIFICATE);
  await build({
    entryPoints: [
      fileURLToPath(new URL("./native-runtime-transport.test-support.ts", import.meta.url)),
    ],
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    banner: {
      js: 'import { createRequire as createNativeTransportProbeRequire } from "node:module"; const require = createNativeTransportProbeRequire(import.meta.url);',
    },
  });
  const spawnProbe = (trust: boolean) => {
    const child = spawn(process.execPath, [entry], {
      cwd: workspace,
      env: trust ? { NODE_EXTRA_CA_CERTS: ca } : {},
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    children.push(child);
    return child;
  };
  trusted = spawnProbe(true);
  untrusted = spawnProbe(false);
  const upstream = await listen(
    createHttpServer((req, res) => {
      expect(req.headers.authorization).toBe("Bearer " + providerOnly);
      providerHits++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        "data: " +
          JSON.stringify({
            id: "fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture-model",
            choices: [{ index: 0, delta: { content: "qualified" }, finish_reason: "stop" }],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
    }),
  );
  httpOrigin =
    "http://" +
    (await listen(
      createHttpServer((req, res) => {
        sinkHits++;
        forwardedSensitiveHeaders += Number(req.headers["x-worker-session"] === sensitiveHeader);
        res.writeHead(401);
        res.end();
      }),
    ));
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const p = req.url ?? "";
    observed.push({
      path: p,
      custom: req.headers["x-worker-session"] === sensitiveHeader,
      authenticated:
        req.headers.authorization === "Bearer " + opaque ||
        req.headers.authorization === "Bearer " + jwt ||
        req.headers["x-api-key"] === opaque ||
        req.headers["x-goog-api-key"] === opaque,
    });
    if (p.startsWith("/success/")) {
      // Synthetic custodian owns this provider key in the parent; only opaque auth and CA
      // enter the compiled runtime child. This is not an OS workload-isolation claim.
      if (req.headers.authorization !== "Bearer " + opaque) {
        res.writeHead(401);
        res.end();
        return;
      }
      const forward = request(
        "http://" + upstream,
        { method: "POST", headers: { authorization: "Bearer " + providerOnly } },
        (reply) => {
          res.writeHead(reply.statusCode ?? 500, reply.headers);
          reply.pipe(res);
        },
      );
      forward.on("error", () => {
        res.writeHead(502);
        res.end();
      });
      req.pipe(forward);
      return;
    }
    if (p.startsWith("/same-origin/")) {
      res.writeHead(307, { location: tlsOrigin + "/redirect-recipient" });
      res.end();
      return;
    }
    if (p.startsWith("/redirect/")) {
      res.writeHead(307, { location: httpOrigin + "/redirect-recipient" });
      res.end();
      return;
    }
    if (p.startsWith("/redirect-recipient")) {
      sinkHits++;
    }
    res.writeHead(401);
    res.end();
  };
  wrongNameOrigin =
    "https://" +
    (await listen(
      createHttpsServer({ key: PROXY_FIXTURE_KEY, cert: PROXY_FIXTURE_CERTIFICATE }, handle),
      "127.0.0.2",
    ));
  tlsOrigin =
    "https://" +
    (await listen(
      createHttpsServer({ key: PROXY_FIXTURE_KEY, cert: PROXY_FIXTURE_CERTIFICATE }, handle),
    ));
});
afterAll(async () => {
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
          child.disconnect();
        }),
    ),
  );
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((e) => (e ? reject(e) : resolve()));
        }),
    ),
  );
});
it("rejects non-loopback plaintext configuration before any request", async () => {
  for (const endpoint of [
    "http://custodian.example.test/v1",
    "http://192.0.2.9/v1",
    "http://localhost/v1",
  ]) {
    expect((await run(trusted, "openai-completions", endpoint)).stopReason).toBe("startup-error");
  }
});
it("uses a trusted private CA with a separate synthetic custodian and never sends its provider key to the runtime", async () => {
  const prior = providerHits;
  expect(await run(trusted, "openai-completions", tlsOrigin + "/success/v1")).toMatchObject({
    stopReason: "stop",
    text: "qualified",
  });
  expect(providerHits).toBe(prior + 1);
  expect(JSON.stringify(config("openai-completions", tlsOrigin))).not.toContain(providerOnly);
});
it("rejects an untrusted certificate before auth reaches the endpoint", async () => {
  const prior = observed.length;
  expect((await run(untrusted, "openai-completions", tlsOrigin + "/observe")).stopReason).toBe(
    "error",
  );
  expect(observed).toHaveLength(prior);
});
it("binds real built-in SDK requests to their endpoint without forwarding auth on redirects", async () => {
  const results = [];
  for (const api of apis) {
    const prior = observed.length;
    await run(trusted, api, tlsOrigin + "/observe/" + api);
    expect(
      observed.length,
      api + " must reach the TLS fixture through its real SDK",
    ).toBeGreaterThan(prior);
    expect(
      observed.slice(prior).every((r) => r.custom && r.authenticated),
      api,
    ).toBe(true);
    const before = sinkHits;
    const beforeHeaders = forwardedSensitiveHeaders;
    await run(trusted, api, tlsOrigin + "/redirect/" + api);
    results.push({
      api,
      redirectRecipientRequests: sinkHits - before,
      forwardedSensitiveHeaders: forwardedSensitiveHeaders - beforeHeaders,
    });
  }
  expect(results).toEqual(
    apis.map((api) => ({ api, redirectRecipientRequests: 0, forwardedSensitiveHeaders: 0 })),
  );
});
it("rejects even a same-origin redirect instead of replaying sensitive headers", async () => {
  const prior = sinkHits;
  await run(trusted, "openai-completions", tlsOrigin + "/same-origin/v1");
  expect(sinkHits).toBe(prior);
});

it("keeps hostname verification enabled with a trusted CA", async () => {
  const prior = observed.length;
  expect((await run(trusted, "openai-completions", wrongNameOrigin + "/observe")).stopReason).toBe(
    "error",
  );
  expect(observed).toHaveLength(prior);
});
it("permits a directly configured literal loopback HTTP hop", async () => {
  const prior = sinkHits;
  expect((await run(trusted, "openai-completions", httpOrigin + "/direct")).stopReason).toBe(
    "error",
  );
  expect(sinkHits).toBe(prior + 1); // fixture deliberately answers401, proving transport admission
});
it("uses canonical loopback IP classification rather than DNS-looking names", () => {
  for (const url of [
    "http://127.0.0.1/v1",
    "http://127.1/v1",
    "http://[::1]/v1",
    "http://[::ffff:127.0.0.1]/v1",
    "https://custodian.example.test/v1",
  ]) {
    expect(isNativeRuntimeEndpoint(url), url).toBe(true);
  }
  for (const url of [
    "http://localhost/v1",
    "http://127.0.0.1.example.test/v1",
    "http://192.0.2.9/v1",
    "https://user:password@example.test/v1",
    "https://example.test/v1?key=value",
  ]) {
    expect(isNativeRuntimeEndpoint(url), url).toBe(false);
  }
});
it("rejects an SDK request to an unprovisioned origin before network I/O", () => {
  const fetcher = buildNativeRuntimeFetch({ baseUrl: tlsOrigin });
  expect(() => fetcher(httpOrigin + "/outside")).toThrow("configured endpoint origin");
  expect(() => fetcher("https://unprovisioned.example.test/v1")).toThrow(
    "configured endpoint origin",
  );
});
