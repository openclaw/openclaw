import type { AcpRuntime, AcpRuntimeEvent } from "@openclaw/acp-core/runtime/types";
import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  getAcpSessionManager,
  testing as managerTesting,
} from "../../acp/control-plane/manager.js";
import { disposeAcpSessionManagerInstance } from "../../acp/control-plane/manager.lifecycle.js";
import {
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "../../acp/runtime/registry.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createGatewaySession } from "../../gateway/session-create-service.js";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import {
  createRunningTaskRun,
  getDetachedTaskLifecycleRuntime,
} from "../../tasks/detached-task-runtime.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  setDetachedTaskLifecycleRuntime,
} from "../../tasks/detached-task-runtime.test-support.js";
import { readTaskBackingInstance } from "../../tasks/task-backing-records.js";
import { getTaskFlowById } from "../../tasks/task-flow-registry.js";
import { configureTaskFlowRegistryRuntime } from "../../tasks/task-flow-registry.store.test-support.js";
import { resetTaskFlowRegistryForTests } from "../../tasks/task-flow-registry.test-support.js";
import { getTaskById, listTasksForRelatedSessionKey } from "../../tasks/task-registry.js";
import { resetTaskRegistryForTests } from "../../tasks/task-registry.test-support.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { installInMemoryTaskRegistryRuntime } from "../../test-utils/task-registry-runtime.js";
import { createInMemoryTaskFlowRegistryStore } from "../../test-utils/task-registry-store.js";
import {
  prepareSystemAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../admitted-run-context.js";
import { refreshPreparedModelRuntimeSnapshots } from "../prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../prepared-model-runtime.test-support.js";
import { resetSubagentRegistryForTests } from "../subagents/registry/subagent-registry.test-helpers.js";
import { createSubagentsTool } from "./subagents-tool.js";

const ownerA = "agent:main:telegram:direct:former-owner";
const ownerB = "agent:main:main";
const ancestorKey = "agent:main:acp:ancestor";
const descendantKey = "agent:main:acp:descendant";
const backendId = "subagents-cancellation-fixture";

type RunningAcpTask = {
  task: TaskRecord;
  instanceId: string;
  signal: AbortSignal;
  finish: () => void;
  settled: Promise<void>;
};

type PendingAcpTurn = {
  instanceId: string;
  events: AcpRuntimeEvent[];
  settled: Promise<void>;
  cancel: () => Promise<void>;
  waitForRuntime: () => Promise<RunningAcpTask>;
};

type AcpTreeFixture = {
  tool: ReturnType<typeof createSubagentsTool>;
  ancestor: RunningAcpTask;
  descendant: RunningAcpTask;
  cancelledSessions: string[];
  adoptAncestor: () => Promise<void>;
  queueAncestorTurn: (runId: string) => Promise<PendingAcpTurn>;
  queueDescendantSuccessor: () => Promise<PendingAcpTurn>;
  pauseBackendCancellation: () => { entered: Promise<void>; release: () => void };
};

async function withAcpTree(
  spawnedByOwner: boolean,
  run: (fixture: AcpTreeFixture) => Promise<void>,
  beforeTurns?: () => void,
) {
  await withOpenClawTestState({ label: "subagents-acp-cancellation" }, async (state) => {
    const cfg = {
      agents: {
        ownership: "explicit",
        defaults: { workspace: state.workspaceDir, model: { primary: "custom/test-model" } },
        entries: { main: { workspace: state.workspaceDir } },
      },
      models: {
        mode: "replace",
        providers: {
          custom: {
            api: "openai-completions",
            baseUrl: "https://example.invalid/v1",
            models: [
              {
                id: "test-model",
                name: "Synthetic model",
                reasoning: false,
                input: ["text"],
                maxTokens: 1024,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
      plugins: { enabled: false, allow: [] },
      session: { store: state.statePath("agents", "{agentId}", "sessions", "sessions.json") },
      acp: { enabled: true, backend: backendId, dispatch: { enabled: true } },
    } satisfies OpenClawConfig;
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    resetAgentEventsForTest();
    resetSubagentRegistryForTests({ persist: false });
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    resetDetachedTaskLifecycleRuntimeForTests();
    managerTesting.resetAcpSessionManagerForTests();
    installInMemoryTaskRegistryRuntime();
    configureTaskFlowRegistryRuntime({ store: createInMemoryTaskFlowRegistryStore() });

    const controls = new Map<
      string,
      {
        entered: ReturnType<typeof createDeferred<AbortSignal>>;
        finish: ReturnType<typeof createDeferred<void>>;
      }
    >();
    const cancelledSessions: string[] = [];
    let cancellationBarrier:
      | {
          entered: ReturnType<typeof createDeferred<void>>;
          release: ReturnType<typeof createDeferred<void>>;
        }
      | undefined;
    const runtime: AcpRuntime = {
      ownerAwareSessions: 1,
      ensureSession: async (input) => ({
        sessionKey: input.sessionKey,
        agentId: input.agentId,
        backend: backendId,
        runtimeSessionName: input.sessionKey,
      }),
      async *runTurn(input) {
        const control = controls.get(input.text);
        if (!control || !input.signal) {
          throw new Error("Expected an admitted ACP turn.");
        }
        const signal = input.signal;
        const onAbort = () => control.finish.resolve();
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          yield { type: "text_delta", stream: "output", text: "Working until released." };
          control.entered.resolve(signal);
          if (signal.aborted) {
            onAbort();
          }
          await control.finish.promise;
          yield {
            type: "done",
            status: signal.aborted ? "cancelled" : "completed",
            stopReason: signal.aborted ? "cancel" : "end_turn",
          };
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      },
      async cancel({ handle }) {
        cancelledSessions.push(handle.sessionKey);
        if (cancellationBarrier) {
          cancellationBarrier.entered.resolve();
          await cancellationBarrier.release.promise;
        }
      },
      async close() {},
    };
    registerAcpRuntimeBackend({ id: backendId, runtime });
    const manager = getAcpSessionManager();
    const admissions: PreparedAgentRunAdmission[] = [];
    const turns: Promise<void>[] = [];
    const createSession = async (key: string, parentSessionKey?: string, declareSpawn = false) => {
      const created = await createGatewaySession({
        cfg,
        key,
        agentId: "main",
        commandSource: "test",
        operatorRoleActor: { kind: "system" },
        requestingOperatorScopes: ["operator.admin"],
        allowExistingModelSelection: true,
        fork: false,
        ...(parentSessionKey ? { parentSessionKey } : {}),
        ...(declareSpawn
          ? { spawnDepth: 1, spawnToolPolicy: { version: 1 as const, allow: [], deny: [] } }
          : {}),
      });
      if (!created.ok) {
        throw new Error(created.error.message);
      }
      return created.entry;
    };
    const prepareTurn = async (sessionKey: string, runId: string): Promise<PendingAcpTurn> => {
      const control = { entered: createDeferred<AbortSignal>(), finish: createDeferred() };
      const admission = prepareSystemAgentRunAdmission(cfg, runId, "main", "acp-cancellation-test");
      admissions.push(admission);
      const admittedRunContext = await admission.admit("acp");
      const instanceId = admittedRunContext.operationalRunInstance.instanceId;
      const text = `Continue until released: ${instanceId}`;
      controls.set(text, control);
      const events: AcpRuntimeEvent[] = [];
      const settled = manager.runTurn({
        cfg,
        sessionKey,
        agentId: "main",
        admittedRunContext,
        provenance: "system",
        mode: "prompt",
        text,
        requestId: runId,
        onEvent: (event) => {
          events.push(event);
        },
      });
      turns.push(settled);
      void settled.catch(() => {});
      return {
        instanceId,
        events,
        settled,
        cancel: async () => {
          await manager.cancelSession({
            cfg,
            sessionKey,
            agentId: "main",
            expectedRunId: runId,
            expectedInstanceId: instanceId,
            reason: "cancel-queued-instance",
          });
        },
        waitForRuntime: async () => {
          const signal = await Promise.race([
            control.entered.promise,
            settled.then(() => {
              throw new Error("ACP turn settled before entering its runtime.");
            }),
          ]);
          const task = listTasksForRelatedSessionKey(sessionKey, "main").find((candidate) => {
            const backing = readTaskBackingInstance(candidate.detail);
            return (
              candidate.runId === runId &&
              backing?.runtime === "acp" &&
              backing.instanceId === instanceId
            );
          });
          if (!task) {
            throw new Error("Expected the exact admitted ACP task instance.");
          }
          return {
            task,
            instanceId,
            signal,
            finish: control.finish.resolve,
            settled,
          };
        },
      };
    };
    try {
      await refreshPreparedModelRuntimeSnapshots(cfg, {
        gatewayLifecycle: true,
        catalogMode: "static",
        defaultWorkspaceDir: state.workspaceDir,
      });
      await createSession(ownerA);
      await createSession(ownerB);
      if (spawnedByOwner) {
        await createSession(ancestorKey, ownerA, true);
      }
      await manager.initializeSession({
        cfg,
        sessionKey: ancestorKey,
        agentId: "main",
        agent: "main",
        mode: "persistent",
      });
      if (!spawnedByOwner) {
        await createSession(ancestorKey, ownerA);
      }
      await manager.initializeSession({
        cfg,
        sessionKey: descendantKey,
        agentId: "main",
        agent: "main",
        mode: "persistent",
      });
      await createSession(descendantKey, ancestorKey);
      beforeTurns?.();
      const ancestor = await (await prepareTurn(ancestorKey, "acp-ancestor")).waitForRuntime();
      const descendant = await (
        await prepareTurn(descendantKey, "acp-descendant")
      ).waitForRuntime();
      expect(ancestor.task).toMatchObject({
        runtime: "acp",
        ownerKey: ownerA,
        childSessionKey: ancestorKey,
      });
      expect(descendant.task).toMatchObject({
        runtime: "acp",
        ownerKey: ancestorKey,
        childSessionKey: descendantKey,
      });
      const tool = createSubagentsTool({ config: cfg, agentId: "main", agentSessionKey: ownerA });
      await run({
        tool,
        ancestor,
        descendant,
        cancelledSessions,
        queueAncestorTurn: (runId) => prepareTurn(ancestorKey, runId),
        queueDescendantSuccessor: () => prepareTurn(descendantKey, "acp-descendant"),
        pauseBackendCancellation: () => {
          cancellationBarrier = { entered: createDeferred(), release: createDeferred() };
          return {
            entered: cancellationBarrier.entered.promise,
            release: cancellationBarrier.release.resolve,
          };
        },
        adoptAncestor: async () => {
          const before = loadSessionEntry({
            sessionKey: ancestorKey,
            agentId: "main",
            storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
          });
          if (!before) {
            throw new Error("Expected the initialized ACP ancestor session.");
          }
          expect(before.parentSessionKey).toBe(ownerA);
          const adopted = await createSession(ancestorKey, ownerB);
          expect(adopted).toMatchObject({
            sessionId: before.sessionId,
            parentSessionKey: ownerB,
          });
          expect(adopted.lifecycleRevision).toBe(before.lifecycleRevision);
          expect(adopted.spawnedBy).toBe(spawnedByOwner ? ownerA : undefined);
          const persisted = loadSessionEntry({
            sessionKey: ancestorKey,
            agentId: "main",
            storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
          });
          expect(persisted).toMatchObject({
            sessionId: before.sessionId,
            parentSessionKey: ownerB,
          });
          expect(persisted?.spawnedBy).toBe(spawnedByOwner ? ownerA : undefined);
          expect(persisted?.lifecycleRevision).toBe(before.lifecycleRevision);
          expect(ancestor.signal.aborted).toBe(false);
          expect(descendant.signal.aborted).toBe(false);
          expect(getTaskById(ancestor.task.taskId)).toEqual(ancestor.task);
          expect(getTaskById(descendant.task.taskId)).toEqual(descendant.task);
        },
      });
    } finally {
      cancellationBarrier?.release.resolve();
      for (const control of controls.values()) {
        control.finish.resolve();
      }
      await Promise.allSettled(turns);
      for (const admission of admissions) {
        admission.close();
      }
      await disposeAcpSessionManagerInstance(manager, "test-complete");
      managerTesting.resetAcpSessionManagerForTests();
      unregisterAcpRuntimeBackend(backendId);
      resetDetachedTaskLifecycleRuntimeForTests();
      resetSubagentRegistryForTests({ persist: false });
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      resetAgentEventsForTest();
      await resetPreparedModelRuntimeSnapshotsForTest();
    }
  });
}

describe("ACP ancestry in subagents cancellation", () => {
  it.each(["fresh", "pending"] as const)(
    "observes %s direct ACP task cancellation after parent-only adoption",
    async (timing) => {
      await withAcpTree(
        false,
        async ({ tool, ancestor, descendant, cancelledSessions, adoptAncestor }) => {
          const flowId = ancestor.task.parentFlowId;
          if (!flowId) {
            throw new Error("Expected the canonical ACP task's mirrored flow.");
          }
          expect(getTaskFlowById(flowId)).toMatchObject({
            syncMode: "task_mirrored",
            ownerKey: ownerA,
          });
          expect(readTaskBackingInstance(ancestor.task.detail)).toMatchObject({
            runtime: "acp",
            instanceId: ancestor.instanceId,
          });
          const entered = createDeferred();
          const release = createDeferred();
          const runtime = getDetachedTaskLifecycleRuntime();
          if (timing === "pending") {
            setDetachedTaskLifecycleRuntime({
              ...runtime,
              cancelDetachedTaskRunById: async (params) => {
                if (params.taskId === ancestor.task.taskId) {
                  entered.resolve();
                  await release.promise;
                }
                return runtime.cancelDetachedTaskRunById(params);
              },
            });
          }
          let pending: ReturnType<typeof tool.execute> | undefined;
          try {
            if (timing === "pending") {
              pending = tool.execute("cancel-direct-before-adoption", {
                action: "cancel",
                taskId: ancestor.task.taskId,
              });
              await Promise.race([
                entered.promise,
                pending.then(() => {
                  throw new Error("Cancellation skipped the registered runtime.");
                }),
              ]);
            }
            await adoptAncestor();
            release.resolve();
            const result = await (pending ??
              tool.execute("cancel-direct-after-adoption", {
                action: "cancel",
                taskId: ancestor.task.taskId,
              }));
            expect(result.details).toMatchObject({ status: "cancelled", cancelled: true });
            await ancestor.settled;
            expect(ancestor.signal.aborted).toBe(true);
            expect(cancelledSessions).toContain(ancestorKey);
            expect(cancelledSessions).not.toContain(descendantKey);
            expect(descendant.signal.aborted).toBe(false);
            expect(getTaskById(descendant.task.taskId)).toEqual(descendant.task);
            expect(getTaskById(ancestor.task.taskId)).toMatchObject({
              taskId: ancestor.task.taskId,
              ownerKey: ownerA,
              runId: ancestor.task.runId,
              childSessionKey: ancestorKey,
              detail: ancestor.task.detail,
              status: "cancelled",
            });
          } finally {
            release.resolve();
            await Promise.allSettled(pending ? [pending] : []);
            resetDetachedTaskLifecycleRuntimeForTests();
          }
        },
      );
    },
  );

  it("does not let an older ACP task without backing cancel a newly queued same-ID execution", async () => {
    let legacyTask: TaskRecord | null = null;
    const runId = "acp-queued-legacy";
    await withAcpTree(
      false,
      async ({ tool, ancestor, descendant, cancelledSessions, queueAncestorTurn }) => {
        if (!legacyTask) {
          throw new Error("Expected the legacy task for the queued run.");
        }
        const manager = getAcpSessionManager();
        const queueBefore = manager.getObservabilitySnapshot().turns.queueDepth;
        const queued = await queueAncestorTurn(runId);
        expect(manager.getObservabilitySnapshot().turns.queueDepth).toBe(queueBefore + 1);
        expect(queued.events).toEqual([]);
        const before = listTasksForRelatedSessionKey(ancestorKey, "main").filter(
          (task) => task.runId === runId,
        );
        expect(before).toEqual([legacyTask]);
        expect(before[0]?.detail).toBeUndefined();
        expect(ancestor.task.runId).not.toBe(runId);
        const result = await tool.execute("cancel-queued-legacy-run", {
          action: "cancel",
          taskId: legacyTask.taskId,
        });
        expect(result.details).toMatchObject({ status: "error", cancelled: false });
        expect(queued.events).toEqual([]);
        expect(cancelledSessions).toEqual([]);
        expect(ancestor.signal.aborted).toBe(false);
        expect(descendant.signal.aborted).toBe(false);
        expect(getTaskById(ancestor.task.taskId)).toEqual(ancestor.task);
        expect(getTaskById(legacyTask.taskId)).toEqual(legacyTask);
        ancestor.finish();
        await ancestor.settled;
        const runningQueued = await queued.waitForRuntime();
        expect(runningQueued.task.taskId).not.toBe(legacyTask.taskId);
        expect(runningQueued.signal.aborted).toBe(false);
        runningQueued.finish();
        await runningQueued.settled;
        expect(getTaskById(runningQueued.task.taskId)?.status).toBe("succeeded");
        expect(getTaskById(legacyTask.taskId)).toEqual(legacyTask);
      },
      () => {
        legacyTask = createRunningTaskRun({
          runtime: "acp",
          sourceId: runId,
          ownerKey: ownerA,
          scopeKind: "session",
          childSessionKey: ancestorKey,
          runId,
          task: "Retained queued ACP request",
          startedAt: Date.now(),
        });
      },
    );
  });

  it("does not let an older ACP task without backing cancel a distinct current same-ID execution", async () => {
    let legacyTask: TaskRecord | null = null;
    await withAcpTree(
      false,
      async ({ tool, ancestor, descendant, cancelledSessions }) => {
        if (!legacyTask) {
          throw new Error("Expected the legacy canonical ACP task.");
        }
        expect(legacyTask.detail).toBeUndefined();
        expect(ancestor.task.taskId).not.toBe(legacyTask.taskId);
        expect(ancestor.task.parentFlowId).not.toBe(legacyTask.parentFlowId);
        expect(ancestor.task).toMatchObject({
          runId: legacyTask.runId,
          childSessionKey: legacyTask.childSessionKey,
          ownerKey: legacyTask.ownerKey,
        });
        expect(readTaskBackingInstance(ancestor.task.detail)).toMatchObject({
          runtime: "acp",
          instanceId: ancestor.instanceId,
        });
        for (const task of [legacyTask, ancestor.task]) {
          if (!task.parentFlowId) {
            throw new Error("Expected a canonical ACP task with a mirrored flow.");
          }
          expect(getTaskFlowById(task.parentFlowId)?.syncMode).toBe("task_mirrored");
          expect(getTaskById(task.taskId)).toEqual(task);
        }
        const result = await tool.execute("cancel-old-backingless-task", {
          action: "cancel",
          taskId: legacyTask.taskId,
        });
        if (ancestor.signal.aborted) {
          await ancestor.settled;
        }
        expect.soft(result.details).toMatchObject({ status: "error", cancelled: false });
        expect.soft(cancelledSessions).toEqual([]);
        expect.soft(ancestor.signal.aborted).toBe(false);
        expect.soft(getTaskById(ancestor.task.taskId)).toEqual(ancestor.task);
        expect.soft(getTaskById(legacyTask.taskId)).toEqual(legacyTask);
        expect(descendant.signal.aborted).toBe(false);
      },
      () => {
        legacyTask = createRunningTaskRun({
          runtime: "acp",
          sourceId: "acp-ancestor",
          ownerKey: ownerA,
          scopeKind: "session",
          childSessionKey: ancestorKey,
          runId: "acp-ancestor",
          task: "Retained legacy ACP execution",
          startedAt: Date.now(),
        });
      },
    );
  });

  it("cancels the selected ACP instance without stopping its queued same-ID successor", async () => {
    await withAcpTree(
      false,
      async ({
        tool,
        ancestor,
        descendant,
        queueDescendantSuccessor,
        pauseBackendCancellation,
      }) => {
        const successor = await queueDescendantSuccessor();
        const priorBacking = readTaskBackingInstance(descendant.task.detail);
        if (priorBacking?.runtime !== "acp") {
          throw new Error("Expected the predecessor's canonical ACP backing.");
        }
        expect(successor.instanceId).not.toBe(descendant.instanceId);
        expect(successor.events).toEqual([]);
        expect(getTaskById(descendant.task.taskId)).toEqual(descendant.task);
        const backend = pauseBackendCancellation();
        const cancellation = tool.execute("cancel-selected-instance", {
          action: "cancel",
          taskId: descendant.task.taskId,
        });
        try {
          await backend.entered;
          await descendant.settled;
          expect(descendant.signal.aborted).toBe(true);
          expect(ancestor.signal.aborted).toBe(false);
          expect(successor.events).not.toContainEqual({
            type: "done",
            status: "cancelled",
            stopReason: "cancel",
          });
          const runningSuccessor = await successor.waitForRuntime();
          expect(runningSuccessor.signal.aborted).toBe(false);
          const successorBacking = readTaskBackingInstance(runningSuccessor.task.detail);
          expect(successorBacking?.generation).toBeGreaterThan(priorBacking.generation);
          expect(runningSuccessor.task.taskId).not.toBe(descendant.task.taskId);
          expect(runningSuccessor.task.parentFlowId).not.toBe(descendant.task.parentFlowId);
          const cancelledPredecessor = getTaskById(descendant.task.taskId);
          expect(cancelledPredecessor).toMatchObject({
            status: "cancelled",
            detail: descendant.task.detail,
          });
          const expectedSuccessor = {
            taskId: runningSuccessor.task.taskId,
            runId: descendant.task.runId,
            parentFlowId: runningSuccessor.task.parentFlowId,
            status: "running",
            detail: {
              runtime: "acp",
              instanceId: successor.instanceId,
              generation: successorBacking?.generation,
            },
          };
          expect(getTaskById(runningSuccessor.task.taskId)).toMatchObject(expectedSuccessor);
          expect(getTaskById(runningSuccessor.task.taskId)?.error).toBeUndefined();
          backend.release();
          expect((await cancellation).details).toMatchObject({
            status: "cancelled",
            cancelled: true,
          });
          expect(getTaskById(descendant.task.taskId)).toEqual(cancelledPredecessor);
          expect(getTaskById(runningSuccessor.task.taskId)).toMatchObject(expectedSuccessor);
          runningSuccessor.finish();
          await runningSuccessor.settled;
          expect(successor.events).toContainEqual({
            type: "done",
            status: "completed",
            stopReason: "end_turn",
          });
          expect(getTaskById(runningSuccessor.task.taskId)).toMatchObject({
            ...expectedSuccessor,
            status: "succeeded",
          });
          expect(getTaskById(descendant.task.taskId)).toEqual(cancelledPredecessor);
        } finally {
          backend.release();
          await Promise.allSettled([cancellation]);
        }
      },
    );
  });

  it("cancels a queued same-ID instance without replacing its active predecessor's task", async () => {
    await withAcpTree(false, async ({ descendant, queueDescendantSuccessor }) => {
      const queued = await queueDescendantSuccessor();
      await queued.cancel();
      await queued.settled;
      expect(queued.events).toContainEqual({
        type: "done",
        status: "cancelled",
        stopReason: "cancel",
      });
      expect(descendant.signal.aborted).toBe(false);
      expect(getTaskById(descendant.task.taskId)).toEqual(descendant.task);
      expect(
        listTasksForRelatedSessionKey(descendantKey, "main").filter(
          (task) => task.runId === descendant.task.runId,
        ),
      ).toEqual([descendant.task]);
    });
  });

  it.each(["fresh", "pending"] as const)(
    "revokes %s descendant cancellation after parent-only adoption and retains historical visibility",
    async (timing) => {
      await withAcpTree(
        false,
        async ({ tool, ancestor, descendant, cancelledSessions, adoptAncestor }) => {
          const entered = createDeferred();
          const release = createDeferred();
          const runtime = getDetachedTaskLifecycleRuntime();
          if (timing === "pending") {
            let gateNext = true;
            setDetachedTaskLifecycleRuntime({
              ...runtime,
              cancelDetachedTaskRunById: async (params) => {
                if (gateNext && params.taskId === descendant.task.taskId) {
                  gateNext = false;
                  entered.resolve();
                  await release.promise;
                }
                return runtime.cancelDetachedTaskRunById(params);
              },
            });
          }
          let pending: ReturnType<typeof tool.execute> | undefined;
          try {
            if (timing === "pending") {
              pending = tool.execute("cancel-before-adoption", {
                action: "cancel",
                taskId: descendant.task.taskId,
              });
              await Promise.race([
                entered.promise,
                pending.then(() => {
                  throw new Error("Cancellation skipped the registered runtime.");
                }),
              ]);
            }
            await adoptAncestor();
            release.resolve();
            const result = await (pending ??
              tool.execute("cancel-after-adoption", {
                action: "cancel",
                taskId: descendant.task.taskId,
              }));
            expect(result.details).toMatchObject(
              timing === "pending"
                ? { status: "error", cancelled: false, reason: "Task outside session tree." }
                : { status: "forbidden", error: "Task outside session tree." },
            );
            expect(cancelledSessions).toEqual([]);
            expect(descendant.signal.aborted).toBe(false);
            expect(getTaskById(descendant.task.taskId)).toEqual(descendant.task);
            expect((await tool.execute("list-history", { action: "list" })).details).toMatchObject({
              tasks: expect.arrayContaining([
                expect.objectContaining({ taskId: ancestor.task.taskId }),
                expect.objectContaining({ taskId: descendant.task.taskId }),
              ]),
            });
            expect(
              (
                await tool.execute("wait-running-history", {
                  action: "wait",
                  taskIds: [descendant.task.taskId],
                  timeoutSeconds: 0,
                })
              ).details,
            ).toMatchObject({ reason: "timeout", tasks: [{ taskId: descendant.task.taskId }] });
            descendant.finish();
            await descendant.settled;
            expect(
              (
                await tool.execute("wait-completed-history", {
                  action: "wait",
                  taskIds: [descendant.task.taskId],
                  timeoutSeconds: 0,
                })
              ).details,
            ).toMatchObject({ reason: "completed", completed: [descendant.task.taskId] });
          } finally {
            release.resolve();
            await Promise.allSettled(pending ? [pending] : []);
            resetDetachedTaskLifecycleRuntimeForTests();
          }
        },
      );
    },
  );

  it.each([
    ["controls its parent-only ACP descendant", false],
    ["retains spawnedBy control after navigation parent adoption", true],
  ] as const)("%s", async (_name, spawnedByOwner) => {
    await withAcpTree(
      spawnedByOwner,
      async ({ tool, ancestor, descendant, cancelledSessions, adoptAncestor }) => {
        if (spawnedByOwner) {
          await adoptAncestor();
        }
        expect(
          (
            await tool.execute("cancel-controlled-descendant", {
              action: "cancel",
              taskId: descendant.task.taskId,
            })
          ).details,
        ).toMatchObject({ status: "cancelled", cancelled: true });
        await descendant.settled;
        expect(descendant.signal.aborted).toBe(true);
        expect(ancestor.signal.aborted).toBe(false);
        expect(cancelledSessions).toContain(descendantKey);
        expect(getTaskById(descendant.task.taskId)).toMatchObject({
          status: "cancelled",
          ownerKey: ancestorKey,
        });
      },
    );
  });
});
