import { afterEach, expect, it, vi } from "vitest";
import * as replyModule from "../auto-reply/reply/get-reply-from-config.runtime.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  heartbeatTestConfig,
  readSessionStoreForTest,
  seedSessionStore,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { resetSystemEventsForTest } from "./system-events.js";

vi.mock("./outbound/deliver.js", () => ({
  deliverOutboundPayloads: vi.fn().mockResolvedValue([]),
  deliverOutboundPayloadsInternal: vi.fn().mockResolvedValue([]),
}));
installHeartbeatRunnerTestRuntime();
afterEach(() => {
  vi.restoreAllMocks();
  resetSystemEventsForTest();
});

function withIsolatedHeartbeat(fn: (fixture: ReturnType<typeof createFixture>) => Promise<void>) {
  return withTempHeartbeatSandbox(async ({ tmpDir, storePath }) =>
    fn(createFixture(tmpDir, storePath)),
  );
}
function createFixture(tmpDir: string, storePath: string) {
  const cfg = heartbeatTestConfig(tmpDir, "whatsapp", "whatsapp", storePath);
  cfg.agents!.defaults!.heartbeat!.isolatedSession = true;
  const baseKey = resolveMainSessionKey(cfg);
  const isolatedKey = `${baseKey}:heartbeat`;
  const nowMs = Date.now();
  const replySpy = vi
    .spyOn(replyModule, "getReplyFromConfig")
    .mockResolvedValue({ text: "HEARTBEAT_OK" });
  const seed = (key: string, entry: Parameters<typeof seedSessionStore>[2] = {}) =>
    seedSessionStore(storePath, key, {
      lastChannel: "whatsapp",
      lastProvider: "whatsapp",
      lastTo: "+1555",
      ...entry,
    });
  const run = (options: Omit<Parameters<typeof runHeartbeatOnce>[0], "cfg" | "deps"> = {}) =>
    runHeartbeatOnce({
      cfg,
      ...options,
      deps: { getQueueSize: () => 0, nowMs: () => nowMs },
    });
  return { baseKey, isolatedKey, nowMs, replySpy, seed, run, storePath };
}

it("recovers an archived isolated session on the next heartbeat tick", async () => {
  await withIsolatedHeartbeat(
    async ({ baseKey, isolatedKey, nowMs, replySpy, seed, run, storePath }) => {
      await seed(isolatedKey, {
        sessionId: "archived-heartbeat-session-id",
        updatedAt: nowMs - 1000,
        archivedAt: nowMs - 500,
        heartbeatIsolatedBaseSessionKey: baseKey,
      });
      expect((await run({ agentId: "main", reason: "interval" })).status).toBe("ran");
      expect(replySpy).toHaveBeenCalledOnce();
      const entry = readSessionStoreForTest(storePath)[isolatedKey];
      expect(entry).toMatchObject({ heartbeatIsolatedBaseSessionKey: baseKey });
      expect(entry?.archivedAt).toBeUndefined();
      expect(entry?.sessionId).not.toBe("archived-heartbeat-session-id");
    },
  );
});

it("converges multiply accumulated suffixes without a stored base marker", async () => {
  await withIsolatedHeartbeat(async ({ baseKey, isolatedKey, replySpy, seed, run, storePath }) => {
    const legacyKey = `${baseKey}:heartbeat:heartbeat:heartbeat`;
    await seed(legacyKey);
    await run({ sessionKey: legacyKey });
    expect(replySpy).toHaveBeenCalledOnce();
    expect(replySpy.mock.calls[0]?.[0].SessionKey).toBe(isolatedKey);
    const store = readSessionStoreForTest(storePath);
    expect(store[legacyKey]).toBeUndefined();
    expect(store[isolatedKey]?.heartbeatIsolatedBaseSessionKey).toBe(baseKey);
  });
});

it("keeps a forced real :heartbeat session distinct from the heartbeat-isolated sibling", async () => {
  await withIsolatedHeartbeat(async ({ replySpy, seed, run }) => {
    const realKey = "agent:main:alerts:heartbeat";
    await seed(realKey);
    await run({ sessionKey: realKey });
    expect(replySpy).toHaveBeenCalledOnce();
    expect(replySpy.mock.calls[0]?.[0].SessionKey).toBe(`${realKey}:heartbeat`);
  });
});
