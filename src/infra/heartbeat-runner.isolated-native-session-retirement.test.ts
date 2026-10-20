import { afterEach, expect, it, vi } from "vitest";
import { registerAgentHarness } from "../agents/harness/registry.js";
import type { AgentHarnessResetParams } from "../agents/harness/types.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { bindHeartbeatReply } from "./heartbeat-runner.boundary-test-support.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  heartbeatTestConfig,
  readSessionStoreForTest,
  seedSessionStore,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";

// mock-isolation: exercise heartbeat ownership without real channel delivery.
vi.mock("./outbound/deliver.js", () => ({
  deliverOutboundPayloads: vi.fn().mockResolvedValue([]),
  deliverOutboundPayloadsInternal: vi.fn().mockResolvedValue([]),
}));
installHeartbeatRunnerTestRuntime();
afterEach(() => vi.restoreAllMocks());

it.each([
  { name: "isolated predecessor", isolatedSession: true, seedPredecessor: true, resets: 1 },
  { name: "first isolated run", isolatedSession: true, seedPredecessor: false, resets: 0 },
  { name: "ordinary heartbeat", isolatedSession: false, seedPredecessor: true, resets: 0 },
])(
  "resets native ownership appropriately for $name",
  async ({ isolatedSession, seedPredecessor, resets }) => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      bindHeartbeatReply(replySpy);
      const cfg = heartbeatTestConfig(tmpDir, "none", "whatsapp", storePath);
      cfg.agents!.defaults!.heartbeat!.isolatedSession = isolatedSession;
      const baseKey = resolveMainSessionKey(cfg);
      const isolatedKey = `${baseKey}:heartbeat`;
      await seedSessionStore(storePath, baseKey, { sessionId: "base-session" });
      if (seedPredecessor) {
        await seedSessionStore(storePath, isolatedKey, {
          sessionId: "isolated-predecessor",
          heartbeatIsolatedBaseSessionKey: baseKey,
        });
      }
      const resetCalls: Array<{ params: AgentHarnessResetParams; currentSessionId?: string }> = [];
      registerAgentHarness({
        id: "heartbeat-retirement",
        label: "Heartbeat retirement fixture",
        supports: () => ({ supported: false }),
        async runAttempt() {
          throw new Error("The heartbeat reply is injected");
        },
        async reset(params) {
          resetCalls.push({
            params,
            currentSessionId: readSessionStoreForTest(storePath)[isolatedKey]?.sessionId,
          });
        },
      });

      await expect(
        runHeartbeatOnce({
          cfg,
        }),
      ).resolves.toMatchObject({ status: "ran" });
      expect(replySpy).toHaveBeenCalledOnce();
      expect(resetCalls).toHaveLength(resets);
      const entries = readSessionStoreForTest(storePath);
      if (resets) {
        // The owner must retire the old native generation while it is still current.
        expect(resetCalls[0]).toEqual({
          params: {
            agentId: "main",
            sessionId: "isolated-predecessor",
            sessionKey: isolatedKey,
            sessionFile: isolatedKey,
            reason: "new",
          },
          currentSessionId: "isolated-predecessor",
        });
        expect(entries[isolatedKey]?.sessionId).not.toBe("isolated-predecessor");
        expect(entries[isolatedKey]?.previousSessionId).toBe("isolated-predecessor");
      } else if (!isolatedSession) {
        expect(entries[baseKey]?.sessionId).toBe("base-session");
      }
    });
  },
);
