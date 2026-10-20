// The real guard admits DNS answers before this Mac topology fixture maps the
// transport onto loopback. This proves HTTP behavior, not native Podman routing.
import type { LookupAddress } from "node:dns";
import { createServer } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createOllamaEmbeddingProvider } from "../extensions/ollama/runtime-api.js";
import { readResponseWithLimit } from "../src/infra/http-response-body.js";
import { withGuardedFetchRequestAuthority } from "../src/infra/net/fetch-request-authority.js";
import { acquireTestPortBlock } from "../src/test-utils/port-claims.js";
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
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString("utf8");
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
    config: {
      models: {
        providers: {
          ollama: { baseUrl: providerBase, models: [] },
        },
      },
    },
    model,
    ...(remoteBase ? { remote: { baseUrl: remoteBase } } : {}),
  });
}

describe("Ollama Podman host through the real SSRF and HTTP boundary", () => {
  let releasePort: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const claim = await acquireTestPortBlock({ offsets: [0] });
    releasePort = claim.release;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(claim.port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    fixture.transportBase = `http://127.0.0.1:${claim.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
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

  it.each([undefined, baseUrl])(
    "returns Podman vectors with remote override %s",
    async (remote) => {
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
    },
  );

  it.each([
    ["instance metadata", "169.254.169.254", 4],
    ["container credentials", "169.254.170.2", 4],
    ["container identity", "169.254.170.23", 4],
    ["platform metadata", "169.254.0.23", 4],
    ["Scaleway metadata", "169.254.42.42", 4],
    ["non-link-local metadata", "100.100.100.200", 4],
    ["IPv6 metadata", "fd00:ec2::254", 6],
    ["IPv4-mapped link-local", "::ffff:169.254.1.2", 6],
    ["NAT64 link-local", "64:ff9b::169.254.1.2", 6],
  ] as const)("rejects %s DNS before any HTTP attempt", async (_name, address, family) => {
    fixture.lookup = async () => [{ address, family }];
    const { provider } = await createProvider();
    await expect(provider.embed("hello")).rejects.toThrow("Blocked");
    expect(fixture.attempts).toEqual([]);
    expect(fixture.requests).toEqual([]);
  });

  it("rejects mixed Podman and metadata DNS answers before any HTTP attempt", async () => {
    fixture.lookup = async () => [
      { address: "169.254.1.2", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ];
    const { provider } = await createProvider();
    await expect(provider.embed("hello")).rejects.toThrow("Blocked");
    expect(fixture.attempts).toEqual([]);
    expect(fixture.requests).toEqual([]);
  });

  it.each([
    ["another configured provider hostname", "http://other.internal:11434", undefined],
    ["a separate Podman remote override", "http://other.internal:11434", baseUrl],
  ] as const)("does not extend link-local trust to %s", async (_name, providerBase, remoteBase) => {
    const { provider } = await createProvider(providerBase, remoteBase);
    await expect(provider.embed("hello")).rejects.toThrow("Blocked");
    expect(fixture.attempts).toEqual([]);
    expect(fixture.requests).toEqual([]);
  });

  it.each([
    "http://public.example:11434/api/embed",
    "http://host.containers.internal:11435/api/embed",
  ])(
    "rejects a public cross-origin redirect to %s when POST would become GET",
    async (location) => {
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
    },
  );

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
    expect(fixture.attempts).toEqual([]);
    expect(fixture.requests).toEqual([]);
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
});
