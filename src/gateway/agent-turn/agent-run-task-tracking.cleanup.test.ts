import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  SessionFollowupCompletion,
  withFollowupRequest,
} from "../../agents/subagents/completion/session-followup-completion.js";
import { rotateAgentRunRegistryLifecycleGeneration } from "../../infra/agent-run-registry.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../../plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import { getTaskById } from "../../tasks/task-registry.js";
import { getTaskRegistryStore } from "../../tasks/task-registry.store.js";
import { loadTaskRegistryStateFromSqliteReadOnly } from "../../tasks/task-registry.store.sqlite.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { dispatchAgentRunFromGateway } from "./agent-run-dispatch.js";
import { createTrackedDispatch } from "./agent-run-dispatch.test-support.js";
import {
  registerSessionFollowupTask,
  settleUnstartedGatewayAgentTask,
} from "./agent-run-task-tracking.js";

const provider = vi.hoisted(() => ({
  execute: vi.fn<typeof import("../../commands/agent.js").agentCommandFromGatewayIngress>(),
}));
vi.mock("../../commands/agent.js", () => ({ agentCommandFromGatewayIngress: provider.execute }));

afterEach(async () => {
  vi.restoreAllMocks();
  provider.execute.mockReset();
  await closeOpenClawStateDatabaseAsync();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
});

async function createFollowupFixture() {
  const fixture = createTrackedDispatch();
  const { runId, sessionKey, context, entry } = fixture;
  const authority = new AbortController();
  const requester = { authorized: true };
  const requesterSessionKey = "agent:main:cleanup-requester";
  const tracking = await withFollowupRequest(
    {
      runId,
      requesterSessionKey,
      requesterSessionId: "cleanup-requester",
      requesterAgentId: "main",
      targetAgentId: "main",
      targetSessionKey: sessionKey,
      custody: {
        run: (work) => work(),
        signal: authority.signal,
        assertCurrent: () => {
          authority.signal.throwIfAborted();
          if (!requester.authorized) {
            throw new Error("Requester custody revoked");
          }
        },
        release: () => {},
      },
    },
    () =>
      registerSessionFollowupTask({
        followup: { kind: "session_followup", requesterSessionKey },
        runId,
        sessionKey,
        task: "Retain the original followup receipt",
        requesterOrigin: undefined,
        assertCurrent: () => {
          expect(context.chatAbortControllers.get(runId)).toBe(entry);
        },
      }),
  );
  if (tracking.kind !== "receipt" || !tracking.completion) {
    throw new Error("Expected a real followup completion receipt");
  }
  return {
    ...fixture,
    authority,
    requester,
    tracking,
    completion: tracking.completion,
    task: tracking.task,
  };
}

it.each(["current", "replaced before commit", "revoked before cleanup"] as const)(
  "settles only the original unstarted followup receipt (%s)",
  async (admission) => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const { runId, context, entry, authority, tracking, completion, task } =
        await createFollowupFixture();
      const original = loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId);
      expect(original?.status).toBe("running");
      const entered = createDeferred();
      const release = createDeferred();
      const store = getTaskRegistryStore();
      const mutate = store.runInitialMutationAsync.bind(store);
      vi.spyOn(store, "runInitialMutationAsync").mockImplementation(async (...args) => {
        if (args[1].type === "tasks.finalizeActive") {
          entered.resolve();
          await release.promise;
        }
        return mutate(...args);
      });
      if (admission === "revoked before cleanup") {
        authority.abort(new Error("Requester revoked before acceptance"));
      }
      const cleanup = settleUnstartedGatewayAgentTask({
        tracking,
        runId,
        admittedRunEntry: entry,
        context,
        outcome: { status: "error", reason: "failed", error: "Rejected before execution" },
      });
      const replacement = { ...entry, controller: new AbortController() };
      try {
        if (admission !== "revoked before cleanup") {
          await Promise.race([
            entered.promise,
            cleanup.then(() => {
              throw new Error("Cleanup did not reach the terminal worker boundary");
            }),
          ]);
          expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)).toEqual(
            original,
          );
          if (admission === "replaced before commit") {
            context.chatAbortControllers.set(runId, replacement);
          }
        }
        release.resolve();
        await cleanup;
        const stored = loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId);
        expect(getTaskById(task.taskId)).toEqual(stored);
        if (admission === "replaced before commit") {
          expect(stored).toEqual(original);
          expect(context.chatAbortControllers.get(runId)).toBe(replacement);
          expect(context.logGateway.warn).toHaveBeenCalledWith(
            expect.stringContaining("Follow-up admission was replaced before cleanup"),
          );
        } else {
          expect(stored).toMatchObject({ status: "failed", error: "Rejected before execution" });
          expect(context.logGateway.warn).not.toHaveBeenCalled();
        }
      } finally {
        release.resolve();
        await cleanup;
        completion.close();
      }
    });
  },
);

