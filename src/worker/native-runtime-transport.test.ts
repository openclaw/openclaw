import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import {
  createServer as createHttpServer,
  request,
  type Server,
  type RequestListener,
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
import {
  closeNativeServers,
  listenNativeServer,
  nativeProviderFixture,
} from "./native-worker.test-support.js";

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
const observed: boolean[] = [];
let sinkHits = 0;
let forwardedSensitiveHeaders = 0;
let wrongNameOrigin: string;
let provider: Awaited<ReturnType<typeof nativeProviderFixture>>;
let tlsOrigin: string;
let httpOrigin: string;
let workspace: string;
let trusted: ChildProcess;
let untrusted: ChildProcess;
let nextId = 0;

async function listen(handler: RequestListener, tls = false): Promise<string> {
  const server = tls
    ? createHttpsServer({ key: PROXY_FIXTURE_KEY, cert: PROXY_FIXTURE_CERTIFICATE }, handler)
    : createHttpServer(handler);
  const port = await listenNativeServer(server, servers);
  return `${tls ? "https" : "http"}://127.0.0.1:${port}`;
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
        headers: { "x-worker-session": sensitiveHeader },
      },
    ],
    workspace,
  };
}
type ProbeReply = { id: number; stopReason: string; text?: string };
function run(child: ChildProcess, api: string, url: string): Promise<ProbeReply> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const exited = () => {
      child.off("message", received);
      reject(new Error("Transport probe exited"));
    };
    const received = (value: ProbeReply) => {
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

async function expectRejectedBeforeRequest(child: ChildProcess, url: string) {
  const prior = observed.length;
  expect((await run(child, "openai-completions", url)).stopReason).toBe("error");
  expect(observed).toHaveLength(prior);
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
  provider = await nativeProviderFixture(servers, "fixture-model", () => "qualified", "qualified");
  httpOrigin = await listen((req, res) => {
    sinkHits++;
    forwardedSensitiveHeaders += Number(req.headers["x-worker-session"] === sensitiveHeader);
    res.writeHead(401).end();
  });
  const handle: RequestListener = (req, res) => {
    const p = req.url ?? "";
    observed.push(
      req.headers["x-worker-session"] === sensitiveHeader &&
        (req.headers.authorization === "Bearer " + opaque ||
          req.headers.authorization === "Bearer " + jwt ||
          req.headers["x-api-key"] === opaque ||
          req.headers["x-goog-api-key"] === opaque),
    );
    if (p.startsWith("/success/")) {
      // Synthetic custodian owns this provider key in the parent; only opaque auth and CA
      // enter the compiled runtime child. This is not an OS workload-isolation claim.
      if (req.headers.authorization !== "Bearer " + opaque) {
        res.writeHead(401).end();
        return;
      }
      const forward = request(
        provider.baseUrl,
        { method: "POST", headers: { authorization: "Bearer " + providerOnly } },
        (reply) => {
          res.writeHead(reply.statusCode ?? 500, reply.headers);
          reply.pipe(res);
        },
      );
      forward.on("error", () => {
        res.writeHead(502).end();
      });
      req.pipe(forward);
      return;
    }
    if (p.startsWith("/same-origin/")) {
      res.writeHead(307, { location: tlsOrigin + "/redirect-recipient" }).end();
      return;
    }
    if (p.startsWith("/redirect/")) {
      res.writeHead(307, { location: httpOrigin + "/redirect-recipient" }).end();
      return;
    }
    if (p.startsWith("/redirect-recipient")) {
      sinkHits++;
    }
    res.writeHead(401).end();
  };
  wrongNameOrigin = (await listen(handle, true)).replace("127.0.0.1", "localhost");
  tlsOrigin = await listen(handle, true);
});
afterAll(async () => {
  await Promise.all(
    children.map(async (child) => {
      const exited = once(child, "exit");
      child.disconnect();
      await exited;
    }),
  );
  await closeNativeServers(servers);
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
  const prior = provider.requests.length;
  expect(await run(trusted, "openai-completions", tlsOrigin + "/success/v1")).toMatchObject({
    stopReason: "stop",
    text: "qualified",
  });
  expect(provider.requests).toHaveLength(prior + 1);
  expect(provider.requests[prior]?.headers.authorization).toBe("Bearer " + providerOnly);
  expect(JSON.stringify(config("openai-completions", tlsOrigin))).not.toContain(providerOnly);
});
it("rejects an untrusted certificate before auth reaches the endpoint", async () => {
  await expectRejectedBeforeRequest(untrusted, tlsOrigin + "/observe");
});
it("binds real built-in SDK requests to their endpoint without forwarding auth on redirects", async () => {
  for (const api of apis) {
    const prior = observed.length;
    await run(trusted, api, tlsOrigin + "/observe/" + api);
    expect(
      observed.length,
      api + " must reach the TLS fixture through its real SDK",
    ).toBeGreaterThan(prior);
    expect(observed.slice(prior).every(Boolean), api).toBe(true);
    const before = { sinkHits, forwardedSensitiveHeaders };
    await run(trusted, api, tlsOrigin + "/redirect/" + api);
    expect({ sinkHits, forwardedSensitiveHeaders }, api).toEqual(before);
  }
});
it("rejects even a same-origin redirect instead of replaying sensitive headers", async () => {
  const prior = sinkHits;
  await run(trusted, "openai-completions", tlsOrigin + "/same-origin/v1");
  expect(sinkHits).toBe(prior);
});

it("keeps hostname verification enabled with a trusted CA", async () => {
  await expectRejectedBeforeRequest(trusted, wrongNameOrigin + "/observe");
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
