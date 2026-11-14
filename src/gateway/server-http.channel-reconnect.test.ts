import { afterEach, expect, it, vi } from "vitest";
import { importBundledChannelContractSourceArtifact } from "../channels/plugins/contracts/test-helpers/runtime-artifacts.js";
import type { ChannelAccountSnapshot } from "../channels/plugins/types.public.js";
import { readHttp } from "./control-ui-fixture.test-support.js";
import { listenProvider } from "./gateway-provider-fixture.test-support.js";
import {
  createTestChannelManager,
  createTestChannelRegistry,
  createTestPlugin,
} from "./server-channels.test-support.js";
import { AUTH_NONE, withGatewayServer } from "./server-http.test-harness.js";
import { createReadinessChecker } from "./server/readiness.js";

type DiscordReadinessFixture = {
  snapshot: ChannelAccountSnapshot;
  lifecycle: Promise<void>;
  currentSocket: () => {
    sent: Array<{ op: number; d: unknown }>;
    emit: (event: string, ...args: unknown[]) => boolean;
    payload: (op: number, data: unknown, extra?: object) => void;
  };
  runtime: { log: (message: string) => void };
  stop: () => Promise<void>;
};
type XReadinessFixture = {
  status: () => ChannelAccountSnapshot;
  disconnect: () => void;
  failReconnects: () => void;
  stop: () => Promise<void>;
};
const { loadDiscordReadinessFixture } = await importBundledChannelContractSourceArtifact<{
  loadDiscordReadinessFixture: () => Promise<{
    createDiscordReadinessFixture: (options?: {
      abortSignal?: AbortSignal;
      statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void;
    }) => Promise<DiscordReadinessFixture>;
  }>;
}>("discord", "test-api.js", {});
const { loadXReadinessFixture } = await importBundledChannelContractSourceArtifact<{
  loadXReadinessFixture: () => Promise<{
    createXReadinessFixture: () => Promise<XReadinessFixture>;
  }>;
}>("x", "test-api.js", {});

afterEach(() => vi.useRealTimers());

type Probe = (status: number, body: object) => Promise<Record<string, unknown>>;
async function withChannelProbe(
  channelId: string,
  snapshot: () => ChannelAccountSnapshot,
  run: (probe: Probe) => Promise<void>,
) {
  const getReadiness = createReadinessChecker({
    startedAt: Date.now(),
    channelManager: {
      getRuntimeSnapshot: () => ({
        channels: { [channelId]: snapshot() },
        channelAccounts: { [channelId]: { default: snapshot() } },
      }),
      getAutostartSuppression: () => null,
      isAmbientAutostartSuppressed: () => false,
    },
  });
  await withGatewayServer({
    prefix: "channel-reconnect-readiness",
    resolvedAuth: AUTH_NONE,
    overrides: { getReadiness },
    run: async (server) => {
      const url = new URL("/readyz", await listenProvider(server)).href;
      try {
        await run(async (status, body) => {
          const response = await readHttp(url);
          expect(response.status).toBe(status);
          const result = JSON.parse(response.text) as Record<string, unknown>;
          expect(result).toMatchObject(body);
          return result;
        });
      } finally {
        server.closeAllConnections();
        await server[Symbol.asyncDispose]();
      }
    },
  });
}

