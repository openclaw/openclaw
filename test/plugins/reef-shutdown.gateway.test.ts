import { once } from "node:events";
import https from "node:https";
import { setImmediate as nextTurn } from "node:timers/promises";
import tls from "node:tls";
import { expect, it, vi } from "vitest";
import { reefPlugin, ReefTransportClient, type ReefKeys } from "../../extensions/reef/api.js";
import { setReefRuntime } from "../../extensions/reef/runtime-api.js";
import { createTestChannelManager } from "../../src/gateway/server-channels.test-support.js";
import {
  createGatewayCloseTestDepsFactory,
  createGatewayCloseTestHandlerFactory,
} from "../../src/gateway/server-close.test-support.js";
import { createPluginStateKeyedStoreV2ForTests } from "../../src/plugin-sdk/plugin-state-test-runtime.js";
import { createPluginRuntimeMock } from "../../src/plugin-sdk/plugin-test-runtime.js";
import { WebSocketServer } from "../../src/plugin-sdk/websocket-runtime.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry.js";
import { setActivePluginRegistry } from "../../src/plugins/runtime.js";
import {
  PROXY_FIXTURE_CERTIFICATE,
  PROXY_FIXTURE_KEY,
} from "../../src/test-helpers/proxy-tls-fixture.js";
import { createOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../../src/test-utils/port-claims.js";

const { mocks } = await vi.hoisted(
  () => import("../../src/gateway/server-close.mocks.test-support.js"),
);
const closeGateway = createGatewayCloseTestHandlerFactory(
  await import("../../src/gateway/server-close.js"),
);
const closeDeps = createGatewayCloseTestDepsFactory(mocks);

// Public synthetic identity; the loopback relay never authenticates or sends messages.
const keys: ReefKeys = {
  signing: {
    secretKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
    publicKey: "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg",
  },
  encryption: {
    secretKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  },
  auditKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  replayKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  keyEpoch: 1,
};

it("Gateway shutdown releases Reef TLS and timers when the relay withholds its close reply", async () => {
  const state = await createOpenClawTestState({ label: "reef-shutdown" });
  const runtime = createPluginRuntimeMock();
  runtime.state.openKeyedStoreV2 = (options, authority) =>
    createPluginStateKeyedStoreV2ForTests(
      "reef",
      { ...options, env: state.env },
      authority ?? { assertCurrent() {} },
    );
  const cas = tls.getCACertificates("default");
  const claim = await acquireTestPortBlock({ offsets: [0] });
  const server = https.createServer({ cert: PROXY_FIXTURE_CERTIFICATE, key: PROXY_FIXTURE_KEY });
  const relay = new WebSocketServer({ server });
  const registry = createEmptyPluginRegistry();
  registry.channels.push({ pluginId: "reef", source: "test", plugin: reefPlugin });
  const relayUrl = `https://127.0.0.1:${claim.port}`;
  const cfg = {
    channels: {
      reef: {
        enabled: true,
        handle: "alice",
        email: "alice@example.com",
        relayUrl,
        guard: {
          provider: "openai",
          pinnedModel: "mock-2026-07-12",
          apiKeyEnv: "REEF_TEST_KEY",
          policyVersion: "v1",
          timeoutMs: 1000,
        },
      },
    },
  };
  const manager = createTestChannelManager({
    channelIds: ["reef"],
    getRuntimeConfig: () => cfg,
    getPluginRegistry: () => registry,
  });
  try {
    tls.setDefaultCACertificates([...cas, PROXY_FIXTURE_CERTIFICATE]);
    server.listen(claim.port, "127.0.0.1");
    await once(server, "listening");
    server.unref();
    // Exclude fixture-owned handles from the census. The real client remains
    // referenced; the relay deliberately never reads its close frame.
    server.on("connection", (socket) => socket.unref());
    relay.on("connection", (socket) => socket.pause());
    await runtime.state
      .openKeyedStoreV2<ReefKeys>({
        namespace: "identity",
        maxEntries: 1,
        overflowPolicy: "reject-new",
      })
      .register("keys", keys);
    await runtime.state
      .openKeyedStoreV2({ namespace: "registration", maxEntries: 2, overflowPolicy: "reject-new" })
      .register("identity", { handle: "alice", relayUrl });
    setReefRuntime(runtime);
    setActivePluginRegistry(registry);
    vi.stubEnv("REEF_TEST_KEY", "test-only-credential");
    // Fixed REST responses isolate the inbox from the shared HTTP connection pool.
    vi.spyOn(ReefTransportClient.prototype, "listFriends").mockResolvedValue({ friendships: [] });
    vi.spyOn(ReefTransportClient.prototype, "pull").mockResolvedValue({ entries: [], cursor: 0 });
    const connect = vi.spyOn(tls, "connect");
    const resources = () =>
      process
        .getActiveResourcesInfo()
        .filter((name) => /^(TCP|TLS)|^Timeout$/.test(name))
        .toSorted();
    const before = resources();
    expect((await manager.startChannel("reef")).get("default")).toEqual({ status: "handed-off" });
    await vi.waitFor(
      () => {
        expect(manager.getRuntimeSnapshot().channelAccounts.reef?.default).toMatchObject({
          connected: true,
        });
      },
      { timeout: 5000 },
    );
    const clientSocket = connect.mock.results[0]?.value;
    expect(clientSocket?.encrypted).toBe(true);
    expect(clientSocket?.destroyed).toBe(false);
    await closeGateway(closeDeps({ channelIds: ["reef"], stopChannel: manager.stopChannel }))({
      reason: "Reef shutdown regression",
    });
    // Node removes destroyed handles after the close callbacks have run.
    await nextTurn();
    expect.soft(clientSocket?.destroyed).toBe(true);
    expect(resources()).toEqual(before);
  } finally {
    for (const socket of relay.clients) {
      socket.terminate();
    }
    await manager.stopChannel("reef");
    await new Promise<void>((resolve) => {
      relay.close(() => resolve());
    });
    await server[Symbol.asyncDispose]();
    tls.setDefaultCACertificates(cas);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await state.cleanup();
    await claim.release();
  }
});
