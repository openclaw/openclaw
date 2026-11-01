// The real guard admits DNS answers before this Mac topology fixture maps the
// transport onto loopback. This proves HTTP behavior, not native Podman routing.
import type { LookupAddress } from "node:dns";
import { once } from "node:events";
import { createServer } from "node:http";
import { text } from "node:stream/consumers";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createOllamaEmbeddingProvider } from "../extensions/ollama/runtime-api.js";
import { readResponseWithLimit } from "../src/infra/http-response-body.js";
import { withGuardedFetchRequestAuthority } from "../src/infra/net/fetch-request-authority.js";
import { acquireTestPortBlock } from "../src/test-utils/port-claims.js";
import { closeHttpServer } from "./helpers/gateway-integration-fixtures.js";
import { createDeferred } from "./helpers/promise.js";

const fixture = vi.hoisted(() => ({
  lookup: async (_hostname: string): Promise<LookupAddress[]> => [
    { address: "169.254.1.2", family: 4 },
  ],
  transportBase: "",
  attempts: [] as string[],
  requests: [] as Array<{ method: string | undefined; path: string | undefined; body: string }>,
  response: "vector" as "vector" | "redirect" | "live",
  redirectLocation: "",
}));

vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns/promises")>()),
  lookup: (hostname: string) => fixture.lookup(hostname),
}));

vi.mock("../src/infra/net/runtime-fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/infra/net/runtime-fetch.js")>();
  return {
    ...actual,
    fetchWithRuntimeDispatcher: async (
      input: RequestInfo | URL,
      init?: Parameters<typeof actual.fetchWithRuntimeDispatcher>[1],
    ) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      fixture.attempts.push(url.toString());
      // DNS policy and final authority run before replacing the unavailable
      // Podman route with a real HTTP connection on this Mac.
      const { dispatcher: _dispatcher, ...requestInit } = init ?? {};
      return await fetch(`${fixture.transportBase}${url.pathname}${url.search}`, requestInit);
    },
  };
});

const baseUrl = "http://host.containers.internal:11434";
const embedUrl = `${baseUrl}/api/embed`;
const server = createServer((request, response) => {
  void (async () => {
    const body = await text(request);
    fixture.requests.push({ method: request.method, path: request.url, body });
    if (fixture.response === "redirect" && fixture.requests.length === 1) {
      response.writeHead(302, { location: fixture.redirectLocation });
      response.end();
    } else if (fixture.response === "live") {
      const upstream = await fetch("http://127.0.0.1:11434/api/embed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      response.writeHead(upstream.status, { "Content-Type": "application/json" });
      response.end(await readResponseWithLimit(upstream, 1024 * 1024));
    } else {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ embeddings: [[3, 4]] }));
    }
  })().catch((error: unknown) => {
    response.writeHead(500);
    response.end(String(error));
  });
});

async function createProvider(
  providerBase = baseUrl,
  remoteBase?: string,
  model = "test-embedding",
) {
  return await createOllamaEmbeddingProvider({
    config: { models: { providers: { ollama: { baseUrl: providerBase, models: [] } } } },
    model,
    ...(remoteBase ? { remote: { baseUrl: remoteBase } } : {}),
  });
}

let releasePort: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const claim = await acquireTestPortBlock({ offsets: [0] });
  releasePort = claim.release;
  server.listen(claim.port, "127.0.0.1");
  await once(server, "listening");
  fixture.transportBase = `http://127.0.0.1:${claim.port}`;
});

afterAll(async () => {
  await closeHttpServer(server);
  await releasePort?.();
});

beforeEach(() => {
  vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "");
  vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "");
  fixture.lookup = async () => [{ address: "169.254.1.2", family: 4 }];
  fixture.attempts = [];
  fixture.requests = [];
  fixture.response = "vector";
});

afterEach(() => vi.unstubAllEnvs());

it.each([undefined, baseUrl])("returns Podman vectors with remote override %s", async (remote) => {
  const { provider } = await createProvider(baseUrl, remote);
  await expect(provider.embed("hello")).resolves.toEqual([0.6, 0.8]);
  expect(fixture.attempts).toEqual([embedUrl]);
  expect(fixture.requests).toEqual([
    {
      method: "POST",
      path: "/api/embed",
      body: '{"model":"test-embedding","input":["hello"]}',
    },
  ]);
});

it.each<[string, string[], string?, string?]>([
  ["instance metadata", ["169.254.169.254"]],
  ["container credentials", ["169.254.170.2"]],
  ["container identity", ["169.254.170.23"]],
  ["platform metadata", ["169.254.0.23"]],
  ["Scaleway metadata", ["169.254.42.42"]],
  ["non-link-local metadata", ["100.100.100.200"]],
  ["IPv6 metadata", ["fd00:ec2::254"]],
  ["IPv4-mapped link-local", ["::ffff:169.254.1.2"]],
  ["NAT64 link-local", ["64:ff9b::169.254.1.2"]],
  ["mixed Podman and metadata DNS", ["169.254.1.2", "169.254.169.254"]],
  ["another provider hostname", ["169.254.1.2"], "http://other.internal:11434"],
  ["a separate remote override", ["169.254.1.2"], "http://other.internal:11434", baseUrl],
])("rejects %s before any HTTP attempt", async (_name, addresses, providerBase, remoteBase) => {
  fixture.lookup = async () =>
    addresses.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));
  const { provider } = await createProvider(providerBase, remoteBase);
  await expect(provider.embed("hello")).rejects.toThrow("Blocked");
  expect(fixture).toMatchObject({ attempts: [], requests: [] });
});

it.each([
  "http://public.example:11434/api/embed",
  "http://host.containers.internal:11435/api/embed",
])("rejects a public cross-origin redirect to %s when POST would become GET", async (location) => {
  fixture.response = "redirect";
  fixture.redirectLocation = location;
  let lookups = 0;
  fixture.lookup = async () => [
    { address: lookups++ === 0 ? "169.254.1.2" : "93.184.216.34", family: 4 },
  ];
  const { provider } = await createProvider();
  await expect(provider.embed("hello")).rejects.toThrow("cross-origin redirect");
  expect(fixture.attempts).toEqual([embedUrl]);
  expect(fixture.requests).toHaveLength(1);
});

it("rejects authority closed while DNS is pending before any HTTP attempt", async () => {
  const lookupStarted = createDeferred();
  const resolved = createDeferred<LookupAddress[]>();
  fixture.lookup = async () => {
    lookupStarted.resolve();
    return await resolved.promise;
  };
  const { provider } = await createProvider();
  let pending: Promise<number[]> | undefined;
  await withGuardedFetchRequestAuthority(
    () => {},
    async () => {
      pending = provider.embed("hello");
      await lookupStarted.promise;
    },
  );
  resolved.resolve([{ address: "169.254.1.2", family: 4 }]);
  await expect(pending).rejects.toThrow("no longer active");
  expect(fixture).toMatchObject({ attempts: [], requests: [] });
});

it.skipIf(process.env.LIVE_OLLAMA_PODMAN_PROOF !== "1")(
  "forwards an admitted Podman request to the real local bge-m3 model",
  async () => {
    fixture.response = "live";
    const { provider } = await createProvider(baseUrl, undefined, "bge-m3");
    const vector = await provider.embed("Ollama Podman embedding boundary proof");
    expect(vector).toHaveLength(1024);
    expect(vector.every(Number.isFinite)).toBe(true);
    expect(vector.reduce((sum, value) => sum + value * value, 0)).toBeCloseTo(1, 5);
    expect(fixture.attempts).toEqual([embedUrl]);
    expect(fixture.requests).toHaveLength(1);
  },
);
