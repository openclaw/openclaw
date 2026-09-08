// Keep the provider/auth fixture setup before imports that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "../prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkContinuation,
} from "../../process/gateway-work-admission.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  getPreparedModelRuntimeBorrowedSnapshot,
  getPreparedModelRuntimePluginGeneration,
  withPreparedModelRuntimePluginGenerationScope,
} from "../prepared-model-runtime-generation-scope.js";
import {
  acquireAgentRunPreparedModelRuntime,
  loadPublishedGatewayReplyDispatchRuntime,
  refreshPreparedModelRuntimeSnapshots,
} from "../prepared-model-runtime.js";
import { testing } from "./agent-step.test-support.js";
import { resolveAnnounceTarget } from "./sessions-announce-target.js";
import { runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";

vi.mock("./sessions-announce-target.js", () => ({ resolveAnnounceTarget: vi.fn() }));

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

// The real peer flow and direct agent-step route reach the real prepared lease
// guard. Only provider/auth preparation, target discovery and inference are fake.
describe("detached peer announce prepared generation", () => {
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "peer-announce-generation" });
    await resetPreparedModelRuntimeHarness(state);
    resetGatewayWorkAdmission();
  });
  afterEach(async () => {
    testing.setDepsForTest();
    vi.clearAllMocks();
    resetGatewayWorkAdmission();
    await cleanupPreparedModelRuntimeHarness(state, false);
  });

  it.each([
    { releaseParent: false, reload: false },
    { releaseParent: false, reload: true },
    { releaseParent: true, reload: false },
    { releaseParent: true, reload: true },
  ])(
    "re-admits target (releaseParent=$releaseParent, reload=$reload)",
    async ({ releaseParent, reload }) => {
      mocks.configuredAgentIds = ["sender", "target"];
      mocks.configuredWorkspaces.set("sender", state.agentDir("sender"));
      mocks.configuredWorkspaces.set("target", state.agentDir("target"));
      const config = { messages: { responsePrefix: "before" } };
      const publication = { gatewayLifecycle: true, catalogMode: "static" as const };
      await refreshPreparedModelRuntimeSnapshots(config, publication);
      const admitted = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "sender" });
      expect(admitted).toBeDefined();
      const input = (agentId: string) => ({
        config,
        agentId,
        agentDir: state.agentDir(agentId),
        workspaceDir: state.agentDir(agentId),
      });
      const parent = await acquireAgentRunPreparedModelRuntime(input("sender"), {
        pluginGeneration: admitted!.pluginGeneration,
      });
      let parentOpen = true;
      const entered = createDeferred();
      const proceed = createDeferred();
      vi.mocked(resolveAnnounceTarget).mockImplementation(async () => {
        entered.resolve();
        await proceed.promise;
        return null;
      });
      const errors: string[] = [];
      const acceptedOwners: string[] = [];
      testing.setDepsForTest({
        agentCommandFromIngress: async (opts) => {
          expect(opts.agentId).toBe("target");
          expect(opts.transcriptMessage).toBe("");
          expect(opts.deliver).toBe(false);
          expect(opts.allowModelOverride).toBe(false);
          expect(getActiveGatewayRootWorkCount()).toBe(1);
          try {
            // Same ambient-generation acquisition as the embedded run orchestrator;
            // no model, gateway, credentials or plugin process is invoked.
            const lease = await acquireAgentRunPreparedModelRuntime(input("target"), {
              pluginGeneration: getPreparedModelRuntimePluginGeneration(),
            });
            expect(lease.snapshot.config.messages?.responsePrefix).toBe(
              reload ? "after" : "before",
            );
            const currentTarget = await loadPublishedGatewayReplyDispatchRuntime({
              agentId: "target",
            });
            expect(lease.pluginGeneration).toBe(currentTarget?.pluginGeneration);
            acceptedOwners.push(lease.snapshot.agentId!);
            lease.release();
            return {
              payloads: [{ text: "ANNOUNCE_SKIP", mediaUrl: null }],
              meta: { durationMs: 0 },
            };
          } catch (error) {
            errors.push(String(error));
            throw error;
          }
        },
      });
      const flow = withPreparedModelRuntimePluginGenerationScope(
        admitted!.pluginGeneration,
        async () => {
          const detached = runWithGatewayIndependentRootWorkContinuation(
            () =>
              runSessionsSendA2AFlow({
                targetSessionKey: "agent:target:main",
                targetAgentId: "target",
                requesterSessionKey: "agent:sender:main",
                requesterAgentId: "sender",
                displayKey: "agent:target:main",
                message: "Return evidence once",
                roundOneReply: "Evidence already returned",
                announceTimeoutMs: 1000,
                maxPingPongTurns: 0,
                callGateway: async () => {
                  throw new Error("No gateway calls permitted");
                },
              }),
            "session:a2a-send",
          );
          expect(getPreparedModelRuntimePluginGeneration()).toBe(admitted!.pluginGeneration);
          expect(getPreparedModelRuntimeBorrowedSnapshot(admitted!.pluginGeneration)).toBe(
            parent.snapshot,
          );
          await detached;
          expect(getPreparedModelRuntimePluginGeneration()).toBe(admitted!.pluginGeneration);
          expect(getPreparedModelRuntimeBorrowedSnapshot(admitted!.pluginGeneration)).toBe(
            parentOpen ? parent.snapshot : undefined,
          );
        },
        () => (parentOpen ? parent.snapshot : undefined),
      );
      await entered.promise;
      if (releaseParent) {
        parentOpen = false;
        parent.release();
      }
      if (reload) {
        await refreshPreparedModelRuntimeSnapshots(
          { messages: { responsePrefix: "after" } },
          publication,
        );
      }
      proceed.resolve();
      await flow;
      if (parentOpen) {
        parentOpen = false;
        parent.release();
      }
      expect(getPreparedModelRuntimePluginGeneration()).toBeUndefined();
      expect(errors).toEqual([]);
      expect(acceptedOwners).toEqual(["target"]);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      // Clearing detached scope must not weaken explicitly owned stale admissions.
      await expect(
        acquireAgentRunPreparedModelRuntime(input("target"), {
          pluginGeneration: admitted!.pluginGeneration,
        }),
      ).rejects.toThrow("plugin generation was superseded");
    },
  );
});