it("keeps op-7 resume degraded-ready, bounds failed resumes, and rejects fatal authentication", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const { createDiscordReadinessFixture } = await loadDiscordReadinessFixture();
  const discord = await createDiscordReadinessFixture();
  // Exercise a settled Gateway, outside startup grace.
  vi.setSystemTime(Date.now() + 300_000);
  try {
    await withChannelProbe(
      "discord",
      () => discord.snapshot,
      async (probe) => {
        await probe(200, { ready: true });
        discord.currentSocket().payload(7, null);
        await vi.advanceTimersByTimeAsync(1_000);
        await probe(200, { ready: true, degraded: ["discord"], failing: [] });
        expect(discord.snapshot.lifecycle).toBe("recovering");
        expect(discord.runtime.log).toHaveBeenCalledWith(
          expect.stringContaining("reconnect-opcode"),
        );
        await vi.advanceTimersByTimeAsync(1_000);
        const resumed = discord.currentSocket();
        resumed.emit("open");
        resumed.payload(10, { heartbeat_interval: 45_000 });
        expect(resumed.sent).toContainEqual({
          op: 6,
          d: { token: "test-token", session_id: "fixture-session", seq: 1 },
        });
        resumed.payload(0, {}, { t: "RESUMED", s: 2 });
        await vi.advanceTimersByTimeAsync(1_000);
        expect((await probe(200, { ready: true, failing: [] })).degraded).toBeUndefined();
        expect(discord.snapshot.lastDisconnect).toBeNull();

        resumed.payload(7, null);
        const disconnectedAt = Date.now();
        for (let attempt = 0; attempt < 4; attempt++) {
          await vi.advanceTimersByTimeAsync(30_000);
          discord.currentSocket().emit("close", 1006);
        }
        expect(discord.snapshot.lastDisconnect).toMatchObject({ at: disconnectedAt });
        await probe(503, { ready: false, coreReady: true, failing: ["discord"] });

        // Even a fresh reconnect window must not hide an upstream auth refusal.
        await vi.advanceTimersByTimeAsync(30_000);
        discord.currentSocket().emit("open");
        discord.currentSocket().payload(
          0,
          {
            user: { id: "123" },
            session_id: "recovered-session",
            resume_gateway_url: "wss://gateway.example.test",
          },
          { t: "READY", s: 3 },
        );
        await vi.advanceTimersByTimeAsync(1_000);
        await probe(200, { ready: true });
        discord.currentSocket().emit("close", 4004);
        await vi.advanceTimersByTimeAsync(1_000);
        await probe(503, { ready: false, failing: ["discord"] });
      },
    );
  } finally {
    await discord.stop();
  }
});

it("keeps an X stream reconnect degraded-ready and fails a continuous outage after the bound", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const { createXReadinessFixture } = await loadXReadinessFixture();
  const x = await createXReadinessFixture();
  try {
    await withChannelProbe("x", x.status, async (probe) => {
      x.disconnect();
      await vi.advanceTimersByTimeAsync(0);
      await probe(200, { ready: true, degraded: ["x"], failing: [] });
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await probe(200, { ready: true, failing: [] })).degraded).toBeUndefined();
      x.failReconnects();
      x.disconnect();
      await vi.advanceTimersByTimeAsync(120_000);
      await probe(503, { ready: false, coreReady: true, failing: ["x"] });
    });
  } finally {
    await x.stop();
  }
});

it("restarts a malformed Discord payload through the channel manager without terminal readiness", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const { createDiscordReadinessFixture } = await loadDiscordReadinessFixture();
  const first = Promise.withResolvers<DiscordReadinessFixture>();
  const starts: DiscordReadinessFixture[] = [];
  const registry = createTestChannelRegistry(
    createTestPlugin({
      startAccount: async (ctx) => {
        const discord = await createDiscordReadinessFixture({
          abortSignal: ctx.abortSignal,
          statusSink: (patch) => ctx.setStatus({ ...ctx.getStatus(), ...patch }),
        });
        starts.push(discord);
        first.resolve(discord);
        try {
          await discord.lifecycle;
        } finally {
          await discord.stop();
        }
      },
    }),
  );
  const manager = createTestChannelManager({ getPluginRegistry: () => registry });
  const readiness = createReadinessChecker({ startedAt: Date.now(), channelManager: manager });
  try {
    await manager.startChannel("discord");
    const discord = await first.promise;
    await vi.advanceTimersByTimeAsync(0);
    discord.currentSocket().emit("message", "{malformed");
    await vi.advanceTimersByTimeAsync(0);
    const failed = manager.getRuntimeSnapshot().channelAccounts.discord?.default;
    expect(failed).toMatchObject({ running: false, restartPending: true });
    expect(failed?.terminalDisconnect).not.toBe(true);
    expect(failed?.lifecycle).not.toBe("blocked");
    expect(failed?.lastError).toContain("Invalid gateway payload");
    expect(readiness()).toMatchObject({ ready: true, failing: [] });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(starts).toHaveLength(2);
    expect(manager.getRuntimeSnapshot().channelAccounts.discord?.default).toMatchObject({
      running: true,
      connected: true,
      lifecycle: "ready",
      restartPending: false,
    });
    expect(readiness()).toMatchObject({ ready: true, failing: [] });
  } finally {
    await manager.stopChannel("discord");
  }
});
