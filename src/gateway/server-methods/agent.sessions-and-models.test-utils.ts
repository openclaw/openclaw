import path from "node:path";
// Imported by agent.test.ts to keep its mocked suite in one Vitest module graph.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { registerExecApprovalFollowupRuntimeHandoff } from "../../agents/bash-tools.exec-approval-followup-state.js";
import { FailoverError } from "../../agents/failover-error.js";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import type { AgentWaitResult } from "../../agents/run-wait.types.js";
import {
  addSubagentRunForTests,
  getSubagentRunByChildSessionKey,
  listSubagentRunsForRequester,
  resetSubagentRegistryForTests,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { recordAgentRunTerminalOutcome } from "../../channels/turn/agent-run-terminal-outcome.js";
import { attachErrorDiagnostic } from "../../infra/error-diagnostics.js";
import { getDetachedTaskLifecycleRuntime } from "../../tasks/detached-task-runtime.js";
import { findTaskByRunId, listTaskRecords } from "../../tasks/task-registry.js";
import { resetTaskRegistryForTests } from "../../tasks/task-registry.test-support.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { waitForAgentJob } from "../agent-turn/agent-job.js";
import { dispatchAgentRunFromGateway } from "../agent-turn/agent-run-dispatch.js";
import { createAgentTurnIo } from "../agent-turn/io.js";
import { bindInProcessSubagentResume } from "../in-process-subagent-resume.js";
import { bindParentSubagentResume } from "../session-subagent-resume.js";
import { registerPluginSubagentRunFromGateway } from "./agent-task-tracking.js";
import {
  mockSpawnedChildSessionEntry,
  spyDetachedCreateRunningTaskRun,
  withPluginSubagentTestState,
} from "./agent-task-tracking.test-helpers.js";
import { registerNativeSubagentTaskTrackingTests } from "./agent.native-subagent-task-tracking.test-utils.js";
import {
  confirmedAcpMeta,
  createPluginSubagentTestLifetime,
} from "./agent.spawned-child.test-support.js";
import { registerAgentTaskCancellationTests } from "./agent.task-cancellation.test-utils.js";
import {
  registerCompactionSessionSettlementCase,
  registerSuccessfulAgentTaskSettlementCase,
  registerYieldedRequesterSettlementCase,
} from "./agent.task-settlement.test-utils.js";
import {
  getAgentTestMocks,
  operatorWriteCliClient,
  makeContext,
  type AgentHandlerArgs,
  waitForAssertion,
  requireValue,
  expectRecordFields,
  expectStringFieldContains,
  mockCallArg,
  expectRespondError,
  mockMainSessionEntry,
  useTestStateDir,
  primeMainAgentRun,
  backendGatewayClient,
  operatorWriteGatewayClient,
  resetAgentTaskRegistryForTests,
  waitForAgentCommandCall,
  waitForAgentCommandCallAfter,
  invokeAgent,
  describe0AfterEach0,
} from "./agent.test-harness.js";

const mocks = getAgentTestMocks();

describe("gateway agent handler", () => {
  afterEach(describe0AfterEach0);

  it("rejects ordinary work on a restart-recovery tombstone", async () => {
    const entry = {
      sessionId: "tombstoned-session",
      updatedAt: Date.now(),
      status: "failed",
      abortedLastRun: false,
      mainRestartRecovery: {
        cycleId: "cycle-exhausted",
        revision: 4,
        chargedAttempts: 3,
        tombstone: { reason: "automatic recovery exhausted" },
      },
    };
    mockMainSessionEntry(entry);
    mocks.updateSessionStore.mockImplementation(
      async (_path, updater) => await updater({ "agent:main:main": structuredClone(entry) }),
    );
    const commandCallCount = mocks.agentCommand.mock.calls.length;
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "continue old work",
        sessionKey: "agent:main:main",
        idempotencyKey: "tombstone-reuse",
      },
      { reqId: "tombstone-reuse", respond },
    );

    expect(mocks.agentCommand).toHaveBeenCalledTimes(commandCallCount);
    const error = expectRespondError(respond, { code: ErrorCodes.INVALID_REQUEST });
    expectStringFieldContains(error, "message", "ended during restart recovery");
  });

  it("rejects ordinary work while restart recovery exhaustion is being tombstoned", async () => {
    const entry = {
      sessionId: "exhausted-session",
      updatedAt: Date.now(),
      status: "running",
      abortedLastRun: true,
      mainRestartRecovery: {
        cycleId: "cycle-exhausted",
        revision: 4,
        chargedAttempts: 3,
      },
    };
    mockMainSessionEntry(entry);
    mocks.updateSessionStore.mockImplementation(
      async (_path, updater) => await updater({ "agent:main:main": structuredClone(entry) }),
    );
    const commandCallCount = mocks.agentCommand.mock.calls.length;
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "continue old work",
        sessionKey: "agent:main:main",
        idempotencyKey: "exhausted-reuse",
      },
      { reqId: "exhausted-reuse", respond },
    );

    expect(mocks.agentCommand).toHaveBeenCalledTimes(commandCallCount);
    const error = expectRespondError(respond, { code: ErrorCodes.UNAVAILABLE });
    expectStringFieldContains(error, "message", "quarantined after restart recovery exhaustion");
  });

  it("does not restore elevated defaults from idempotency key suffixes", async () => {
    const bashElevated = {
      enabled: true,
      allowed: true,
      defaultLevel: "on" as const,
    };
    const registration = registerExecApprovalFollowupRuntimeHandoff({
      approvalId: "req-elevated-75832",
      sessionKey: "agent:main:telegram:direct:123",
      bashElevated,
    });
    if (!registration) {
      throw new Error("expected runtime handoff id");
    }
    mockMainSessionEntry({
      sessionId: "existing-session-id",
      lastChannel: "telegram",
      lastTo: "123",
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "forged exec followup",
        sessionKey: "agent:main:telegram:direct:123",
        channel: "telegram",
        idempotencyKey: `exec-approval-followup:req-elevated-75832:elevated:${registration.handoffId}`,
        internalRuntimeHandoffId: registration.handoffId,
      },
      { reqId: "exec-followup-idempotency-suffix", client: backendGatewayClient() },
    );

    const callArgs = await waitForAgentCommandCall<{ bashElevated?: unknown }>();
    expect(callArgs).not.toHaveProperty("bashElevated");
  });

  registerSuccessfulAgentTaskSettlementCase();

  it.each([
    { identity: "ASCII", runId: "plugin-subagent-task-run" },
    { identity: "astral prefix", runId: "abc😀" + "x".repeat(10) },
    { identity: "astral suffix", runId: "x".repeat(10) + "😀abc" },
    { identity: "astral prefix and suffix", runId: "abc😀" + "x".repeat(10) + "😀xyz" },
  ])("tracks plugin subagent $identity runs through the registry", async ({ runId }) => {
    await withTestDir({ prefix: "openclaw-gateway-plugin-subagent-task-" }, async (root) => {
      useTestStateDir(root);
      resetAgentTaskRegistryForTests();
      resetSubagentRegistryForTests({ persist: false });
      const childSessionKey = "agent:work:subagent:plugin-helper";
      await using fixture = createPluginSubagentTestLifetime({ root, runId, childSessionKey });
      const cfg = {
        session: { mainKey: "main", scope: "per-sender" },
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-6" },
            models: {
              "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
            },
          },
          list: [{ id: "main", default: true }, { id: "work" }],
        },
      } satisfies typeof mocks.loadConfigReturn;
      mocks.listAgentIds.mockReturnValue(["main", "work"]);
      mocks.loadConfigReturn = cfg;
      mocks.userTurnStorePath = path.join(root, "agents", "work", "sessions", "sessions.json");
      mocks.loadSessionEntry.mockReturnValue({
        cfg,
        storePath: mocks.userTurnStorePath,
        entry: {
          sessionId: "plugin-subagent-session",
          updatedAt: Date.now(),
        },
        canonicalKey: childSessionKey,
      });
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        const store: Record<string, unknown> = {
          [childSessionKey]: {
            sessionId: "plugin-subagent-session",
            updatedAt: Date.now(),
          },
        };
        return await updater(store);
      });
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });
      const context = makeContext();
      context.trackExecution = (run) => fixture.work.track(run);
      const baseClient = requireValue(backendGatewayClient(), "expected backend client");
      const pluginClient: AgentHandlerArgs["client"] = {
        connect: baseClient.connect,
        internal: {
          ...baseClient.internal,
          agentRunTracking: "plugin_subagent",
          pluginRuntimeOwnerId: "memory-core",
        },
      };
      const initialCommandCallCount = mocks.agentCommand.mock.calls.length;

      const respond = await fixture.work.track(() =>
        invokeAgent(
          {
            message: "background plugin subagent task",
            sessionKey: childSessionKey,
            idempotencyKey: runId,
          },
          {
            context,
            reqId: runId,
            client: pluginClient,
          },
        ),
      );
      await waitForAgentCommandCallAfter(initialCommandCallCount);

      const acceptedPayload = respond.mock.calls.find(
        ([ok, payload]) =>
          ok === true &&
          typeof payload === "object" &&
          payload !== null &&
          "status" in payload &&
          payload.status === "accepted",
      )?.[1];
      expect(acceptedPayload).toMatchObject({
        runtime: {
          harness: "claude-cli",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
        },
      });

      await fixture.cleanupCompleted;
      await fixture.work.runWhenIdle(() => {
        const tasks = listTaskRecords().filter((task) => task.runId === runId);
        expect(tasks).toHaveLength(1);
        const task = requireValue(tasks[0], "expected one plugin subagent task");
        expectRecordFields(task, {
          runtime: "subagent",
          childSessionKey,
          ownerKey: "agent:work:main",
          label: "plugin:memory-core",
          task: "background plugin subagent task",
          deliveryStatus: "not_applicable",
        });
        expect(task.runtime).not.toBe("cli");
      });

      expectRecordFields(getSubagentRunByChildSessionKey(childSessionKey), {
        cleanupCompletedAt: expect.any(Number),
      });
      const run = requireValue(
        getSubagentRunByChildSessionKey(childSessionKey),
        "expected subagent registry run",
      );
      expectRecordFields(run, {
        runId,
        childSessionKey,
        controllerSessionKey: "agent:work:main",
        requesterSessionKey: "agent:work:main",
        requesterDisplayKey: "main",
        cleanup: "keep",
        spawnMode: "run",
        label: "plugin:memory-core",
      });
      expectRecordFields(run.completion, { required: false });
      expectRecordFields(run.delivery, { status: "not_required" });

      const commandCallCount = mocks.agentCommand.mock.calls.length;
      const createdAt = run.createdAt;
      await fixture.work.track(() =>
        invokeAgent(
          {
            message: "background plugin subagent task",
            sessionKey: childSessionKey,
            idempotencyKey: runId,
          },
          {
            context,
            reqId: `${runId}-retry`,
            client: pluginClient,
          },
        ),
      );

      await fixture.work.runWhenIdle(() => {
        expect(mocks.agentCommand).toHaveBeenCalledTimes(commandCallCount);
        const retryTasks = listTaskRecords().filter((task) => task.runId === runId);
        expect(retryTasks).toHaveLength(1);
        expect(getSubagentRunByChildSessionKey(childSessionKey)?.createdAt).toBe(createdAt);
      });
    });
  });

  it("registers host-owned requester lineage for plugin subagent completion", async () => {
    await withPluginSubagentTestState("openclaw-gateway-plugin-subagent-requester-", async () => {
      const childSessionKey = "agent:work:subagent:plugin-completion";
      const requester = {
        sessionKey: "agent:main:telegram:direct:123",
        origin: {
          channel: "telegram",
          to: "telegram:123",
          accountId: "work",
          threadId: 42,
        },
      } as const;

      await registerPluginSubagentRunFromGateway({
        cfg: {
          session: { mainKey: "main", scope: "per-sender" },
          agents: {
            list: [{ id: "main", default: true }, { id: "work" }],
          },
        },
        runId: "plugin-subagent-current-requester",
        childSessionKey,
        task: "background plugin subagent task",
        requester,
        pluginId: "memory-core",
      });

      const run = requireValue(
        getSubagentRunByChildSessionKey(childSessionKey),
        "expected requester-bound plugin subagent run",
      );
      expectRecordFields(run, {
        controllerSessionKey: "agent:work:main",
        requesterSessionKey: requester.sessionKey,
        requesterAgentId: "main",
        requesterDisplayKey: requester.sessionKey,
        requesterOrigin: requester.origin,
        label: "plugin:memory-core",
      });
      expectRecordFields(run.completion, { required: true });
    });
  });

  it.each(
    [
      { parent: "normal", requesterSessionKey: "agent:main:main" },
      { parent: "cron", requesterSessionKey: "agent:main:cron:orchestration:run:scheduled-run" },
    ].flatMap((parent) =>
      [
        { sourceTool: "subagent_settle", continuesRun: true, resume: false, inputFailure: false },
        {
          sourceTool: "subagent_announce",
          continuesRun: false,
          resume: false,
          inputFailure: false,
        },
        { sourceTool: "sessions_send", continuesRun: false, resume: false, inputFailure: false },
        { sourceTool: "sessions_send", continuesRun: true, resume: true, inputFailure: false },
        { sourceTool: "sessions_send", continuesRun: false, resume: true, inputFailure: true },
      ].map((followup) => ({
        parent: parent.parent,
        requesterSessionKey: parent.requesterSessionKey,
        sourceTool: followup.sourceTool,
        continuesRun: followup.continuesRun,
        resume: followup.resume,
        inputFailure: followup.inputFailure,
      })),
    ),
  )(
    "handles $sourceTool followups (resume=$resume, inputFailure=$inputFailure) to a yielded orchestrator for its $parent parent",
    async ({ requesterSessionKey, sourceTool, continuesRun, resume, inputFailure }) => {
      await withPluginSubagentTestState("openclaw-gateway-yield-completion-", async (state) => {
        const root = state.stateDir;
        resetAgentTaskRegistryForTests();
        const childSessionKey = "agent:main:subagent:orchestrator";
        const workerSessionKey = "agent:main:subagent:worker";
        const previousRunId = "orchestrator-before-yield";
        const runId = "orchestrator-completion-followup";
        const result = "All worker results are ready.";
        const completion = createDeferred<AgentWaitResult>();
        const announce = mocks.registryAnnounce.mockResolvedValue("delivered");
        mocks.registryCallGateway.mockReturnValue(completion.promise);
        addSubagentRunForTests({
          runId: previousRunId,
          childSessionKey,
          requesterSessionKey,
          requesterDisplayKey: requesterSessionKey,
          task: "Collect the worker's result",
          startedAt: Date.now() - 10,
          endedAt: Date.now(),
          pauseReason: "sessions_yield",
          expectsCompletionMessage: true,
        });
        mockSpawnedChildSessionEntry(childSessionKey, root);
        mocks.agentCommand.mockImplementation(async () => {
          completion.resolve({
            status: "ok",
            startedAt: Date.now(),
            endedAt: Date.now(),
            terminalReply: { disposition: "visible", text: result },
          });
          return { payloads: [{ text: result }], meta: { durationMs: 1 } };
        });
        const context = makeContext();
        const request = {
          message: "The worker finished; summarize its result.",
          sessionKey: childSessionKey,
          idempotencyKey: runId,
          inputProvenance: {
            kind: "inter_session" as const,
            sourceSessionKey: workerSessionKey,
            sourceTool,
          },
        };

        const client = requireValue(backendGatewayClient(), "backend fixture client");
        if (resume) {
          client.internal = bindInProcessSubagentResume(
            { syntheticClient: true as const },
            bindParentSubagentResume({
              cfg: {},
              caller: { agentId: "main", sessionKey: requesterSessionKey, assertCurrent: vi.fn() },
              childSessionKey,
              childSessionId: "spawned-child-session",
            }),
          );
        }
        if (inputFailure) {
          mocks.stageSessionPendingInput.mockRejectedValueOnce(
            new Error("resume input admission failed"),
          );
        }
        const respond = vi.fn();
        await invokeAgent(request, { context, reqId: runId, client, respond });
        if (inputFailure) {
          expectRespondError(respond, { message: "resume input admission failed" });
          expect(mocks.agentCommand).not.toHaveBeenCalled();
          expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
            runId: previousRunId,
            pauseReason: "sessions_yield",
          });
          expect(announce).not.toHaveBeenCalled();
          return;
        }
        if (resume) {
          expect(respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({ status: "accepted", taskRunId: previousRunId }),
            undefined,
            expect.anything(),
          );
        }

        const continued = requireValue(
          getSubagentRunByChildSessionKey(childSessionKey),
          "expected the orchestrator's continued run",
        );
        if (!continuesRun) {
          await waitForAssertion(() => {
            expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, { status: "ok" });
          });
          expectRecordFields(continued, {
            runId: previousRunId,
            requesterSessionKey,
            pauseReason: "sessions_yield",
            cleanupCompletedAt: undefined,
          });
          expect(announce).not.toHaveBeenCalled();
          return;
        }
        expectRecordFields(continued, {
          runId,
          taskRunId: previousRunId,
          requesterSessionKey,
          pauseReason: undefined,
        });
        await waitForAssertion(() => {
          expect(announce).toHaveBeenCalledTimes(1);
          expectRecordFields(continued, { cleanupCompletedAt: expect.any(Number) });
          expectRecordFields(continued.delivery, { status: "delivered" });
        });
        expect(announce).toHaveBeenCalledWith(
          expect.objectContaining({
            childSessionKey,
            childRunId: runId,
            requesterSessionKey,
            roundOneReply: result,
            outcome: expect.objectContaining({ status: "ok" }),
          }),
        );

        const commandCallCount = mocks.agentCommand.mock.calls.length;
        await invokeAgent(request, {
          context,
          reqId: `${runId}-retry`,
          client,
        });
        expect(mocks.agentCommand).toHaveBeenCalledTimes(commandCallCount);
        expect(announce).toHaveBeenCalledTimes(1);
        expect(
          listSubagentRunsForRequester(requesterSessionKey).map((entry) => entry.runId),
        ).toEqual([runId]);
      });
    },
  );

  registerYieldedRequesterSettlementCase(mockSpawnedChildSessionEntry);

  it("disposes resume runtime when task replacement and pending-input cleanup both fail", async () => {
    await withTestDir({ prefix: "openclaw-resume-cleanup-failure-" }, async (root) => {
      useTestStateDir(root);
      resetAgentTaskRegistryForTests();
      resetSubagentRegistryForTests({ persist: false });
      const childSessionKey = "agent:main:dashboard:resume-cleanup";
      const previousRunId = "resume-cleanup-paused";
      const runId = "resume-cleanup-successor";
      addSubagentRunForTests({
        runId: previousRunId,
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "Wait",
        startedAt: Date.now() - 10,
        endedAt: Date.now(),
        pauseReason: "sessions_yield",
        expectsCompletionMessage: true,
      });
      mockSpawnedChildSessionEntry(childSessionKey, root);
      mocks.registryPersistOrThrow.mockImplementation(() => {
        throw new Error("task replacement failed");
      });
      const runtime = await import("../../agents/prepared-model-runtime.js");
      const acquire = vi.mocked(runtime.acquireAgentRunPreparedModelRuntime);
      const createLease = requireValue(acquire.getMockImplementation(), "model lease fixture");
      const dispose = vi.fn(async () => {});
      acquire.mockImplementationOnce(async (...args) => ({
        ...(await createLease(...args)),
        [Symbol.asyncDispose]: dispose,
      }));
      const stage = requireValue(
        mocks.stageSessionPendingInput.getMockImplementation(),
        "input fixture",
      );
      const finish = vi.fn(() => {
        throw new Error("input cleanup failed");
      });
      mocks.stageSessionPendingInput.mockImplementationOnce(async (...args) => {
        const input = await stage(...args);
        return input ? { ...input, finish } : input;
      });
      const client = requireValue(backendGatewayClient(), "backend client");
      client.internal = bindInProcessSubagentResume(
        { syntheticClient: true as const },
        bindParentSubagentResume({
          cfg: {},
          caller: { agentId: "main", sessionKey: "agent:main:main", assertCurrent: vi.fn() },
          childSessionKey,
          childSessionId: "spawned-child-session",
        }),
      );
      const respond = vi.fn();
      const context = makeContext();
      try {
        await invokeAgent(
          {
            message: "Continue",
            sessionKey: childSessionKey,
            idempotencyKey: runId,
            inputProvenance: {
              kind: "inter_session",
              sourceTool: "sessions_send",
              sourceSessionKey: "agent:main:main",
            },
          },
          { client, respond, context, flushDispatch: false },
        );
        expect(finish).toHaveBeenCalledWith("cancelled");
        expect(dispose).toHaveBeenCalledOnce();
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            message: expect.stringContaining(
              "Error: task replacement failed; pending input cleanup failed: Error: input cleanup failed",
            ),
          }),
        );
        expect(mocks.agentCommand).not.toHaveBeenCalled();
        expect(context.chatAbortControllers.has(runId)).toBe(false);
        expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
          runId: previousRunId,
          pauseReason: "sessions_yield",
        });
      } finally {
        mocks.registryPersistOrThrow.mockReset();
      }
    });
  });

  it("registers normally when a follow-up to a paused session names its own requester", async () => {
    await withPluginSubagentTestState(
      "openclaw-gateway-plugin-subagent-own-requester-",
      async ({ stateDir: root }) => {
        resetAgentTaskRegistryForTests();
        const childSessionKey = "agent:work:subagent:plugin-yield-own-requester";
        const originalRequester = "agent:main:telegram:direct:777";
        const previousRunId = "plugin-subagent-paused";
        const runId = "plugin-subagent-own-requester";
        await using fixture = createPluginSubagentTestLifetime({ root, runId, childSessionKey });
        const followUpRequester = {
          sessionKey: "agent:main:telegram:direct:555",
          origin: { channel: "telegram", to: "telegram:555", accountId: "work" },
        } as const;
        const cfg = {
          session: { mainKey: "main", scope: "per-sender" },
          agents: { list: [{ id: "main", default: true }, { id: "work" }] },
        } satisfies typeof mocks.loadConfigReturn;
        mocks.listAgentIds.mockReturnValue(["main", "work"]);
        mocks.loadConfigReturn = cfg;
        mocks.userTurnStorePath = path.join(root, "agents", "work", "sessions", "sessions.json");
        mocks.loadSessionEntry.mockReturnValue({
          cfg,
          storePath: mocks.userTurnStorePath,
          entry: { sessionId: "spawned-child-session", updatedAt: Date.now() },
          canonicalKey: childSessionKey,
        });
        mocks.updateSessionStore.mockResolvedValue(undefined);
        const result = "The separately requested follow-up is complete.";
        const completion = createDeferred<AgentWaitResult>();
        const announce = mocks.registryAnnounce.mockResolvedValue("delivered");
        mocks.registryCallGateway.mockReturnValue(completion.promise);
        addSubagentRunForTests({
          runId: previousRunId,
          childSessionKey,
          requesterSessionKey: originalRequester,
          requesterDisplayKey: originalRequester,
          task: "wait for the remote job",
          endedAt: 2_000,
          pauseReason: "sessions_yield",
          expectsCompletionMessage: true,
        });
        mocks.agentCommand.mockImplementation(async () => {
          completion.resolve({
            status: "ok",
            startedAt: Date.now(),
            endedAt: Date.now(),
            terminalReply: { disposition: "visible", text: result },
          });
          return { payloads: [{ text: result }], meta: { durationMs: 1 } };
        });
        const context = makeContext();
        const baseClient = requireValue(backendGatewayClient(), "expected backend client");

        const response = await fixture.work.track(() =>
          invokeAgent(
            {
              message: "deliver to me instead",
              sessionKey: childSessionKey,
              idempotencyKey: runId,
            },
            {
              context,
              reqId: runId,
              client: {
                connect: baseClient.connect,
                internal: {
                  ...baseClient.internal,
                  agentRunTracking: "plugin_subagent",
                  pluginSubagentRequester: followUpRequester,
                  pluginRuntimeOwnerId: "memory-core",
                },
              },
            },
          ),
        );
        expect(response.mock.calls[0]?.[0], JSON.stringify(response.mock.calls[0])).toBe(true);
        await fixture.cleanupCompleted;
        expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, { status: "ok" });
        expect(announce).toHaveBeenCalledTimes(1);

        // An explicit requester is a delivery opt-in. Adopting the paused row here
        // would drop that audience with nothing recording why, so the follow-up
        // gets its own row and the paused run keeps its original requester.
        const originalRuns = listSubagentRunsForRequester(originalRequester);
        expect(originalRuns.map((entry) => entry.runId)).toEqual([previousRunId]);
        expectRecordFields(requireValue(originalRuns[0], "expected original paused owner"), {
          requesterSessionKey: originalRequester,
          pauseReason: "sessions_yield",
          cleanupCompletedAt: undefined,
        });
        const run = requireValue(
          getSubagentRunByChildSessionKey(childSessionKey),
          "expected separately registered plugin subagent run",
        );
        expectRecordFields(run.delivery, { status: "delivered" });
        expectRecordFields(run, {
          runId,
          requesterSessionKey: followUpRequester.sessionKey,
          requesterOrigin: followUpRequester.origin,
        });
        expect(announce).toHaveBeenCalledWith(
          expect.objectContaining({
            childSessionKey,
            childRunId: runId,
            requesterSessionKey: followUpRequester.sessionKey,
            roundOneReply: result,
          }),
        );
      },
    );
  });

  it("still adopts the paused owner for a default follow-up after a requester-bound sibling", async () => {
    await withPluginSubagentTestState(
      "openclaw-gateway-plugin-subagent-mixed-delivery-",
      async () => {
        const childSessionKey = "agent:work:subagent:plugin-yield-mixed-delivery";
        const originalRequester = "agent:main:telegram:direct:777";
        const cfg = {
          session: { mainKey: "main", scope: "per-sender" as const },
          agents: { list: [{ id: "main", default: true }, { id: "work" }] },
        };
        addSubagentRunForTests({
          runId: "plugin-subagent-paused",
          childSessionKey,
          requesterSessionKey: originalRequester,
          requesterDisplayKey: originalRequester,
          task: "wait for the remote job",
          endedAt: 2_000,
          pauseReason: "sessions_yield",
          expectsCompletionMessage: true,
        });

        // A requester-bound follow-up lands at a higher generation than the paused
        // owner, so it becomes the newest row for this session.
        await registerPluginSubagentRunFromGateway({
          cfg,
          runId: "plugin-subagent-sibling",
          childSessionKey,
          task: "deliver to me instead",
          requester: {
            sessionKey: "agent:main:telegram:direct:555",
            origin: { channel: "telegram", to: "telegram:555", accountId: "work" },
          },
          pluginId: "memory-core",
        });

        await registerPluginSubagentRunFromGateway({
          cfg,
          runId: "plugin-subagent-default-followup",
          childSessionKey,
          task: "the remote job finished",
          pluginId: "memory-core",
        });

        // Adoption selects the newest *paused* row, not the newest row overall.
        // Matching on generation alone would pick the sibling, decline adoption,
        // and leave the original requester parked behind a row that can never
        // announce. The sibling's own liveness is irrelevant to that choice.
        const requesterRuns = listSubagentRunsForRequester(originalRequester);
        expect(requesterRuns.map((entry) => entry.runId)).toEqual([
          "plugin-subagent-default-followup",
        ]);
        expectRecordFields(requireValue(requesterRuns[0], "expected adopted run"), {
          childSessionKey,
          task: "the remote job finished",
          pauseReason: undefined,
        });
      },
    );
  });

  it("rejects plugin SDK subagent registration and adoption when persistence fails", async () => {
    await withPluginSubagentTestState(
      "openclaw-gateway-plugin-subagent-registry-fail-",
      async () => {
        resetAgentTaskRegistryForTests();
        const persistSubagentRunsToDiskOrThrow = vi.fn();
        const persistenceError = Object.assign(new Error("disk full"), { code: "SQLITE_FULL" });
        persistSubagentRunsToDiskOrThrow.mockImplementationOnce(() => {
          throw persistenceError;
        });
        mocks.registryPersistOrThrow.mockImplementation(persistSubagentRunsToDiskOrThrow);
        const runId = "plugin-subagent-registry-fail";
        const childSessionKey = "agent:main:subagent:registry-fail";
        const cfg = {
          session: { mainKey: "main", scope: "per-sender" },
        } satisfies typeof mocks.loadConfigReturn;
        mocks.loadConfigReturn = cfg;
        mocks.loadSessionEntry.mockReturnValue({
          cfg,
          storePath: "/tmp/sessions.json",
          entry: {
            sessionId: "plugin-subagent-registry-fail-session",
            updatedAt: Date.now(),
          },
          canonicalKey: childSessionKey,
        });
        mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
          const store: Record<string, unknown> = {
            [childSessionKey]: {
              sessionId: "plugin-subagent-registry-fail-session",
              updatedAt: Date.now(),
            },
          };
          return await updater(store);
        });
        mocks.agentCommand.mockResolvedValue({
          payloads: [{ text: "ok" }],
          meta: { durationMs: 100 },
        });
        const context = makeContext();
        const baseClient = requireValue(backendGatewayClient(), "expected backend client");
        const commandCallCount = mocks.agentCommand.mock.calls.length;
        const respond = vi.fn();

        await invokeAgent(
          {
            message: "background plugin subagent task",
            sessionKey: childSessionKey,
            idempotencyKey: runId,
          },
          {
            context,
            reqId: runId,
            respond,
            client: {
              connect: baseClient.connect,
              internal: {
                ...baseClient.internal,
                agentRunTracking: "plugin_subagent",
                pluginRuntimeOwnerId: "memory-core",
              },
            },
          },
        );

        expect(persistSubagentRunsToDiskOrThrow).toHaveBeenCalledTimes(1);
        expect(mocks.agentCommand).toHaveBeenCalledTimes(commandCallCount);
        expect(findTaskByRunId(runId)).toBeUndefined();
        expectRespondError(respond, {
          code: ErrorCodes.UNAVAILABLE,
          message:
            "plugin subagent registry persistence failed; run was not started | disk full | SQLITE_FULL",
        });
        expect(context.logGateway.warn).toHaveBeenCalledWith(
          expect.stringContaining("rejecting untracked dispatch"),
        );

        resetSubagentRegistryForTests({ persist: false });
        const pausedRunId = "plugin-subagent-paused-before-persistence-failure";
        addSubagentRunForTests({
          runId: pausedRunId,
          childSessionKey,
          requesterSessionKey: "agent:main:telegram:direct:777",
          requesterDisplayKey: "agent:main:telegram:direct:777",
          task: "wait for the remote job",
          endedAt: 2_000,
          pauseReason: "sessions_yield",
          expectsCompletionMessage: true,
        });
        persistSubagentRunsToDiskOrThrow.mockImplementationOnce(() => {
          throw new Error("disk full during paused-run adoption");
        });
        const adoptionRunId = "plugin-subagent-adoption-registry-fail";
        const adoptionRespond = vi.fn();
        await invokeAgent(
          {
            message: "the remote job finished",
            sessionKey: childSessionKey,
            idempotencyKey: adoptionRunId,
          },
          {
            context,
            reqId: adoptionRunId,
            respond: adoptionRespond,
            client: {
              connect: baseClient.connect,
              internal: {
                ...baseClient.internal,
                agentRunTracking: "plugin_subagent",
                pluginRuntimeOwnerId: "memory-core",
              },
            },
          },
        );

        expect(mocks.agentCommand).toHaveBeenCalledTimes(commandCallCount);
        expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
          runId: pausedRunId,
          pauseReason: "sessions_yield",
        });
        expect(getSubagentRunByChildSessionKey(childSessionKey)?.runId).not.toBe(adoptionRunId);
        expectRespondError(adoptionRespond, {
          code: ErrorCodes.UNAVAILABLE,
          message:
            "plugin subagent registry persistence failed; run was not started | disk full during paused-run adoption",
        });

        resetSubagentRegistryForTests({ persist: false });
        const retryRunId = "plugin-subagent-registry-retry";
        await invokeAgent(
          {
            message: "retry background plugin subagent task",
            sessionKey: childSessionKey,
            idempotencyKey: retryRunId,
          },
          {
            context,
            reqId: retryRunId,
            client: {
              connect: baseClient.connect,
              internal: {
                ...baseClient.internal,
                agentRunTracking: "plugin_subagent",
                pluginRuntimeOwnerId: "memory-core",
              },
            },
          },
        );

        expect(persistSubagentRunsToDiskOrThrow.mock.calls.length).toBeGreaterThan(1);
        await waitForAssertion(() => {
          expect(mocks.agentCommand).toHaveBeenCalledTimes(commandCallCount + 1);
          const retryRun = requireValue(
            getSubagentRunByChildSessionKey(childSessionKey),
            "expected retry plugin subagent run",
          );
          expect(retryRun.runId).toBe(retryRunId);
        });
      },
    );
  });

  it("terminalizes failed async gateway agent runs in the shared task registry", async () => {
    await withTestDir({ prefix: "openclaw-gateway-agent-task-error-" }, async (root) => {
      useTestStateDir(root);
      resetAgentTaskRegistryForTests();
      primeMainAgentRun();
      mocks.agentCommand.mockRejectedValueOnce(new Error("agent unavailable"));
      const commandCallCount = mocks.agentCommand.mock.calls.length;

      await invokeAgent(
        {
          message: "background cli task",
          sessionKey: "agent:main:main",
          idempotencyKey: "task-registry-agent-run-error",
        },
        { reqId: "task-registry-agent-run-error" },
      );
      await waitForAgentCommandCallAfter(commandCallCount);

      await waitForAssertion(() => {
        expectRecordFields(findTaskByRunId("task-registry-agent-run-error"), {
          runtime: "cli",
          childSessionKey: "agent:main:main",
          status: "failed",
          error: "agent unavailable",
        });
      });
    });
  });

  it("preserves aborted async gateway agent runs as cancelled", async () => {
    await withTestDir({ prefix: "openclaw-gateway-agent-task-aborted-" }, async (root) => {
      useTestStateDir(root);
      resetAgentTaskRegistryForTests();
      primeMainAgentRun();
      mocks.agentCommand.mockResolvedValueOnce({
        payloads: [],
        meta: { durationMs: 100, aborted: true },
      });
      const context = makeContext();
      const commandCallCount = mocks.agentCommand.mock.calls.length;

      await invokeAgent(
        {
          message: "background cli task",
          sessionKey: "agent:main:main",
          idempotencyKey: "task-registry-agent-run-aborted",
        },
        { context, reqId: "task-registry-agent-run-aborted" },
      );
      await waitForAgentCommandCallAfter(commandCallCount);

      await waitForAssertion(() => {
        expectRecordFields(findTaskByRunId("task-registry-agent-run-aborted"), {
          runtime: "cli",
          childSessionKey: "agent:main:main",
          status: "cancelled",
          terminalSummary: "aborted",
        });
        expectRecordFields(context.dedupe.get("agent:task-registry-agent-run-aborted")?.payload, {
          runId: "task-registry-agent-run-aborted",
          status: "timeout",
          summary: "aborted",
        });
      });
    });
  });

  it("projects a nonterminal tool-use result past the explicit deadline as timed out", async () => {
    const abortController = new AbortController();
    const timeoutReason = new Error("chat run timed out");
    timeoutReason.name = "TimeoutError";
    mocks.agentCommand.mockImplementationOnce(async () => {
      abortController.abort(timeoutReason);
      return {
        payloads: [{ text: "Exec failed", isError: true }],
        meta: {
          durationMs: 602_530,
          aborted: false,
          replayInvalid: true,
          livenessState: "working",
          stopReason: "toolUse",
          completion: { stopReason: "toolUse", finishReason: "toolUse" },
        },
      };
    });
    const context = makeContext();
    const respond = vi.fn();
    const onSettled = vi.fn(() => true);

    await dispatchAgentRunFromGateway({
      admittedRunEntry: undefined,
      ingressOpts: {
        message: "review the repository",
        sessionKey: "agent:main:main",
        timeout: "600",
        allowModelOverride: false,
      },
      runId: "agent-run-tool-use-deadline",
      dedupeKeys: ["agent:agent-run-tool-use-deadline"],
      abortController,
      cleanupAbortController: vi.fn(),
      io: createAgentTurnIo(respond),
      context,
      taskTrackingMode: "none",
      onSettled,
    });

    expect(onSettled).toHaveBeenCalledWith({
      terminalOutcome: expect.objectContaining({
        status: "timeout",
        stopReason: "timeout",
      }),
      onRecovered: expect.any(Function),
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        runId: "agent-run-tool-use-deadline",
        status: "timeout",
        summary: "aborted",
        stopReason: "timeout",
      }),
      undefined,
      { runId: "agent-run-tool-use-deadline" },
    );
  });

  it("projects a provider timeout result without an abort flag or stop reason as timed out", async () => {
    mocks.agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "Request timed out before a response was generated.", isError: true }],
      meta: {
        durationMs: 30_454,
        aborted: false,
        replayInvalid: true,
        livenessState: "working",
        timeoutPhase: "provider",
        providerStarted: true,
        error: {
          kind: "incomplete_turn",
          message: "Request timed out before a response was generated.",
        },
      },
    });
    const context = makeContext();
    const respond = vi.fn();
    const onSettled = vi.fn(() => true);

    await dispatchAgentRunFromGateway({
      admittedRunEntry: undefined,
      ingressOpts: {
        message: "run a command that exceeds the provider deadline",
        sessionKey: "agent:main:main",
        timeout: "10",
        allowModelOverride: false,
      },
      runId: "agent-run-provider-timeout-result",
      dedupeKeys: ["agent:agent-run-provider-timeout-result"],
      abortController: new AbortController(),
      cleanupAbortController: vi.fn(),
      io: createAgentTurnIo(respond),
      context,
      taskTrackingMode: "none",
      onSettled,
    });

    expect(onSettled).toHaveBeenCalledWith({
      terminalOutcome: expect.objectContaining({
        status: "timeout",
        reason: "hard_timeout",
        timeoutPhase: "provider",
        providerStarted: true,
      }),
      onRecovered: expect.any(Function),
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        runId: "agent-run-provider-timeout-result",
        status: "timeout",
        summary: "aborted",
        timeoutPhase: "provider",
        providerStarted: true,
      }),
      undefined,
      { runId: "agent-run-provider-timeout-result" },
    );
  });

  it("projects a resolved agent error as a failed gateway response", async () => {
    mocks.agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "Provider rejected the request.", isError: true }],
      meta: {
        error: { kind: "incomplete_turn", message: "provider rejected the request" },
        stopReason: "error",
      },
    });
    const context = makeContext();
    const respond = vi.fn();
    const onSettled = vi.fn(() => true);

    await dispatchAgentRunFromGateway({
      admittedRunEntry: undefined,
      ingressOpts: {
        message: "run the agent",
        sessionKey: "agent:main:main",
        timeout: "600",
        allowModelOverride: false,
      },
      runId: "agent-run-resolved-error",
      dedupeKeys: ["agent:agent-run-resolved-error"],
      abortController: new AbortController(),
      cleanupAbortController: vi.fn(),
      io: createAgentTurnIo(respond),
      context,
      taskTrackingMode: "none",
      onSettled,
    });

    expect(onSettled).toHaveBeenCalledWith({
      terminalOutcome: expect.objectContaining({
        status: "error",
        reason: "failed",
        stopReason: "error",
      }),
      onRecovered: expect.any(Function),
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        runId: "agent-run-resolved-error",
        status: "error",
        summary: "failed",
        stopReason: "error",
      }),
      undefined,
      { runId: "agent-run-resolved-error" },
    );
  });

  it("projects a recorded failed dispatch outcome through agent.wait", async () => {
    mocks.agentCommand.mockResolvedValueOnce(
      recordAgentRunTerminalOutcome(
        {
          payloads: [{ text: "Device worker unavailable.", isError: true }],
          meta: {},
        },
        "failed",
      ),
    );
    const context = makeContext();
    const respond = vi.fn();
    const onSettled = vi.fn(() => true);
    const runId = "agent-run-recorded-dispatch-failure";

    await dispatchAgentRunFromGateway({
      admittedRunEntry: undefined,
      ingressOpts: {
        message: "run on the unavailable device",
        sessionKey: "agent:main:main",
        timeout: "600",
        allowModelOverride: false,
      },
      runId,
      dedupeKeys: [`agent:${runId}`],
      abortController: new AbortController(),
      cleanupAbortController: vi.fn(),
      io: createAgentTurnIo(respond),
      context,
      taskTrackingMode: "none",
      onSettled,
    });

    expect(onSettled).toHaveBeenCalledWith({
      terminalOutcome: expect.objectContaining({ status: "error", reason: "failed" }),
      onRecovered: expect.any(Function),
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ runId, status: "error", summary: "failed" }),
      undefined,
      { runId },
    );
    await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toMatchObject({
      status: "error",
    });
  });

  it.each([
    {
      name: "resolved failure",
      timeout: false,
      recordedError: undefined,
      expectedError: "Provider rejected this request.",
    },
    {
      name: "resolved timeout",
      timeout: true,
      recordedError: undefined,
      expectedError: "Request timed out before a response was generated.",
    },
    {
      name: "producer lifecycle guidance",
      timeout: false,
      recordedError: "Reconnect the selected provider, then try again.",
      expectedError: "Reconnect the selected provider, then try again.",
    },
  ])("retains the $name diagnostic on the tracked task", async (scenario) => {
    await withTestDir({ prefix: "openclaw-agent-task-diagnostic-" }, async (root) => {
      useTestStateDir(root);
      resetAgentTaskRegistryForTests();
      primeMainAgentRun();
      const runId = `task-diagnostic-${scenario.name}`;
      mocks.agentCommand.mockResolvedValueOnce(
        recordAgentRunTerminalOutcome(
          {
            payloads: [],
            meta: {
              durationMs: 1,
              error: {
                kind: "incomplete_turn",
                message: scenario.recordedError ? "Agent run failed" : scenario.expectedError,
              },
              ...(scenario.timeout
                ? { timeoutPhase: "provider", providerStarted: true }
                : { stopReason: "error" }),
            },
          },
          "failed",
          scenario.recordedError,
        ),
      );
      await invokeAgent(
        {
          message: "Run this tracked request.",
          sessionKey: "agent:main:main",
          idempotencyKey: runId,
        },
        { context: makeContext(), reqId: runId },
      );
      await waitForAssertion(() =>
        expect(findTaskByRunId(runId)).toMatchObject({
          status: scenario.timeout ? "timed_out" : "failed",
          error: scenario.expectedError,
        }),
      );
    });
  });

  it.each([
    {
      label: "tool use past the nominal deadline without an abort signal",
      durationMs: 602_530,
      stopReason: "toolUse",
      timeout: "600",
      abortReason: undefined,
    },
    {
      label: "tool use before the deadline",
      durationMs: 599_999,
      stopReason: "toolUse",
      timeout: "600",
      abortReason: undefined,
    },
    {
      label: "tool use with the deadline disabled",
      durationMs: 602_530,
      stopReason: "toolUse",
      timeout: "0",
      abortReason: undefined,
    },
    {
      label: "final assistant reply after deadline cleanup",
      durationMs: 602_530,
      stopReason: "stop",
      timeout: "600",
      abortReason: "timeout" as const,
    },
    {
      label: "nonterminal tool use after RPC abort cleanup",
      durationMs: 100,
      stopReason: "toolUse",
      timeout: "600",
      abortReason: "rpc" as const,
    },
    {
      label: "nonterminal tool use after restart abort cleanup",
      durationMs: 100,
      stopReason: "toolUse",
      timeout: "600",
      abortReason: "restart" as const,
    },
  ])("keeps $label successful", async ({ durationMs, stopReason, timeout, abortReason }) => {
    const abortController = new AbortController();
    mocks.agentCommand.mockImplementationOnce(async () => {
      if (abortReason === "timeout") {
        const timeoutReason = new Error("chat run timed out");
        timeoutReason.name = "TimeoutError";
        abortController.abort(timeoutReason);
      } else if (abortReason === "rpc") {
        abortController.abort();
      } else if (abortReason === "restart") {
        abortController.abort(createAgentRunRestartAbortError());
      }
      return {
        payloads: [{ text: "done" }],
        meta: { durationMs, aborted: false, stopReason },
      };
    });
    const context = makeContext();
    const respond = vi.fn();

    await dispatchAgentRunFromGateway({
      admittedRunEntry: undefined,
      ingressOpts: {
        message: "review the repository",
        sessionKey: "agent:main:main",
        timeout,
        allowModelOverride: false,
      },
      runId: `agent-run-deadline-control-${stopReason}-${durationMs}`,
      dedupeKeys: [`agent:deadline-control-${stopReason}-${durationMs}`],
      abortController,
      cleanupAbortController: vi.fn(),
      io: createAgentTurnIo(respond),
      context,
      taskTrackingMode: "none",
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "ok", summary: "completed" }),
      undefined,
      expect.any(Object),
    );
  });

  it("classifies RPC-aborted async gateway agent rejections as cancelled", async () => {
    await withTestDir({ prefix: "openclaw-gateway-agent-task-abort-error-" }, async (root) => {
      useTestStateDir(root);
      resetAgentTaskRegistryForTests();
      primeMainAgentRun();
      const abortError = new Error("This operation was aborted");
      abortError.name = "AbortError";
      const context = makeContext();
      const runId = "task-registry-agent-run-abort-error";
      mocks.agentCommand.mockImplementationOnce(() => {
        context.chatAbortControllers.get(runId)?.controller.abort();
        return Promise.reject(abortError);
      });

      await invokeAgent(
        {
          message: "background cli task",
          sessionKey: "agent:main:main",
          idempotencyKey: runId,
        },
        { context, reqId: runId },
      );

      await waitForAssertion(() => {
        expectRecordFields(findTaskByRunId("task-registry-agent-run-abort-error"), {
          runtime: "cli",
          childSessionKey: "agent:main:main",
          status: "cancelled",
          error: "This operation was aborted",
        });
        expectRecordFields(
          context.dedupe.get("agent:task-registry-agent-run-abort-error")?.payload,
          {
            runId: "task-registry-agent-run-abort-error",
            status: "timeout",
            summary: "aborted",
            stopReason: "rpc",
          },
        );
        expect(
          context.dedupe.get("agent:task-registry-agent-run-abort-error")?.payload,
        ).not.toHaveProperty("timeoutPhase");
      });
    });
  });

  it("classifies an unsignaled AbortError task as cancelled without changing failure status", async () => {
    await withTestDir({ prefix: "openclaw-gateway-agent-task-plain-abort-" }, async (root) => {
      useTestStateDir(root);
      resetAgentTaskRegistryForTests();
      primeMainAgentRun();
      const abortError = new Error("This operation was aborted");
      abortError.name = "AbortError";
      const context = makeContext();
      const runId = "task-registry-agent-run-plain-abort";
      mocks.agentCommand.mockRejectedValueOnce(abortError);

      await invokeAgent(
        {
          message: "background cli task",
          sessionKey: "agent:main:main",
          idempotencyKey: runId,
        },
        { context, reqId: runId },
      );

      await waitForAssertion(() => {
        expectRecordFields(findTaskByRunId(runId), {
          runtime: "cli",
          childSessionKey: "agent:main:main",
          status: "cancelled",
          error: "This operation was aborted",
        });
        expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
          runId,
          status: "error",
          summary: "This operation was aborted",
        });
        expect(context.dedupe.get(`agent:${runId}`)?.ok).toBe(false);
      });
    });
  });

  it("preserves restart ownership for aborted async gateway agent rejections", async () => {
    await withTestDir({ prefix: "openclaw-gateway-agent-task-restart-abort-" }, async (root) => {
      useTestStateDir(root);
      resetAgentTaskRegistryForTests();
      primeMainAgentRun();
      const abortError = createAgentRunRestartAbortError();
      const wrappedError = new Error("ACP turn failed before completion", {
        cause: abortError,
      });
      wrappedError.name = "AcpRuntimeError";
      const context = makeContext();
      const runId = "task-registry-agent-run-restart-abort";
      mocks.agentCommand.mockImplementationOnce(() => {
        context.chatAbortControllers.get(runId)?.controller.abort(abortError);
        return Promise.reject(wrappedError);
      });

      await invokeAgent(
        {
          message: "background cli task",
          sessionKey: "agent:main:main",
          idempotencyKey: runId,
        },
        { context, reqId: runId },
      );

      await waitForAssertion(() => {
        expectRecordFields(findTaskByRunId(runId), {
          status: "cancelled",
        });
        expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
          runId,
          status: "timeout",
          summary: "aborted",
          stopReason: "restart",
          timeoutPhase: "gateway_draining",
        });
      });
    });
  });

  it("classifies timeout async gateway agent rejections as timed out", async () => {
    await withTestDir({ prefix: "openclaw-gateway-agent-task-timeout-error-" }, async (root) => {
      useTestStateDir(root);
      resetAgentTaskRegistryForTests();
      primeMainAgentRun();
      const timeoutError = new Error("chat run timed out");
      timeoutError.name = "TimeoutError";
      const context = makeContext();
      const runId = "task-registry-agent-run-timeout-error";
      mocks.agentCommand.mockImplementationOnce(() => {
        context.chatAbortControllers.get(runId)?.controller.abort(timeoutError);
        return Promise.reject(timeoutError);
      });

      await invokeAgent(
        {
          message: "background cli task",
          sessionKey: "agent:main:main",
          idempotencyKey: runId,
        },
        { context, reqId: runId },
      );

      await waitForAssertion(() => {
        expectRecordFields(findTaskByRunId("task-registry-agent-run-timeout-error"), {
          runtime: "cli",
          childSessionKey: "agent:main:main",
          status: "timed_out",
          error: "chat run timed out",
        });
        expectRecordFields(
          context.dedupe.get("agent:task-registry-agent-run-timeout-error")?.payload,
          {
            runId: "task-registry-agent-run-timeout-error",
            status: "timeout",
            summary: "aborted",
            stopReason: "timeout",
          },
        );
        expect(
          context.dedupe.get("agent:task-registry-agent-run-timeout-error")?.payload,
        ).not.toHaveProperty("timeoutPhase");
      });
    });
  });

  it("classifies wrapped rejections after gateway timeout as timed out", async () => {
    await withTestDir(
      { prefix: "openclaw-gateway-agent-task-wrapped-timeout-error-" },
      async (root) => {
        useTestStateDir(root);
        resetAgentTaskRegistryForTests();
        primeMainAgentRun();
        const timeoutReason = new Error("chat run timed out");
        timeoutReason.name = "TimeoutError";
        const wrappedError = new Error("fallback result classified terminal abort");
        wrappedError.name = "FailoverError";
        const context = makeContext();
        const runId = "task-registry-agent-run-wrapped-timeout-error";
        mocks.agentCommand.mockImplementationOnce(() => {
          context.chatAbortControllers.get(runId)?.controller.abort(timeoutReason);
          return Promise.reject(wrappedError);
        });

        await invokeAgent(
          {
            message: "background cli task",
            sessionKey: "agent:main:main",
            idempotencyKey: runId,
          },
          { context, reqId: runId },
        );

        await waitForAssertion(() => {
          expectRecordFields(findTaskByRunId("task-registry-agent-run-wrapped-timeout-error"), {
            runtime: "cli",
            childSessionKey: "agent:main:main",
            status: "timed_out",
            error: "fallback result classified terminal abort",
          });
          expectRecordFields(
            context.dedupe.get("agent:task-registry-agent-run-wrapped-timeout-error")?.payload,
            {
              runId: "task-registry-agent-run-wrapped-timeout-error",
              status: "timeout",
              summary: "aborted",
              stopReason: "timeout",
            },
          );
          expect(
            context.dedupe.get("agent:task-registry-agent-run-wrapped-timeout-error")?.ok,
          ).toBe(true);
        });
      },
    );
  });

  it("does not hide provider timeout async gateway agent rejections", async () => {
    await withTestDir({ prefix: "openclaw-gateway-agent-task-provider-timeout-" }, async (root) => {
      useTestStateDir(root);
      resetAgentTaskRegistryForTests();
      primeMainAgentRun();
      const providerError = new Error("provider request timed out");
      providerError.name = "TimeoutError";
      mocks.agentCommand.mockRejectedValueOnce(providerError);
      const context = makeContext();

      await invokeAgent(
        {
          message: "background cli task",
          sessionKey: "agent:main:main",
          idempotencyKey: "task-registry-agent-run-provider-timeout",
        },
        { context, reqId: "task-registry-agent-run-provider-timeout" },
      );

      await waitForAssertion(() => {
        expectRecordFields(findTaskByRunId("task-registry-agent-run-provider-timeout"), {
          runtime: "cli",
          childSessionKey: "agent:main:main",
          status: "timed_out",
          error: "provider request timed out",
        });
        expectRecordFields(
          context.dedupe.get("agent:task-registry-agent-run-provider-timeout")?.payload,
          {
            runId: "task-registry-agent-run-provider-timeout",
            status: "error",
            summary: "provider request timed out",
          },
        );
        expect(context.dedupe.get("agent:task-registry-agent-run-provider-timeout")?.ok).toBe(
          false,
        );
      });
    });
  });

  it.each([
    {
      label: "completed stop",
      meta: { stopReason: "stop", providerStarted: true },
      outcome: { reason: "completed", status: "ok", stopReason: "stop", providerStarted: true },
      payload: { status: "ok", summary: "completed" },
    },
    {
      label: "completed stop with unknown timeout metadata",
      meta: {
        stopReason: "stop",
        providerStarted: true,
        timeoutPhase: "unrecognized_timeout_phase",
      },
      outcome: { reason: "completed", status: "ok", stopReason: "stop", providerStarted: true },
      payload: { status: "ok", summary: "completed" },
    },
    {
      label: "external cancellation",
      meta: {
        aborted: true,
        stopReason: "rpc",
        timeoutPhase: "queue",
        providerStarted: false,
      },
      outcome: {
        reason: "cancelled",
        status: "error",
        stopReason: "rpc",
        timeoutPhase: "queue",
        providerStarted: false,
      },
      payload: {
        status: "timeout",
        summary: "aborted",
        stopReason: "rpc",
        timeoutPhase: "queue",
        providerStarted: false,
      },
    },
    {
      label: "provider timeout",
      meta: {
        aborted: true,
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
      },
      outcome: {
        reason: "hard_timeout",
        status: "timeout",
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
      },
      payload: {
        status: "timeout",
        summary: "aborted",
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
      },
    },
  ])("settles $label from the canonical outcome without changing Gateway status", async (test) => {
    mocks.agentCommand.mockResolvedValueOnce({
      payloads: [],
      meta: { durationMs: 1, ...test.meta },
    });
    const context = makeContext();
    const onSettled = vi.fn(() => true);
    const respond = vi.fn();
    const runId = `agent-run-terminal-${test.label.replaceAll(" ", "-")}`;

    await dispatchAgentRunFromGateway({
      admittedRunEntry: undefined,
      ingressOpts: {
        message: "characterize terminal ownership",
        sessionKey: "agent:main:main",
        allowModelOverride: false,
      },
      runId,
      dedupeKeys: [`agent:${runId}`],
      abortController: new AbortController(),
      cleanupAbortController: vi.fn(),
      io: createAgentTurnIo(respond),
      context,
      taskTrackingMode: "none",
      onSettled,
    });

    expect(onSettled).toHaveBeenCalledWith({
      terminalOutcome: test.outcome,
      onRecovered: expect.any(Function),
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ runId, ...test.payload }),
      undefined,
      { runId },
    );
  });

  it("settles ordinary async gateway agent rejections as failed", async () => {
    const providerError = new Error("provider request failed");
    mocks.agentCommand.mockRejectedValueOnce(providerError);
    const context = makeContext();
    const onSettled = vi.fn(() => true);
    const respond = vi.fn();

    await dispatchAgentRunFromGateway({
      admittedRunEntry: undefined,
      ingressOpts: {
        message: "background cli task",
        sessionKey: "agent:main:main",
        allowModelOverride: false,
      },
      runId: "agent-run-provider-error-settlement",
      dedupeKeys: ["agent:agent-run-provider-error-settlement"],
      abortController: new AbortController(),
      cleanupAbortController: vi.fn(),
      io: createAgentTurnIo(respond),
      context,
      taskTrackingMode: "none",
      onSettled,
    });

    expect(onSettled).toHaveBeenCalledWith({
      terminalOutcome: {
        reason: "failed",
        status: "error",
        error: "provider request failed",
      },
      onRecovered: expect.any(Function),
    });
    expect(respond).toHaveBeenCalled();
  });

  it.each([false, true])(
    "emits provider failures and optional diagnostics without class names: %s",
    async (withDiagnostic) => {
      const message =
        "The selected model was not found by the provider. Check the model id or choose a different model.";
      const failure = new FailoverError(message, {
        reason: "model_not_found",
        provider: "ollama",
        model: "definitely-not-a-real-model:latest",
      });
      const diagnostic = "stderr: earlier request timed out; Rate limit exceeded";
      if (withDiagnostic) {
        attachErrorDiagnostic(failure, diagnostic);
      }
      const displayed = withDiagnostic ? `${message}\n${diagnostic}` : message;
      mocks.agentCommand.mockRejectedValueOnce(failure);
      const context = makeContext();
      const respond = vi.fn();
      const runId = "agent-run-model-not-found";

      await dispatchAgentRunFromGateway({
        admittedRunEntry: undefined,
        ingressOpts: {
          message: "hi",
          sessionKey: "agent:badmodel:main",
          allowModelOverride: false,
        },
        runId,
        dedupeKeys: [`agent:${runId}`],
        abortController: new AbortController(),
        cleanupAbortController: vi.fn(),
        io: createAgentTurnIo(respond),
        context,
        taskTrackingMode: "none",
      });

      expect(respond).toHaveBeenCalledWith(
        false,
        { runId, status: "error", summary: message },
        expect.objectContaining({ code: ErrorCodes.UNAVAILABLE, message }),
        { runId, error: message },
      );
      expect(context.dedupe.get(`agent:${runId}`)?.error?.message).toBe(message);
      expect(failure.message).toBe(message);
      expect(failure.reason).toBe("model_not_found");
      await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toMatchObject({
        status: "error",
        error: displayed,
      });
    },
  );

  registerAgentTaskCancellationTests();

  it("does not let --agent force the agent main session when --session-id is provided", async () => {
    mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:main:main");
    primeMainAgentRun({ sessionId: "resume-whatsapp-session" });

    await invokeAgent(
      {
        message: "resume channel session",
        agentId: "main",
        sessionId: "resume-whatsapp-session",
        idempotencyKey: "session-id-agent-resume",
      },
      { reqId: "session-id-agent-resume" },
    );

    const call = await waitForAgentCommandCall<{
      agentId?: string;
      sessionId?: string;
      sessionKey?: string;
    }>();
    expect(call.agentId).toBe("main");
    expect(call.sessionId).toBe("resume-whatsapp-session");
    expect(call.sessionKey).toBeUndefined();
  });

  it("treats whitespace sessionId as absent before resolving the agent session key", async () => {
    mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:main:main");
    primeMainAgentRun();

    await invokeAgent(
      {
        message: "resume main",
        agentId: "main",
        sessionId: "   ",
        idempotencyKey: "blank-session-id-agent-resume",
      },
      { reqId: "blank-session-id-agent-resume" },
    );

    const call = await waitForAgentCommandCall<{
      agentId?: string;
      sessionId?: string;
      sessionKey?: string;
    }>();
    expect(call.agentId).toBe("main");
    expect(call.sessionId).toBe("existing-session-id");
    expect(call.sessionKey).toBe("agent:main:main");
  });

  it("uses an agent-scoped to value as the gateway session selector", async () => {
    const sessionKey = "agent:main:openclaw-weixin:direct:o9cq802hhmfc@im.wechat";
    mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:main:main");
    mocks.loadSessionEntry.mockImplementation((key: string) => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: key === sessionKey ? "wechat-session-id" : "main-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: key,
    }));
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, Record<string, unknown>> = {
        "agent:main:main": { sessionId: "main-session-id", updatedAt: Date.now() },
        [sessionKey]: { sessionId: "wechat-session-id", updatedAt: Date.now() },
      };
      return await updater(store);
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "callback result",
        to: sessionKey,
        idempotencyKey: "wechat-session-key-to",
      },
      { reqId: "wechat-session-key-to" },
    );

    const call = await waitForAgentCommandCall<{
      sessionId?: string;
      sessionKey?: string;
      to?: string;
    }>();
    expect(call.sessionId).toBe("wechat-session-id");
    expect(call.sessionKey).toBe(sessionKey);
    expect(call.to).toBeUndefined();
  });

  it("rolls stale gateway agent sessions even when updatedAt was recently touched", async () => {
    const now = Date.parse("2026-04-25T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:main:main");
      mockMainSessionEntry(
        {
          sessionId: "stale-session-id",
          updatedAt: now,
          sessionStartedAt: now - 25 * 60 * 60_000,
          lastInteractionAt: now - 25 * 60 * 60_000,
        },
        {
          session: {
            reset: {
              mode: "daily",
              atHour: 4,
            },
          },
        },
      );
      const loaded = mocks.loadSessionEntry();
      let capturedEntry: Record<string, unknown> | undefined;
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        const store: Record<string, unknown> = {
          [loaded.canonicalKey]: structuredClone(loaded.entry),
        };
        const result = await updater(store);
        capturedEntry = result as Record<string, unknown>;
        return result;
      });
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });

      const broadcastToConnIds = vi.fn();
      await invokeAgent(
        {
          message: "daily rollover",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: "daily-rollover-agent-session",
        },
        {
          reqId: "daily-rollover-agent-session",
          context: {
            ...makeContext(),
            broadcastToConnIds,
            getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
          },
        },
      );

      const call = await waitForAgentCommandCall<{
        sessionId?: string;
        sessionKey?: string;
      }>();
      expect(call.sessionKey).toBe("agent:main:main");
      expect(call.sessionId).not.toBe("stale-session-id");
      expect(capturedEntry?.sessionStartedAt).toBe(now);
      expect(capturedEntry?.lastInteractionAt).toBe(now);
      expect(mocks.emitGatewaySessionEndPluginHook).toHaveBeenCalledTimes(1);
      expectRecordFields(
        mockCallArg(mocks.emitGatewaySessionEndPluginHook) as Record<string, unknown>,
        {
          sessionKey: "agent:main:main",
          sessionId: "stale-session-id",
          reason: "daily",
          storePath: "/tmp/sessions.json",
          nextSessionId: call.sessionId,
          nextSessionKey: "agent:main:main",
        },
      );
      expect(mocks.emitGatewaySessionStartPluginHook).toHaveBeenCalledTimes(1);
      expectRecordFields(
        mockCallArg(mocks.emitGatewaySessionStartPluginHook) as Record<string, unknown>,
        {
          sessionKey: "agent:main:main",
          sessionId: call.sessionId,
          resumedFrom: "stale-session-id",
          storePath: "/tmp/sessions.json",
        },
      );
      await vi.advanceTimersByTimeAsync(100);
      expect(broadcastToConnIds.mock.calls.map((callValue) => callValue[1]?.reason)).toEqual([
        "create",
        "agent.input.settled",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a provider-owned CLI session across the daily default boundary on the gateway path", async () => {
    const now = Date.parse("2026-04-25T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:main:main");
      mockMainSessionEntry({
        sessionId: "provider-owned-session-id",
        updatedAt: now,
        sessionStartedAt: now - 25 * 60 * 60_000,
        lastInteractionAt: now - 25 * 60 * 60_000,
        modelProvider: "claude-cli",
        cliSessionBindings: { "claude-cli": { sessionId: "claude-cli-conversation-123" } },
      });
      const loaded = mocks.loadSessionEntry();
      let capturedEntry: Record<string, unknown> | undefined;
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        const store: Record<string, unknown> = {
          [loaded.canonicalKey]: structuredClone(loaded.entry),
        };
        const result = await updater(store);
        capturedEntry = result as Record<string, unknown>;
        return result;
      });
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });

      await invokeAgent(
        {
          message: "provider-owned daily boundary",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: "provider-owned-daily-boundary",
        },
        { reqId: "provider-owned-daily-boundary" },
      );

      const call = await waitForAgentCommandCall<{
        sessionId?: string;
        sessionKey?: string;
      }>();
      expect(call.sessionKey).toBe("agent:main:main");
      expect(call.sessionId).toBe("provider-owned-session-id");
      expect(capturedEntry?.sessionStartedAt).toBe(now - 25 * 60 * 60_000);
      expect(capturedEntry?.cliSessionBindings).toMatchObject({
        "claude-cli": { sessionId: "claude-cli-conversation-123" },
      });
      expect(mocks.emitGatewaySessionEndPluginHook).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a model-locked session across configured gateway expiry", async () => {
    const now = Date.parse("2026-04-25T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:main:main");
      mockMainSessionEntry(
        {
          sessionId: "model-locked-session-id",
          updatedAt: now,
          sessionStartedAt: now - 25 * 60 * 60_000,
          lastInteractionAt: now - 25 * 60 * 60_000,
          agentHarnessId: "codex",
          modelSelectionLocked: true,
        },
        {
          session: {
            reset: {
              mode: "daily",
              atHour: 4,
            },
          },
        },
      );
      const loaded = mocks.loadSessionEntry();
      let capturedEntry: Record<string, unknown> | undefined;
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        const store: Record<string, unknown> = {
          [loaded.canonicalKey]: structuredClone(loaded.entry),
        };
        const result = await updater(store);
        capturedEntry = result as Record<string, unknown>;
        return result;
      });
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });

      await invokeAgent(
        {
          message: "model-locked daily boundary",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: "model-locked-daily-boundary",
        },
        { reqId: "model-locked-daily-boundary" },
      );

      const call = await waitForAgentCommandCall<{
        sessionId?: string;
        sessionKey?: string;
      }>();
      expect(call.sessionKey).toBe("agent:main:main");
      expect(call.sessionId).toBe("model-locked-session-id");
      expect(capturedEntry?.sessionStartedAt).toBe(now - 25 * 60 * 60_000);
      expect(capturedEntry?.modelSelectionLocked).toBe(true);
      expect(mocks.emitGatewaySessionEndPluginHook).not.toHaveBeenCalled();
      expect(mocks.emitGatewaySessionStartPluginHook).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits idle lifecycle reason when inactivity rotates a gateway agent session", async () => {
    const now = Date.parse("2026-04-25T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:main:main");
      mockMainSessionEntry(
        {
          sessionId: "idle-session-id",
          updatedAt: now,
          sessionStartedAt: now,
          lastInteractionAt: now - 60 * 60_000,
        },
        {
          session: {
            reset: {
              mode: "idle",
              idleMinutes: 5,
            },
          },
        },
      );
      const loaded = mocks.loadSessionEntry();
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        const store: Record<string, unknown> = {
          [loaded.canonicalKey]: structuredClone(loaded.entry),
        };
        return updater(store);
      });
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });

      await invokeAgent(
        {
          message: "idle rollover",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: "idle-rollover-agent-session",
        },
        { reqId: "idle-rollover-agent-session" },
      );

      const call = await waitForAgentCommandCall<{
        sessionId?: string;
        sessionKey?: string;
      }>();
      expect(call.sessionKey).toBe("agent:main:main");
      expect(call.sessionId).not.toBe("idle-session-id");
      expectRecordFields(
        mockCallArg(mocks.emitGatewaySessionEndPluginHook) as Record<string, unknown>,
        {
          sessionKey: "agent:main:main",
          sessionId: "idle-session-id",
          reason: "idle",
          nextSessionId: call.sessionId,
          nextSessionKey: "agent:main:main",
        },
      );
      expectRecordFields(
        mockCallArg(mocks.emitGatewaySessionStartPluginHook) as Record<string, unknown>,
        {
          sessionKey: "agent:main:main",
          sessionId: call.sessionId,
          resumedFrom: "idle-session-id",
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits lifecycle hooks when a committed rotation later fails delivery validation", async () => {
    const now = Date.parse("2026-04-25T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:main:main");
      mockMainSessionEntry(
        {
          sessionId: "stale-before-validation-id",
          updatedAt: now,
          sessionStartedAt: now - 25 * 60 * 60_000,
          lastInteractionAt: now - 25 * 60 * 60_000,
        },
        {
          session: {
            reset: {
              mode: "daily",
              atHour: 4,
            },
          },
        },
      );
      const loaded = mocks.loadSessionEntry();
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        const store: Record<string, unknown> = {
          [loaded.canonicalKey]: structuredClone(loaded.entry),
        };
        return updater(store);
      });
      mocks.agentCommand.mockClear();
      const respond = vi.fn();

      await invokeAgent(
        {
          message: "strict missing delivery target after rollover",
          agentId: "main",
          sessionKey: "agent:main:main",
          deliver: true,
          replyChannel: "telegram",
          bestEffortDeliver: false,
          idempotencyKey: "lifecycle-before-delivery-validation",
        },
        {
          reqId: "lifecycle-before-delivery-validation",
          respond,
          flushDispatch: false,
        },
      );

      expect(mocks.agentCommand).not.toHaveBeenCalled();
      const error = expectRespondError(respond, {});
      expectStringFieldContains(error, "message", "requires target");
      expect(mocks.emitGatewaySessionEndPluginHook).toHaveBeenCalledTimes(1);
      expectRecordFields(
        mockCallArg(mocks.emitGatewaySessionEndPluginHook) as Record<string, unknown>,
        {
          sessionKey: "agent:main:main",
          sessionId: "stale-before-validation-id",
          reason: "daily",
        },
      );
      expect(mocks.emitGatewaySessionStartPluginHook).toHaveBeenCalledTimes(1);
      expectRecordFields(
        mockCallArg(mocks.emitGatewaySessionStartPluginHook) as Record<string, unknown>,
        {
          sessionKey: "agent:main:main",
          resumedFrom: "stale-before-validation-id",
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits lifecycle hooks and sessions.changed when an explicit sessionId replaces a fresh session", async () => {
    const now = Date.parse("2026-04-25T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      mockMainSessionEntry({
        sessionId: "current-session-id",
        updatedAt: now,
        sessionStartedAt: now,
        lastInteractionAt: now,
      });
      const loaded = mocks.loadSessionEntry();
      let capturedEntry: Record<string, unknown> | undefined;
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        const store: Record<string, unknown> = {
          [loaded.canonicalKey]: structuredClone(loaded.entry),
        };
        const result = await updater(store);
        capturedEntry = result as Record<string, unknown>;
        return result;
      });
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });

      const broadcastToConnIds = vi.fn();
      await invokeAgent(
        {
          message: "explicit replacement",
          agentId: "main",
          sessionKey: "agent:main:main",
          sessionId: "caller-selected-session-id",
          idempotencyKey: "explicit-replacement-agent-session",
        },
        {
          reqId: "explicit-replacement-agent-session",
          context: {
            ...makeContext(),
            broadcastToConnIds,
            getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
          },
        },
      );

      const call = await waitForAgentCommandCall<{
        sessionId?: string;
        sessionKey?: string;
      }>();
      expect(call.sessionKey).toBe("agent:main:main");
      expect(call.sessionId).toBe("caller-selected-session-id");
      expect(capturedEntry?.sessionId).toBe("caller-selected-session-id");
      expect(capturedEntry?.sessionStartedAt).toBe(now);
      expect(mocks.emitGatewaySessionEndPluginHook).toHaveBeenCalledTimes(1);
      expectRecordFields(
        mockCallArg(mocks.emitGatewaySessionEndPluginHook) as Record<string, unknown>,
        {
          sessionKey: "agent:main:main",
          sessionId: "current-session-id",
          reason: "new",
          storePath: "/tmp/sessions.json",
          nextSessionId: "caller-selected-session-id",
          nextSessionKey: "agent:main:main",
        },
      );
      expect(mocks.emitGatewaySessionStartPluginHook).toHaveBeenCalledTimes(1);
      expectRecordFields(
        mockCallArg(mocks.emitGatewaySessionStartPluginHook) as Record<string, unknown>,
        {
          sessionKey: "agent:main:main",
          sessionId: "caller-selected-session-id",
          resumedFrom: "current-session-id",
          storePath: "/tmp/sessions.json",
        },
      );
      await vi.advanceTimersByTimeAsync(100);
      expect(broadcastToConnIds.mock.calls.map((callLocal) => callLocal[1]?.reason)).toEqual([
        "create",
        "agent.input.settled",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let explicit sessionId bypass stale gateway session freshness", async () => {
    const now = Date.parse("2026-04-25T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:main:main");
      mockMainSessionEntry(
        {
          sessionId: "stale-session-id",
          updatedAt: now,
          sessionStartedAt: now - 25 * 60 * 60_000,
          lastInteractionAt: now - 25 * 60 * 60_000,
        },
        {
          session: {
            reset: {
              mode: "daily",
              atHour: 4,
            },
          },
        },
      );
      const loaded = mocks.loadSessionEntry();
      let capturedEntry: Record<string, unknown> | undefined;
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        const store: Record<string, unknown> = {
          [loaded.canonicalKey]: structuredClone(loaded.entry),
        };
        const result = await updater(store);
        capturedEntry = result as Record<string, unknown>;
        return result;
      });
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });

      await invokeAgent(
        {
          message: "daily rollover",
          agentId: "main",
          sessionKey: "agent:main:main",
          sessionId: "stale-session-id",
          idempotencyKey: "daily-rollover-agent-session-id",
        },
        { reqId: "daily-rollover-agent-session-id" },
      );

      const call = await waitForAgentCommandCall<{
        sessionId?: string;
        sessionKey?: string;
      }>();
      expect(call.sessionKey).toBe("agent:main:main");
      expect(call.sessionId).not.toBe("stale-session-id");
      expect(capturedEntry?.sessionStartedAt).toBe(now);
      expect(capturedEntry?.lastInteractionAt).toBe(now);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pins a backend continuation to its expected stale session", async () => {
    const now = Date.parse("2026-04-25T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:main:main");
      mockMainSessionEntry(
        {
          sessionId: "expected-stale-session-id",
          updatedAt: now,
          sessionStartedAt: now - 25 * 60 * 60_000,
          lastInteractionAt: now - 25 * 60 * 60_000,
        },
        {
          session: {
            reset: {
              mode: "daily",
              atHour: 4,
            },
          },
        },
      );
      const loaded = mocks.loadSessionEntry();
      let capturedEntry: Record<string, unknown> | undefined;
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        const store: Record<string, unknown> = {
          [loaded.canonicalKey]: structuredClone(loaded.entry),
        };
        const result = await updater(store);
        capturedEntry = result as Record<string, unknown>;
        return result;
      });
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });

      await invokeAgent(
        {
          message: "resume exact stale session",
          agentId: "main",
          sessionKey: "agent:main:main",
          expectedExistingSessionId: "expected-stale-session-id",
          idempotencyKey: "expected-stale-agent-session",
        },
        {
          reqId: "expected-stale-agent-session",
          client: backendGatewayClient(),
        },
      );

      const call = await waitForAgentCommandCall<{
        sessionId?: string;
        sessionKey?: string;
      }>();
      expect(call.sessionKey).toBe("agent:main:main");
      expect(call.sessionId).toBe("expected-stale-session-id");
      expect(capturedEntry?.sessionId).toBe("expected-stale-session-id");
      expect(mocks.emitGatewaySessionEndPluginHook).not.toHaveBeenCalled();
      expect(mocks.emitGatewaySessionStartPluginHook).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("forwards the selected agent id with canonical global session keys", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "ops"]);
    mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:ops:main");
    mocks.loadSessionEntry.mockReturnValue({
      cfg: { session: { scope: "global" } },
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "global-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "global",
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        global: { sessionId: "global-session-id", updatedAt: Date.now() },
      };
      return await updater(store);
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "global session",
        agentId: "ops",
        idempotencyKey: "global-session-agent-id",
      },
      { reqId: "global-session-agent-id" },
    );

    const call = await waitForAgentCommandCall<{
      agentId?: string;
      sessionKey?: string;
    }>();
    expect(call.agentId).toBe("ops");
    expect(call.sessionKey).toBe("global");
    expect(mocks.loadSessionEntry).toHaveBeenCalledWith("agent:ops:main", {
      agentId: "ops",
      clone: false,
    });
  });

  it("accepts an explicit global session key with a selected agent id", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "work"]);
    mocks.loadSessionEntry.mockReturnValue({
      cfg: { session: { scope: "global" } },
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "global-work-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "global",
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        global: { sessionId: "global-work-session-id", updatedAt: Date.now() },
      };
      return await updater(store);
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });
    const respond = vi.fn();
    mocks.loadSessionEntry.mockClear();

    await invokeAgent(
      {
        message: "global session",
        sessionKey: "global",
        agentId: "work",
        idempotencyKey: "explicit-global-session-agent-id",
      },
      { reqId: "explicit-global-session-agent-id", respond },
    );

    expect(respond).not.toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: ErrorCodes.INVALID_REQUEST }),
    );
    const call = await waitForAgentCommandCall<{
      agentId?: string;
      sessionKey?: string;
    }>();
    expect(call.agentId).toBe("work");
    expect(call.sessionKey).toBe("global");
    const globalLoadCalls = mocks.loadSessionEntry.mock.calls.filter(
      ([sessionKey]) => sessionKey === "global",
    );
    expect(globalLoadCalls.length).toBeGreaterThan(0);
    for (const [, options] of globalLoadCalls) {
      expect(options).toMatchObject({ agentId: "work", clone: false });
    }
  });

  it("routes bare global session keys to the configured default agent", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "ops"]);
    mocks.loadConfigReturn = {
      agents: { list: [{ id: "main" }, { id: "ops", default: true }] },
      session: { scope: "global" },
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: mocks.loadConfigReturn,
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "global-ops-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "global",
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        global: { sessionId: "global-ops-session-id", updatedAt: Date.now() },
      };
      return await updater(store);
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });
    mocks.loadSessionEntry.mockClear();

    await invokeAgent(
      {
        message: "bare global session",
        sessionKey: "global",
        idempotencyKey: "bare-global-default-agent-id",
      },
      { reqId: "bare-global-default-agent-id" },
    );

    const call = await waitForAgentCommandCall<{
      agentId?: string;
      sessionKey?: string;
    }>();
    expect(call.agentId).toBe("ops");
    expect(call.sessionKey).toBe("global");
    const globalLoadCalls = mocks.loadSessionEntry.mock.calls.filter(
      ([sessionKey]) => sessionKey === "global",
    );
    expect(globalLoadCalls.length).toBeGreaterThan(0);
    for (const [, options] of globalLoadCalls) {
      expect(options).toMatchObject({ agentId: "ops", clone: false });
    }
  });

  it("infers selected-global agent id from agent-prefixed session aliases", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "work"]);
    mocks.loadConfigReturn = {
      agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      session: { scope: "global" },
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: mocks.loadConfigReturn,
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "global-work-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "global",
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        global: { sessionId: "global-work-session-id", updatedAt: Date.now() },
      };
      return await updater(store);
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "global alias session",
        sessionKey: "agent:work:main",
        idempotencyKey: "alias-global-session-agent-id",
      },
      { reqId: "alias-global-session-agent-id" },
    );

    const call = await waitForAgentCommandCall<{
      agentId?: string;
      sessionKey?: string;
    }>();
    expect(call.agentId).toBe("work");
    expect(call.sessionKey).toBe("global");
    expect(mocks.loadSessionEntry).toHaveBeenCalledWith("agent:work:main", {
      agentId: "work",
      clone: false,
    });
  });

  it("registers tool event recipients for active selected-global alias runs", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "work"]);
    mocks.loadConfigReturn = {
      agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      session: { scope: "global" },
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: mocks.loadConfigReturn,
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "global-work-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "global",
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        global: { sessionId: "global-work-session-id", updatedAt: Date.now() },
      };
      return await updater(store);
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });
    const context = makeContext();
    const registerToolEventRecipient = vi.fn();
    context.registerToolEventRecipient = registerToolEventRecipient;
    context.chatAbortControllers.set("run-existing", {
      controller: new AbortController(),
      sessionKey: "global",
      agentId: "work",
      clientRunId: "run-existing",
    } as never);

    await invokeAgent(
      {
        message: "global alias session",
        sessionKey: "agent:work:main",
        idempotencyKey: "alias-global-tool-events",
      },
      {
        reqId: "alias-global-tool-events",
        context,
        client: {
          connId: "conn-1",
          connect: { ...operatorWriteCliClient().connect, caps: ["tool-events"] },
        } as never,
      },
    );

    expect(registerToolEventRecipient).toHaveBeenCalledWith("alias-global-tool-events", "conn-1");
    expect(registerToolEventRecipient).toHaveBeenCalledWith("run-existing", "conn-1");
  });

  registerCompactionSessionSettlementCase();

  it("honors selected-global agent id when the request uses the main alias", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "work"]);
    mocks.loadConfigReturn = {
      agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      session: { scope: "global" },
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: mocks.loadConfigReturn,
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "global-work-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "global",
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        global: { sessionId: "global-work-session-id", updatedAt: Date.now() },
      };
      return await updater(store);
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "global main alias",
        agentId: "work",
        sessionKey: "main",
        idempotencyKey: "selected-global-main-alias-agent-id",
      },
      { reqId: "selected-global-main-alias-agent-id" },
    );

    const call = await waitForAgentCommandCall<{
      agentId?: string;
      sessionKey?: string;
    }>();
    expect(call.agentId).toBe("work");
    expect(call.sessionKey).toBe("global");
    expect(mocks.loadSessionEntry).toHaveBeenCalledWith("main", {
      agentId: "work",
      clone: false,
    });
  });

  it("preserves accepted session and runtime metadata on cached responses", async () => {
    const context = makeContext();
    mocks.listAgentIds.mockReturnValue(["main", "work"]);
    mocks.loadConfigReturn = {
      agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      session: { scope: "global" },
    };
    mocks.agentCommand.mockClear();
    context.dedupe.set("agent:cached-global-work", {
      ts: Date.now(),
      ok: true,
      payload: {
        runId: "cached-global-work",
        sessionKey: "global",
        agentId: "work",
        status: "accepted",
        runtime: {
          harness: "claude-cli",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
        },
      },
    });
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "global session retry",
        sessionKey: "global",
        agentId: "work",
        idempotencyKey: "cached-global-work",
      },
      { context, respond, reqId: "cached-global-work" },
    );

    expectRecordFields(mockCallArg(respond, 0, 1), {
      runId: "cached-global-work",
      sessionKey: "global",
      agentId: "work",
      status: "in_flight",
      runtime: {
        harness: "claude-cli",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      },
    });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  describe("ACP manual-spawn child turn task tracking", () => {
    it("suppresses the gateway CLI task row for confirmed ACP manual-spawn child turns", async () => {
      await withTestDir({ prefix: "openclaw-gateway-acp-suppress-" }, async (root) => {
        useTestStateDir(root);
        resetAgentTaskRegistryForTests();
        const childSessionKey = "agent:main:acp:child-confirmed";
        mockSpawnedChildSessionEntry(childSessionKey, root);
        mocks.readAcpSessionMeta.mockReturnValue(confirmedAcpMeta);
        const createRunningTaskRunSpy = spyDetachedCreateRunningTaskRun();

        await invokeAgent(
          {
            message: "acp manual spawn child turn",
            sessionKey: childSessionKey,
            acpTurnSource: "manual_spawn",
            idempotencyKey: "acp-manual-spawn-confirmed",
          },
          { reqId: "acp-manual-spawn-confirmed", client: backendGatewayClient() },
        );
        await waitForAgentCommandCall();

        expect(createRunningTaskRunSpy).not.toHaveBeenCalled();
        expect(findTaskByRunId("acp-manual-spawn-confirmed")).toBeUndefined();
      });
    });

    it("keeps a host-owned subagent run to its pre-registered task row", async () => {
      await withPluginSubagentTestState("openclaw-gateway-subagent-owner-", async (state) => {
        const root = state.stateDir;
        // The Gateway worker must read the same durable task that the host registered.
        resetTaskRegistryForTests({ persist: false });
        const childSessionKey = "agent:main:subagent:owned";
        const runId = "host-owned-subagent-run";
        mockSpawnedChildSessionEntry(childSessionKey, root);
        getDetachedTaskLifecycleRuntime().createRunningTaskRun({
          runtime: "subagent",
          requesterSessionKey: "agent:main:main",
          ownerKey: "agent:main:main",
          scopeKind: "session",
          childSessionKey,
          runId,
          task: "Run one owned subagent",
          deliveryStatus: "pending",
        });
        const createRunningTaskRunSpy = spyDetachedCreateRunningTaskRun();

        await invokeAgent(
          { message: "host-owned child turn", sessionKey: childSessionKey, idempotencyKey: runId },
          { reqId: runId, client: backendGatewayClient() },
        );
        await waitForAgentCommandCall();

        expect(createRunningTaskRunSpy).not.toHaveBeenCalled();
        expect(listTaskRecords().filter((task) => task.runId === runId)).toEqual([
          expect.objectContaining({ runtime: "subagent", childSessionKey }),
        ]);
      });
    });

    it("keeps CLI tracking when a non-backend operator-write caller sets acpTurnSource", async () => {
      await withTestDir({ prefix: "openclaw-gateway-acp-operator-write-" }, async (root) => {
        useTestStateDir(root);
        resetAgentTaskRegistryForTests();
        const childSessionKey = "agent:main:acp:child-operator-write";
        mockSpawnedChildSessionEntry(childSessionKey, root);
        // Persisted ACP metadata is present and the turn looks like a manual
        // spawn, but the caller is an operator-write control-UI client, not the
        // in-process backend ACP spawn path. That caller never creates a
        // replacement `acp` row, so CLI tracking must stay on to avoid losing the
        // run entirely.
        mocks.readAcpSessionMeta.mockReturnValue(confirmedAcpMeta);
        const createRunningTaskRunSpy = spyDetachedCreateRunningTaskRun();

        await invokeAgent(
          {
            message: "operator-write acp manual spawn",
            sessionKey: childSessionKey,
            acpTurnSource: "manual_spawn",
            idempotencyKey: "acp-operator-write",
          },
          { reqId: "acp-operator-write", client: operatorWriteGatewayClient() },
        );
        await waitForAgentCommandCall();

        expect(createRunningTaskRunSpy).toHaveBeenCalledTimes(1);
        expectRecordFields(mockCallArg(createRunningTaskRunSpy), {
          runtime: "cli",
          runId: "acp-operator-write",
          childSessionKey,
        });
        await waitForAssertion(() => {
          expectRecordFields(findTaskByRunId("acp-operator-write"), {
            runtime: "cli",
            childSessionKey,
          });
        });
      });
    });

    it("keeps CLI tracking for ACP-shaped manual-spawn turns without persisted ACP metadata", async () => {
      await withTestDir({ prefix: "openclaw-gateway-acp-no-meta-" }, async (root) => {
        useTestStateDir(root);
        resetAgentTaskRegistryForTests();
        const childSessionKey = "agent:main:acp:child-missing-meta";
        mockSpawnedChildSessionEntry(childSessionKey, root);
        mocks.readAcpSessionMeta.mockReturnValue(undefined);
        const createRunningTaskRunSpy = spyDetachedCreateRunningTaskRun();

        await invokeAgent(
          {
            message: "acp shaped turn without metadata",
            sessionKey: childSessionKey,
            acpTurnSource: "manual_spawn",
            idempotencyKey: "acp-manual-spawn-no-meta",
          },
          { reqId: "acp-manual-spawn-no-meta", client: backendGatewayClient() },
        );
        await waitForAgentCommandCall();

        expect(createRunningTaskRunSpy).toHaveBeenCalledTimes(1);
        expectRecordFields(mockCallArg(createRunningTaskRunSpy), {
          runtime: "cli",
          runId: "acp-manual-spawn-no-meta",
          childSessionKey,
        });
        await waitForAssertion(() => {
          expectRecordFields(findTaskByRunId("acp-manual-spawn-no-meta"), {
            runtime: "cli",
            childSessionKey,
          });
        });
      });
    });

    it("keeps dispatch and CLI tracking when ACP metadata read fails", async () => {
      await withTestDir({ prefix: "openclaw-gateway-acp-meta-throw-" }, async (root) => {
        useTestStateDir(root);
        resetAgentTaskRegistryForTests();
        const childSessionKey = "agent:main:acp:child-meta-throw";
        mockSpawnedChildSessionEntry(childSessionKey, root);
        const metadataError = new Error("state db unavailable");
        mocks.readAcpSessionMeta.mockImplementation(() => {
          throw metadataError;
        });
        const createRunningTaskRunSpy = spyDetachedCreateRunningTaskRun();
        const context = makeContext();

        await invokeAgent(
          {
            message: "acp manual spawn metadata throw",
            sessionKey: childSessionKey,
            acpTurnSource: "manual_spawn",
            idempotencyKey: "acp-manual-spawn-meta-throw",
          },
          { reqId: "acp-manual-spawn-meta-throw", context, client: backendGatewayClient() },
        );
        await waitForAgentCommandCall();

        expect(createRunningTaskRunSpy).toHaveBeenCalledTimes(1);
        expectRecordFields(mockCallArg(createRunningTaskRunSpy), {
          runtime: "cli",
          runId: "acp-manual-spawn-meta-throw",
          childSessionKey,
        });
        await waitForAssertion(() => {
          expectRecordFields(findTaskByRunId("acp-manual-spawn-meta-throw"), {
            runtime: "cli",
            childSessionKey,
            status: "succeeded",
            terminalSummary: "completed",
          });
        });
        const warnMock = context.logGateway.warn as ReturnType<typeof vi.fn>;
        expect(
          warnMock.mock.calls.some(([message]) => {
            return (
              typeof message === "string" &&
              message.includes("failed to read ACP session metadata") &&
              message.includes("falling back to cli task tracking")
            );
          }),
        ).toBe(true);
      });
    });

    it("keeps CLI tracking for ACP-shaped turns that are not manual spawns", async () => {
      await withTestDir({ prefix: "openclaw-gateway-acp-not-manual-spawn-" }, async (root) => {
        useTestStateDir(root);
        resetAgentTaskRegistryForTests();
        const childSessionKey = "agent:main:acp:child-not-spawn";
        mockSpawnedChildSessionEntry(childSessionKey, root);
        // Metadata is present but the turn lacks acpTurnSource, so the spawn
        // control plane does not own this row; CLI tracking must stay on.
        mocks.readAcpSessionMeta.mockReturnValue(confirmedAcpMeta);
        const createRunningTaskRunSpy = spyDetachedCreateRunningTaskRun();

        await invokeAgent(
          {
            message: "acp shaped non-spawn turn",
            sessionKey: childSessionKey,
            idempotencyKey: "acp-not-manual-spawn",
          },
          { reqId: "acp-not-manual-spawn", client: backendGatewayClient() },
        );
        await waitForAgentCommandCall();

        expect(createRunningTaskRunSpy).toHaveBeenCalledTimes(1);
        expectRecordFields(mockCallArg(createRunningTaskRunSpy), {
          runtime: "cli",
          runId: "acp-not-manual-spawn",
          childSessionKey,
        });
      });
    });

    it("does not affect plugin-subagent tracking for confirmed ACP conditions", async () => {
      await withPluginSubagentTestState("openclaw-gateway-acp-plugin-subagent-", async (state) => {
        const root = state.stateDir;
        resetAgentTaskRegistryForTests();
        const childSessionKey = "agent:main:acp:plugin-child";
        const runId = "acp-plugin-subagent-run";
        await using fixture = createPluginSubagentTestLifetime({ root, runId, childSessionKey });
        mockSpawnedChildSessionEntry(childSessionKey, root);
        mocks.readAcpSessionMeta.mockReturnValue(confirmedAcpMeta);
        const createRunningTaskRunSpy = spyDetachedCreateRunningTaskRun();

        const baseClient = requireValue(backendGatewayClient(), "expected backend client");
        const pluginClient: AgentHandlerArgs["client"] = {
          connect: baseClient.connect,
          internal: {
            ...baseClient.internal,
            agentRunTracking: "plugin_subagent",
            pluginRuntimeOwnerId: "memory-core",
          },
        };

        await fixture.work.track(() =>
          invokeAgent(
            {
              message: "plugin subagent over acp child",
              sessionKey: childSessionKey,
              acpTurnSource: "manual_spawn",
              idempotencyKey: runId,
            },
            { reqId: runId, client: pluginClient },
          ),
        );
        await waitForAgentCommandCall();

        // plugin_subagent precedence means the run is tracked through the
        // subagent registry as a `subagent` row, never a duplicate `cli` row.
        expect(createRunningTaskRunSpy).toHaveBeenCalledTimes(1);
        expectRecordFields(mockCallArg(createRunningTaskRunSpy), {
          runtime: "subagent",
          runId,
        });
        expect(
          listTaskRecords().some((task) => task.runId === runId && task.runtime === "cli"),
        ).toBe(false);
        await waitForAssertion(() => {
          expectRecordFields(getSubagentRunByChildSessionKey(childSessionKey), {
            runId,
            childSessionKey,
            label: "plugin:memory-core",
          });
        });
        // Detached announcement must finish before withTestDir removes its database.
        await fixture.cleanupCompleted;
      });
    });
  });

  registerNativeSubagentTaskTrackingTests();
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
