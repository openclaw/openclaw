// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  describe0AfterEach0,
  backendGatewayClient,
  expectRecordFields,
  expectStringFieldContains,
  getAgentTestMocks,
  invokeAgent,
  makeContext,
  mockCallArg,
  primeMainAgentRun,
  resetAgentTaskRegistryForTests,
  restoreAgentTaskRegistryRuntimeAfterTests,
  useTestStateDir,
  waitForAssertion,
} from "./agent.test-harness.js";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AgentCommandOpts } from "../../agents/command/types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../../plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import { getDetachedTaskLifecycleRuntime } from "../../tasks/detached-task-runtime.js";
import { createTaskRecord, findTaskByRunId } from "../../tasks/task-registry.js";
import { getTaskRegistryStore } from "../../tasks/task-registry.store.js";
import { loadTaskRegistryStateFromSqliteReadOnly } from "../../tasks/task-registry.store.sqlite.js";
import { withTaskRegistryTempDir } from "../../tasks/task-registry.test-support.js";
import { getTaskRunOwner } from "../../tasks/task-run-owner.js";
import { setDetachedTaskLifecycleRuntime } from "../../tasks/task-runtime.test-helpers.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { createChatAbortOps } from "../chat-abort-ops.js";
import {
  abortChatRunById,
  removeChatAbortControllerEntry,
  type ChatAbortControllerEntry,
} from "../chat-abort.js";

resetAgentTaskRegistryForTests();
afterAll(restoreAgentTaskRegistryRuntimeAfterTests);

function persistedTasks(runId: string) {
  return [...loadTaskRegistryStateFromSqliteReadOnly().tasks.values()].filter(
    (task) => task.runId === runId,
  );
}

function primeTaskAdmission(root: string, followup: boolean) {
  primeMainAgentRun();
  const mocks = getAgentTestMocks();
  const requesterSessionKey = "agent:main:main";
  const childSessionKey = "agent:main:subagent:registration";
  const sessionKey = followup ? childSessionKey : requesterSessionKey;
  const runId = "task-registration-admission";
  const storePath = path.join(root, "agents", "main", "sessions", "sessions.json");
  mocks.userTurnStorePath = storePath;
  mocks.loadSessionEntry.mockReturnValue({
    cfg: {},
    storePath,
    canonicalKey: sessionKey,
    entry: {
      sessionId: "registration-session",
      updatedAt: Date.now(),
      ...(followup ? { spawnedBy: requesterSessionKey, label: "Review follow-up" } : {}),
    },
  });
  const request = {
    message: "Continue reviewing the candidate",
    sessionKey,
    idempotencyKey: runId,
    ...(followup
      ? {
          inputProvenance: {
            kind: "inter_session" as const,
            sourceSessionKey: requesterSessionKey,
            sourceTool: "sessions_send",
          },
        }
      : {}),
  };
  return { mocks, requesterSessionKey, childSessionKey, sessionKey, runId, request };
}