it.each([
  "current",
  "requester revoked before commit",
  "requester revoked after commit",
  "completion owner replaced",
  "lifecycle replaced",
  "physical instance replaced",
] as const)("retains normal followup terminal authority (%s)", async (change) => {
  await withOpenClawTestState({ layout: "state-only" }, async () => {
    const registry = createEmptyPluginRegistry();
    markPluginRegistryActive(registry);
    try {
      await withPluginRuntimeRegistryScope(registry, async () => {
        const {
          runId,
          sessionKey,
          context,
          entry,
          authority,
          requester,
          tracking,
          completion,
          task,
        } = await createFollowupFixture();
        completion.markAccepted(runId);
        provider.execute.mockImplementation(async (options) => {
          await options.onExecutionStarted?.();
          return { payloads: [], meta: { durationMs: 1 } };
        });
        const entered = createDeferred();
        const release = createDeferred();
        const store = getTaskRegistryStore();
        const mutate = store.runInitialMutationAsync.bind(store);
        vi.spyOn(store, "runInitialMutationAsync").mockImplementation(async (...args) => {
          if (args[1].type !== "tasks.finalizeActive") {
            return mutate(...args);
          }
          entered.resolve();
          await release.promise;
          const result = await mutate(...args);
          if (change === "requester revoked after commit") {
            requester.authorized = false;
          }
          return result;
        });
        const assertPhysicalCurrent = () => {
          expect(context.chatAbortControllers.get(runId)).toBe(entry);
        };
        const execution = dispatchAgentRunFromGateway({
          ingressOpts: { message: "Complete the followup", sessionKey, allowModelOverride: false },
          runId,
          dedupeKeys: [`agent:${runId}`],
          admittedRunEntry: entry,
          abortController: entry.controller,
          assertCurrent: assertPhysicalCurrent,
          assertSettlementCurrent: assertPhysicalCurrent,
          cleanupAbortController() {
            if (context.chatAbortControllers.get(runId) === entry) {
              context.chatAbortControllers.delete(runId);
            }
          },
          io: { emitAcceptance: vi.fn(), emitFinal: vi.fn() },
          context,
          taskTrackingMode: tracking,
        });
        let replacement: SessionFollowupCompletion | undefined;
        try {
          await Promise.race([
            entered.promise,
            execution.then(() => {
              throw new Error("Normal completion skipped its worker write");
            }),
          ]);
          expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)?.status).toBe(
            "running",
          );
          if (change === "requester revoked before commit") {
            requester.authorized = false;
          } else if (change === "completion owner replaced") {
            replacement = SessionFollowupCompletion.bind(completion.request);
          } else if (change === "lifecycle replaced") {
            rotateAgentRunRegistryLifecycleGeneration();
          } else if (change === "physical instance replaced") {
            entry.operationalRunInstance = { runId, instanceId: "replacement-instance" };
          }
          expect(authority.signal.aborted).toBe(false);
          expect(completion.signal.aborted).toBe(false);
          release.resolve();
          await execution;
          expect(provider.execute).toHaveBeenCalledOnce();
          const stored = loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId);
          const committed = change === "current" || change === "requester revoked after commit";
          expect(stored?.status).toBe(committed ? "succeeded" : "running");
          expect(getTaskById(task.taskId)).toEqual(stored);
          expect(completion.signal.aborted).toBe(change !== "current");
          replacement?.assertCurrent();
          if (change === "current") {
            await expect(completion.take()).resolves.toMatchObject({ status: "ok" });
          }
        } finally {
          release.resolve();
          await execution;
          replacement?.close();
          completion.close();
        }
      });
    } finally {
      markPluginRegistryRetired(registry);
    }
  });
});
