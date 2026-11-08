// Gateway provider requests use the shared family budget. The stall is scheduled
// from the request's pre-connect authority so it overlaps Node's attempt timer
// the way a loaded event loop does. A fake timer cannot reproduce that race.
import type { LookupAddress } from "node:dns";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { attachModelProviderRequestTransport } from "../../agents/provider-request-config.js";
import { closeProviderTransportDispatcherPool } from "../../agents/provider-transport-dispatcher-pool.js";
import { buildGuardedModelFetch } from "../../agents/provider-transport-fetch.js";
import type { Model } from "../../llm/types.js";
import { attachProviderAuthAuthority } from "../../plugins/provider-auth-authority.js";
import { isWSL2Sync } from "../wsl.js";

const HOSTNAME = "fixture.test";
const STALL_MS = 700;

const dnsFixture = vi.hoisted(() => ({
  answers: [] as LookupAddress[],
}));

vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return {
    ...actual,
    lookup(hostname: string, options?: unknown) {
      if (hostname === HOSTNAME) {
        return Promise.resolve(dnsFixture.answers);
      }
      return actual.lookup(hostname, options as never);
    },
  };
});

function blockEventLoop(durationMs: number): void {
  const end = performance.now() + durationMs;
  while (performance.now() < end) {
    // The handshake can finish in the kernel while this thread cannot observe it.
  }
}

function scheduleConnectStall(durationMs: number): void {
  process.nextTick(() => {
    process.nextTick(() => blockEventLoop(durationMs));
  });
}

async function withListener(
  host: "127.0.0.1" | "::1",
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server = http.createServer((_request, response) => {
    response.end("ok");
  });
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, host, () => resolve());
  });
  const address = server.address() as AddressInfo | null;
  if (!address) {
    throw new Error("missing server address");
  }
  try {
    await run(address.port);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      for (const socket of sockets) {
        socket.destroy();
      }
    });
  }
}

async function providerStatus(
  port: number,
  stallMs: number,
): Promise<{
  status: number;
  elapsedMs: number;
}> {
  let authorityCalls = 0;
  const baseUrl = `http://${HOSTNAME}:${port}/v1`;
  const model = attachProviderAuthAuthority(
    attachModelProviderRequestTransport(
      {
        id: "family-attempt",
        name: "family-attempt",
        provider: "family-attempt-fixture",
        api: "openai-responses",
        baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1024,
        maxTokens: 16,
      } as Model<"openai-responses">,
      { allowPrivateNetwork: true },
    ),
    () => {
      authorityCalls += 1;
      // The first call is before DNS. The pre-connect call overlaps the attempt timer.
      if (authorityCalls === 2 && stallMs > 0) {
        scheduleConnectStall(stallMs);
      }
    },
  );
  const started = performance.now();
  const response = await buildGuardedModelFetch(model)(`${baseUrl}/models`);
  const body = await response.text();
  if (body !== "ok") {
    throw new Error(`unexpected provider body: ${body}`);
  }
  return { status: response.status, elapsedMs: Math.round(performance.now() - started) };
}

afterEach(async () => {
  dnsFixture.answers = [];
  await closeProviderTransportDispatcherPool();
  vi.unstubAllEnvs();
});

function pinProviderDns(addresses: LookupAddress[]): void {
  vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "0");
  vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "0");
  vi.stubEnv("http_proxy", "");
  vi.stubEnv("https_proxy", "");
  dnsFixture.answers = addresses;
}

it.skipIf(isWSL2Sync())(
  "keeps a Gateway provider request when the event loop stalls for 700 ms",
  async () => {
    pinProviderDns([
      { address: "127.0.0.1", family: 4 },
      { address: "::1", family: 6 },
    ]);
    await withListener("127.0.0.1", async (port) => {
      const result = await providerStatus(port, STALL_MS);
      expect(result.status).toBe(200);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(STALL_MS);
      expect(result.elapsedMs).toBeLessThan(3_000);
    });
  },
);

it.skipIf(isWSL2Sync())("falls back to IPv6 when the IPv4 address does not answer", async () => {
  pinProviderDns([
    { address: "192.0.2.1", family: 4 },
    { address: "::1", family: 6 },
  ]);
  await withListener("::1", async (port) => {
    const result = await providerStatus(port, 0);
    expect(result.status).toBe(200);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(800);
    expect(result.elapsedMs).toBeLessThan(2_000);
  });
});