describe("gateway agent detached task lifecycle", () => {
  afterEach(describe0AfterEach0);

  it.each([
    { kind: "follow-up", creation: "succeeds" },
    { kind: "follow-up", creation: "throws" },
    { kind: "follow-up", creation: "returns null" },
    { kind: "follow-up", creation: "returns terminal" },
    { kind: "ordinary CLI", creation: "throws" },
    { kind: "ordinary CLI", creation: "returns null" },
  ])("admits $kind only as required when task creation $creation", async ({ kind, creation }) => {
    await withTaskRegistryTempDir(
      async (root) => {
        const followup = kind === "follow-up";
        const { mocks, requesterSessionKey, childSessionKey, sessionKey, runId, request } =
          primeTaskAdmission(root, followup);
        const runtime = getDetachedTaskLifecycleRuntime();
        const create = vi.fn<typeof runtime.createRunningTaskRun>((params) => {
          if (creation === "throws") {
            throw new Error("task registration unavailable");
          }
          if (creation === "returns terminal") {
            return createTaskRecord({ ...params, status: "failed" });
          }
          return creation === "returns null" ? null : runtime.createRunningTaskRun(params);
        });
        setDetachedTaskLifecycleRuntime({ ...runtime, createRunningTaskRun: create });
        const execution = createDeferred<{ payloads: []; meta: { durationMs: number } }>();
        mocks.agentCommand.mockReturnValueOnce(execution.promise);
        const acceptedTasks: Array<ReturnType<typeof findTaskByRunId>> = [];
        const respond = vi.fn((ok: boolean, payload: unknown) => {
          if (ok && isRecord(payload) && payload.status === "accepted") {
            acceptedTasks.push(persistedTasks(runId)[0]);
          }
        });
        const context = makeContext();
        try {
          await invokeAgent(request, {
            context,
            respond,
            client: backendGatewayClient(),
            reqId: runId,
          });
          expect(create).toHaveBeenCalledOnce();
          expect(create.mock.calls[0]?.[0]).toMatchObject({
            runtime: "cli",
            runId,
            childSessionKey: sessionKey,
          });
          expect(create.mock.calls[0]?.[0].requesterSessionKey).toBe(
            followup ? requesterSessionKey : undefined,
          );
          if (followup && creation !== "succeeds") {
            expect.soft(acceptedTasks).toHaveLength(0);
            expect.soft(respond.mock.calls[0]?.[0]).toBe(false);
            expect.soft(mocks.agentCommand).not.toHaveBeenCalled();
            if (creation === "returns terminal") {
              expect(findTaskByRunId(runId)).toMatchObject({ runId, status: "failed" });
            } else {
              expect(findTaskByRunId(runId)).toBeUndefined();
            }
          } else {
            expect(acceptedTasks).toHaveLength(1);
            expect(mocks.agentCommand).toHaveBeenCalledOnce();
            if (followup) {
              expect(acceptedTasks[0]).toMatchObject({
                runtime: "cli",
                runId,
                requesterSessionKey,
                childSessionKey,
                status: "running",
                notifyPolicy: "silent",
                deliveryStatus: "not_applicable",
              });
            } else {
              expect(acceptedTasks[0]).toBeUndefined();
            }
          }
        } finally {
          execution.resolve({ payloads: [], meta: { durationMs: 1 } });
          if (mocks.agentCommand.mock.calls.length > 0) {
            await waitForAssertion(() => {
              expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, { status: "ok" });
            });
          }
        }
      },
      { durableStore: true },
    );
  });

  it.each(["failed", "cancelled", "succeeded", "running"] as const)(
    "retries a follow-up with an existing %s task only while execution is still owed",
    async (taskStatus) => {
      await withTaskRegistryTempDir(
        async (root) => {
          const { mocks, request, runId, requesterSessionKey, childSessionKey } =
            primeTaskAdmission(root, true);
          const original = createTaskRecord({
            runtime: "cli",
            ownerKey: requesterSessionKey,
            requesterSessionKey,
            scopeKind: "session",
            childSessionKey,
            runId,
            sourceId: runId,
            label: "Review follow-up",
            task: annotateInterSessionPromptText(request.message, request.inputProvenance),
            status: taskStatus,
            notifyPolicy: "silent",
            deliveryStatus: "not_applicable",
          });
          expect(original).not.toBeNull();
          const execution = createDeferred<{ payloads: []; meta: { durationMs: number } }>();
          mocks.agentCommand.mockReturnValueOnce(execution.promise);
          const context = makeContext();
          const respond = vi.fn();
          try {
            await invokeAgent(request, {
              context,
              respond,
              client: backendGatewayClient(),
              reqId: runId,
            });
            if (taskStatus === "running") {
              expect(respond.mock.calls[0]?.[0]).toBe(true);
              expect(mocks.agentCommand).toHaveBeenCalledOnce();
            } else {
              expect.soft(respond.mock.calls[0]?.[0]).toBe(false);
              expect.soft(mocks.agentCommand).not.toHaveBeenCalled();
            }
            expect(persistedTasks(runId)).toEqual([
              expect.objectContaining({ taskId: original?.taskId, status: taskStatus }),
            ]);
          } finally {
            execution.resolve({ payloads: [], meta: { durationMs: 1 } });
            if (mocks.agentCommand.mock.calls.length > 0) {
              await waitForAssertion(() => {
                expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, { status: "ok" });
              });
            }
          }
        },
        { durableStore: true },
      );
    },
  );

  it.each(["completed", "cancelled"] as const)(
    "settles the committed core follow-up after it is %s at acceptance",
    async (outcome) => {
      await withTaskRegistryTempDir(
        async (root) => {
          const registry = createEmptyPluginRegistry();
          markPluginRegistryActive(registry);
          try {
            await withPluginRuntimeRegistryScope(registry, async () => {
              const { mocks, request, runId, requesterSessionKey, childSessionKey } =
                primeTaskAdmission(root, true);
              const execution = createDeferred<{ payloads: []; meta: { durationMs: number } }>();
              mocks.agentCommand.mockImplementationOnce((options: AgentCommandOpts) => {
                options.onExecutionStarted?.();
                return execution.promise;
              });
              const context = makeContext();
              const acceptedTasks: Array<ReturnType<typeof persistedTasks>> = [];
              let aborted = false;
              const respond = vi.fn((ok: boolean, payload: unknown) => {
                if (ok && isRecord(payload) && payload.status === "accepted") {
                  acceptedTasks.push(persistedTasks(runId));
                  if (outcome === "cancelled") {
                    aborted = abortChatRunById(createChatAbortOps(context), {
                      runId,
                      sessionKey: childSessionKey,
                      stopReason: "rpc",
                    }).aborted;
                  }
                }
              });
              try {
                await invokeAgent(request, {
                  context,
                  respond,
                  client: backendGatewayClient(),
                  reqId: runId,
                  // Cancellation owns the terminal wait below and must not wait for dispatch.
                  flushDispatch: outcome !== "cancelled",
                });
                expect(acceptedTasks).toEqual([
                  [
                    expect.objectContaining({
                      runtime: "cli",
                      runId,
                      requesterSessionKey,
                      childSessionKey,
                      status: "running",
                      notifyPolicy: "silent",
                      deliveryStatus: "not_applicable",
                    }),
                  ],
                ]);
                expect(aborted).toBe(outcome === "cancelled");
              } finally {
                execution.resolve({ payloads: [], meta: { durationMs: 1 } });
                await waitForAssertion(() => {
                  expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
                    status: outcome === "cancelled" ? "timeout" : "ok",
                    ...(outcome === "cancelled"
                      ? { stopReason: "rpc", providerStarted: false }
                      : {}),
                  });
                });
              }
              expect(mocks.agentCommand).toHaveBeenCalledTimes(outcome === "cancelled" ? 0 : 1);
              expect(persistedTasks(runId)).toEqual([
                expect.objectContaining({
                  taskId: acceptedTasks[0]?.[0]?.taskId,
                  status: outcome === "cancelled" ? "cancelled" : "succeeded",
                  deliveryStatus: "not_applicable",
                }),
              ]);
            });
          } finally {
            markPluginRegistryRetired(registry);
          }
        },
        { durableStore: true },
      );
    },
  );

  it.each(["different child", "same child with new run", "same child adopting task"] as const)(
    "preserves task ownership when %s replaces Gateway admission",
    async (replacementKind) => {
      await withTaskRegistryTempDir(
        async (root) => {
          const registry = createEmptyPluginRegistry();
          markPluginRegistryActive(registry);
          try {
            await withPluginRuntimeRegistryScope(registry, async () => {
              const { mocks, runId, request } = primeTaskAdmission(root, true);
              const adoptsTask = replacementKind === "same child adopting task";
              const replacementRunId =
                replacementKind === "same child with new run" ? `${runId}-replacement` : runId;
              const context = makeContext();
              const store = getTaskRegistryStore();
              const create = store.runInitialMutationAsync.bind(store);
              let originalTaskId: string | undefined;
              let replacementTaskId: string | undefined;
              let replacement: ChatAbortControllerEntry | undefined;
              const replacedCreation = vi
                .spyOn(store, "runInitialMutationAsync")
                .mockImplementation(async (workerContext, command, assertCurrent, onGranted) => {
                  const result = await create(workerContext, command, assertCurrent, onGranted);
                  if (command.type === "tasks.createRecord") {
                    const committedTask = persistedTasks(runId)[0];
                    if (!committedTask) {
                      throw new Error("Expected the task committed before replacing admission");
                    }
                    originalTaskId = committedTask.taskId;
                    const original = context.chatAbortControllers.get(runId);
                    if (!original) {
                      throw new Error("Expected the original Gateway admission before replacement");
                    }
                    replacement = {
                      ...original,
                      controller: new AbortController(),
                      sessionId:
                        replacementKind === "different child"
                          ? "replacement-session"
                          : original.sessionId,
                      sessionKey:
                        replacementKind === "different child"
                          ? "agent:main:subagent:replacement"
                          : original.sessionKey,
                      operationalRunInstance: {
                        runId: replacementRunId,
                        instanceId: "replacement-instance",
                      },
                    };
                    if (replacementRunId !== runId) {
                      removeChatAbortControllerEntry(context.chatAbortControllers, runId);
                    }
                    context.chatAbortControllers.set(replacementRunId, replacement);
                    if (adoptsTask) {
                      // The replacement has claimed the same run/session but has
                      // not reached the later execution-owner binding yet.
                      expect(getTaskRunOwner(committedTask)).toBeUndefined();
                      replacementTaskId = originalTaskId;
                    } else {
                      replacementTaskId = createTaskRecord({
                        runtime: "cli",
                        ownerKey: "agent:main:replacement-parent",
                        scopeKind: "session",
                        childSessionKey: replacement.sessionKey,
                        runId: replacementRunId,
                        task: "Independent replacement task",
                        status: "running",
                        deliveryStatus: "not_applicable",
                      })?.taskId;
                    }
                  }
                  return result;
                });
              const respond = vi.fn();
              try {
                await invokeAgent(request, {
                  context,
                  respond,
                  client: backendGatewayClient(),
                  reqId: runId,
                });
                expect(respond.mock.calls[0]?.[0]).toBe(false);
                expect(mocks.agentCommand).not.toHaveBeenCalled();
                expect(originalTaskId).toBeDefined();
                expect(replacementTaskId).toBeDefined();
                const tasks = [...loadTaskRegistryStateFromSqliteReadOnly().tasks.values()];
                expect(tasks).toHaveLength(adoptsTask ? 1 : 2);
                expect(tasks).toEqual(
                  expect.arrayContaining([
                    expect.objectContaining({
                      taskId: originalTaskId,
                      status: adoptsTask ? "running" : "failed",
                    }),
                    expect.objectContaining({ taskId: replacementTaskId, status: "running" }),
                  ]),
                );
                expect(context.chatAbortControllers.get(replacementRunId)).toBe(replacement);
                expect(replacement?.controller.signal.aborted).toBe(false);
              } finally {
                replacedCreation.mockRestore();
                for (const id of new Set([runId, replacementRunId])) {
                  removeChatAbortControllerEntry(context.chatAbortControllers, id);
                }
              }
            });
          } finally {
            markPluginRegistryRetired(registry);
          }
        },
        { durableStore: true },
      );
    },
  );

  it("rejects a required follow-up when core task creation loses its runtime owner", async () => {
    await withTaskRegistryTempDir(
      async (root) => {
        const registry = createEmptyPluginRegistry();
        markPluginRegistryActive(registry);
        try {
          await withPluginRuntimeRegistryScope(registry, async () => {
            const { mocks, runId, request } = primeTaskAdmission(root, true);
            const entered = createDeferred();
            const release = createDeferred();
            const terminal = createDeferred();
            const store = getTaskRegistryStore();
            const create = store.runInitialMutationAsync.bind(store);
            const heldCreation = vi
              .spyOn(store, "runInitialMutationAsync")
              .mockImplementation(async (context, command, assertCurrent, onGranted) => {
                if (command.type === "tasks.createRecord") {
                  entered.resolve();
                  await release.promise;
                }
                return create(context, command, assertCurrent, onGranted);
              });
            const respond = vi.fn((ok: boolean, payload: unknown) => {
              if (!ok || (isRecord(payload) && payload.status !== "accepted")) {
                terminal.resolve();
              }
            });
            const admission = invokeAgent(request, {
              respond,
              client: backendGatewayClient(),
              reqId: runId,
              flushDispatch: false,
            });
            try {
              await entered.promise;
              expect.soft(respond).not.toHaveBeenCalled();
              expect(mocks.agentCommand).not.toHaveBeenCalled();
              markPluginRegistryRetired(registry);
              release.resolve();
              await admission;
              await terminal.promise;
              expect.soft(respond.mock.calls[0]?.[0]).toBe(false);
              expect(mocks.agentCommand).not.toHaveBeenCalled();
              expect(persistedTasks(runId)).toEqual([]);
            } finally {
              release.resolve();
              await admission;
              heldCreation.mockRestore();
            }
          });
        } finally {
          markPluginRegistryRetired(registry);
        }
      },
      { durableStore: true },
    );
  });

  it("dispatches async gateway agent task creation through the detached task runtime seam", async () => {
    await withTestDir({ prefix: "openclaw-gateway-agent-seam-" }, async (root) => {
      useTestStateDir(root);
      resetAgentTaskRegistryForTests();
      primeMainAgentRun();

      const defaultRuntime = getDetachedTaskLifecycleRuntime();
      const createRunningTaskRunSpy = vi.fn(
        (...args: Parameters<typeof defaultRuntime.createRunningTaskRun>) =>
          defaultRuntime.createRunningTaskRun(...args),
      );
      const finalizeTaskRunByRunIdSpy = vi.fn(
        (...args: Parameters<NonNullable<typeof defaultRuntime.finalizeTaskRunByRunId>>) =>
          defaultRuntime.finalizeTaskRunByRunId!(...args),
      );

      setDetachedTaskLifecycleRuntime({
        ...defaultRuntime,
        createRunningTaskRun: createRunningTaskRunSpy,
        finalizeTaskRunByRunId: finalizeTaskRunByRunIdSpy,
      });

      await invokeAgent(
        {
          message: "background cli seam task",
          sessionKey: "agent:main:main",
          idempotencyKey: "task-registry-agent-seam",
        },
        { reqId: "task-registry-agent-seam" },
      );

      expect(createRunningTaskRunSpy).toHaveBeenCalledTimes(1);
      expectRecordFields(mockCallArg(createRunningTaskRunSpy), {
        runtime: "cli",
        runId: "task-registry-agent-seam",
        childSessionKey: "agent:main:main",
        sourceId: "task-registry-agent-seam",
      });
      expectStringFieldContains(
        mockCallArg(createRunningTaskRunSpy) as Record<string, unknown>,
        "task",
        "background cli seam task",
      );
      await waitForAssertion(() => {
        expect(finalizeTaskRunByRunIdSpy).toHaveBeenCalledTimes(1);
        expectRecordFields(mockCallArg(finalizeTaskRunByRunIdSpy), {
          runtime: "cli",
          runId: "task-registry-agent-seam",
          status: "succeeded",
          terminalSummary: "completed",
        });
        expectRecordFields(findTaskByRunId("task-registry-agent-seam"), {
          runtime: "cli",
          childSessionKey: "agent:main:main",
          status: "succeeded",
          terminalSummary: "completed",
        });
      });
    });
  });

  it("logs a swallowed finalize error without blocking the background run", async () => {
    await withTestDir({ prefix: "openclaw-gateway-agent-finalize-throw-" }, async (root) => {
      useTestStateDir(root);
      resetAgentTaskRegistryForTests();
      primeMainAgentRun();

      const defaultRuntime = getDetachedTaskLifecycleRuntime();
      const finalizeError = new Error("finalize boom");
      // The background run completes off-turn; signal finalize instead of
      // polling for it so contended runners cannot outlast a fixed poll budget.
      const { promise: finalizeCalled, resolve: signalFinalizeCalled } = createDeferred();
      const finalizeTaskRunByRunIdSpy = vi.fn(() => {
        signalFinalizeCalled();
        throw finalizeError;
      });
      setDetachedTaskLifecycleRuntime({
        ...defaultRuntime,
        finalizeTaskRunByRunId: finalizeTaskRunByRunIdSpy,
      });

      const context = makeContext();
      const respond = vi.fn();

      await invokeAgent(
        {
          message: "finalize throw seam task",
          sessionKey: "agent:main:main",
          idempotencyKey: "task-registry-finalize-throw",
        },
        { context, respond, reqId: "task-registry-finalize-throw" },
      );

      // Event-driven wait bounded by the test timeout; the follow-up
      // observations land in the same completion path right after finalize.
      await finalizeCalled;
      expect(finalizeTaskRunByRunIdSpy).toHaveBeenCalledTimes(1);
      await waitForAssertion(() => {
        // Finalize threw, but the run must still complete (second res frame with ok status).
        const completed = respond.mock.calls.some(([ok, payload]) => {
          return ok === true && (payload as { status?: string } | undefined)?.status === "ok";
        });
        expect(completed).toBe(true);

        // The swallowed finalize error stays observable via a warn log.
        const warnMock = context.logGateway.warn as ReturnType<typeof vi.fn>;
        const loggedFinalizeError = warnMock.mock.calls.some(([message]) => {
          return (
            typeof message === "string" &&
            message.includes("failed to finalize tracked agent task") &&
            message.includes("finalize boom")
          );
        });
        expect(loggedFinalizeError).toBe(true);
      });
    });
  });
});
