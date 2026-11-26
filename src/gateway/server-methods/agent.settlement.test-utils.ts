// Register these cases from their original describes in the shared agent.test.ts graph.
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { prepareAgentRunTerminalReply } from "../../agents/agent-run-terminal-reply.js";
import { MISSING_REPLY_SIDE_EFFECT_NOTICE_TEXT } from "../../agents/reply-completion.js";
import type { AgentWaitResult } from "../../agents/run-wait.types.js";
import { readSubagentRunAnnounceResult } from "../../agents/subagents/announce/subagent-announce-output.js";
import { writeSubagentSessionEntry } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import {
  addSubagentRunForTests,
  getSubagentRunByChildSessionKey,
  listSubagentRunsForRequester,
  markRequesterTurnYielded,
  registerSubagentRun,
  resetSubagentRegistryForTests,
  settleRequesterAfterSessionSpawns,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { recordAgentRunTerminalOutcome } from "../../channels/turn/agent-run-terminal-outcome.js";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { getRpcSourceIdentity } from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { waitForAgentJob } from "../agent-turn/agent-job.js";
import { dispatchAgentRunFromGateway } from "../agent-turn/agent-run-dispatch.js";
import { createAgentTurnIo } from "../agent-turn/io.js";
import {
  observeAgentSubagentCleanup,
  withPluginSubagentTestState,
} from "./agent.spawned-child.test-support.js";
import {
  backendGatewayClient,
  expectRecordFields,
  getAgentTestMocks,
  invokeAgent,
  makeContext,
  primeMainAgentRun,
  useTestStateDir,
  waitForAgentCommandCallAfter,
  waitForAssertion,
} from "./agent.test-harness.js";
import type { AgentCommandCall } from "./agent.test-harness.js";
import { flushPendingSessionsChangedEvents } from "./session-change-event.js";

const mocks = getAgentTestMocks();

export function registerSuccessfulAgentSettlementCase() {
  it("completes successful async gateway agent runs", async () => {
    await withTestDir({ prefix: "openclaw-gateway-agent-task-" }, async (root) => {
      useTestStateDir(root);
      mocks.userTurnStorePath = path.join(root, "agents", "main", "sessions", "sessions.json");
      const executionWork = new AsyncWorkScope();
      const context = makeContext();
      await using execution = {
        work: executionWork,
        async [Symbol.asyncDispose]() {
          try {
            await executionWork.runWhenIdle(() => flushPendingSessionsChangedEvents(context));
          } finally {
            await executionWork.drain();
            await cleanupSessionStateForTest({ stateDir: root });
          }
        },
      };
      await execution.work.track(async () => {
        primeMainAgentRun();
        const commandCallCount = mocks.agentCommand.mock.calls.length;

        const respond = await invokeAgent(
          {
            message: "background cli task",
            sessionKey: "agent:main:main",
            idempotencyKey: "gateway-agent-run",
          },
          { reqId: "gateway-agent-run", context },
        );
        expect(respond.mock.calls).toContainEqual([
          true,
          expect.objectContaining({ status: "accepted" }),
          undefined,
          { runId: "gateway-agent-run" },
        ]);
        await waitForAgentCommandCallAfter(commandCallCount);

        await waitForAssertion(() => {
          expectRecordFields(context.dedupe.get("agent:gateway-agent-run")?.payload, {
            status: "ok",
            summary: "completed",
          });
          expect(rpcSourceTesting.has("gateway-agent-run")).toBe(false);
        });
      });
    });
  });
}

export function registerAgentTerminalDiagnosticCases(makeStateDir: () => string) {
  it.each([
    {
      name: "resolved failure",
      timeout: false,
      recordedError: undefined,
      expectedError: "Provider rejected this request.",
      expectedWaitError: "failed",
    },
    {
      name: "resolved timeout",
      timeout: true,
      recordedError: undefined,
      expectedError: "Request timed out before a response was generated.",
      expectedWaitError: "aborted",
    },
    {
      name: "producer lifecycle guidance",
      timeout: false,
      recordedError: "Reconnect the selected provider, then try again.",
      expectedError: "Reconnect the selected provider, then try again.",
      expectedWaitError: "failed",
    },
    {
      name: "missing reply after a tool action",
      timeout: false,
      recordedError: MISSING_REPLY_SIDE_EFFECT_NOTICE_TEXT,
      expectedError: MISSING_REPLY_SIDE_EFFECT_NOTICE_TEXT,
      expectedWaitError: MISSING_REPLY_SIDE_EFFECT_NOTICE_TEXT,
    },
  ])("retains the $name diagnostic on the terminal outcome", async (scenario) => {
    useTestStateDir(makeStateDir());
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
    const onSettled = vi.fn(() => true);
    await dispatchAgentRunFromGateway({
      admittedRunEntry: undefined,
      ingressOpts: {
        message: "Run this request.",
        sessionKey: "agent:main:main",
        allowModelOverride: false,
      },
      runId,
      dedupeKeys: [`agent:${runId}`],
      abortController: new AbortController(),
      cleanupAbortController: vi.fn(),
      io: createAgentTurnIo(vi.fn()),
      context: makeContext(),
      onSettled,
    });
    expect(onSettled).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalOutcome: expect.objectContaining({ error: scenario.expectedError }),
      }),
    );
    // Only the host-authored notice crosses the public wait boundary. Other
    // producer diagnostics remain internal; timeout retains its existing summary.
    await expect(waitForAgentJob({ runId, source: "agent", timeoutMs: 0 })).resolves.toMatchObject({
      status: scenario.timeout ? "timeout" : "error",
      error: scenario.expectedWaitError,
    });
  });
}

export function registerCompactionSessionSettlementCase() {
  it("updates tracked agent session identity after compaction rotation", async () => {
    primeMainAgentRun();
    const context = makeContext();
    let trackedSessionId: string | undefined;
    mocks.agentCommand.mockImplementation(async (call: AgentCommandCall) => {
      const onSessionIdChanged = call.onSessionIdChanged;
      if (typeof onSessionIdChanged !== "function") {
        throw new Error("expected session id change callback");
      }
      onSessionIdChanged("rotated-session-id");
      const source = rpcSourceTesting.get("agent-session-rotation");
      trackedSessionId = source && getRpcSourceIdentity(source).sessionId;
      return {
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      };
    });

    await invokeAgent(
      {
        message: "rotate session",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: "agent-session-rotation",
      },
      {
        reqId: "agent-session-rotation",
        context,
      },
    );

    expect(trackedSessionId).toBe("rotated-session-id");
    expect(await waitForAgentJob({ runId: "agent-session-rotation", timeoutMs: 0 })).toMatchObject({
      session: { sessionId: "rotated-session-id" },
    });
  });
}

export function registerYieldedRequesterSettlementCase(
  mockSpawnedChildSessionEntry: (sessionKey: string, root: string) => void,
) {
  it("keeps one native run when a completed child wakes its requester before the yielded lifecycle ends", async ({
    signal,
  }) => {
    await withPluginSubagentTestState(
      "openclaw-gateway-yield-settlement-race-",
      async ({ stateDir: root }) => {
        await resetSubagentRegistryForTests({ persist: false });
        const requesterSessionKey = "agent:main:main";
        const childSessionKey = "agent:main:subagent:settlement-orchestrator";
        const workerSessionKey = "agent:main:subagent:settlement-worker";
        const previousRunId = "orchestrator-yielding";
        const nextRunId = "orchestrator-settle-continuation";
        using cleanup = observeAgentSubagentCleanup({ runId: nextRunId, childSessionKey });
        const workerRunId = "settled-worker";
        await replaceSessionEntry(
          {
            agentId: "main",
            sessionKey: requesterSessionKey,
            storePath: path.join(root, "agents", "main", "sessions", "sessions.json"),
          },
          { sessionId: "settlement-requester", updatedAt: Date.now() },
        );
        const result = `${"Checked worker detail. ".repeat(200)}The completed worker result has been checked.`;
        const { terminalReply } = prepareAgentRunTerminalReply({ rawText: result });
        const completion = createDeferred<AgentWaitResult>();
        const previousWait = createDeferred<AgentWaitResult>();
        const announce = mocks.registryAnnounce.mockResolvedValue("delivered");
        let continuedAtDispatch:
          | Awaited<ReturnType<typeof getSubagentRunByChildSessionKey>>
          | undefined;
        const executionWork = new AsyncWorkScope();
        const context = makeContext();
        context.trackExecution = (run) => executionWork.track(run);
        await using execution = {
          work: executionWork,
          async [Symbol.asyncDispose]() {
            try {
              await executionWork.runWhenIdle(() => flushPendingSessionsChangedEvents(context));
            } finally {
              await executionWork.drain();
            }
          },
        };
        const wakeCompleted = createDeferred();
        const wakeRespond = vi.fn((ok: boolean, payload?: { status?: string }) => {
          if (!ok || payload?.status !== "accepted") {
            wakeCompleted.resolve();
          }
        });
        const wake = mocks.registryWake.mockImplementation(async (params) => {
          if (params.requesterSessionKey !== childSessionKey) {
            return false;
          }
          // The transport crosses the real agent admission boundary before the
          // predecessor's lifecycle end is delivered, as in the production race.
          await invokeAgent(
            {
              message: "The worker finished; verify and return its result.",
              sessionKey: childSessionKey,
              idempotencyKey: nextRunId,
              inputProvenance: {
                kind: "inter_session",
                sourceSessionKey: workerSessionKey,
                sourceTool: "subagent_settle",
              },
            },
            {
              context,
              reqId: nextRunId,
              client: backendGatewayClient(),
              respond: wakeRespond,
              // This wake awaits SQLite; keep the outer lifecycle wait on real timers.
              flushDispatch: false,
            },
          );
          return true;
        });
        mocks.registryCallGateway.mockImplementation(
          async ({ params }) =>
            await (asOptionalRecord(params)?.runId === previousRunId
              ? previousWait.promise
              : completion.promise),
        );
        await writeSubagentSessionEntry({
          stateDir: root,
          agentId: "main",
          sessionKey: childSessionKey,
          defaultSessionId: "spawned-child-session",
        });
        await registerSubagentRun({
          runId: previousRunId,
          childSessionKey,
          childAgentId: "main",
          sessionEntry: { sessionId: "spawned-child-session" },
          requesterSessionKey,
          requesterAgentId: "main",
          requesterDisplayKey: requesterSessionKey,
          task: "Collect and verify the worker's result",
          cleanup: "keep",
          expectsCompletionMessage: true,
        });
        await addSubagentRunForTests({
          runId: workerRunId,
          childSessionKey: workerSessionKey,
          childAgentId: "main",
          childSessionIdentity: { sessionId: "settled-worker-session" },
          requesterSessionKey: childSessionKey,
          requesterAgentId: "main",
          requesterTurnRunId: previousRunId,
          requesterDisplayKey: childSessionKey,
          task: "Produce the worker result",
          startedAt: Date.now() - 10,
          endedAt: Date.now(),
          outcome: { status: "ok" },
          expectsCompletionMessage: true,
          completion: {
            required: true,
            resultText: "Worker result is ready.",
            capturedAt: Date.now(),
          },
          delivery: { status: "delivered" },
          cleanupCompletedAt: Date.now(),
        });
        mockSpawnedChildSessionEntry(childSessionKey, root);
        await replaceSessionEntry(
          { agentId: "main", sessionKey: childSessionKey, storePath: mocks.userTurnStorePath },
          { sessionId: "spawned-child-session", updatedAt: Date.now() },
        );
        mocks.agentCommand.mockImplementation(async () => {
          continuedAtDispatch = structuredClone(
            await getSubagentRunByChildSessionKey(childSessionKey),
          );
          await appendTranscriptMessage(
            {
              agentId: "main",
              sessionKey: childSessionKey,
              sessionId: "spawned-child-session",
              storePath: mocks.userTurnStorePath!,
            },
            {
              message: {
                role: "assistant",
                display: true,
                content: result,
                stopReason: "stop",
                __openclaw: { runId: nextRunId },
              },
            },
          );
          completion.resolve({
            status: "ok",
            startedAt: Date.now(),
            endedAt: Date.now(),
            terminalReply,
          });
          return {
            payloads: [{ text: result }],
            meta: { durationMs: 1, terminalReply },
          };
        });
        expectRecordFields((await getSubagentRunByChildSessionKey(childSessionKey))?.execution, {
          status: "running",
          endedAt: undefined,
        });
        expect(
          await markRequesterTurnYielded({
            requesterSessionKey: childSessionKey,
            requesterAgentId: "main",
            requesterTurnRunId: previousRunId,
          }),
        ).toBe(1);
        expect(
          await settleRequesterAfterSessionSpawns({
            requesterSessionKey: childSessionKey,
            requesterAgentId: "main",
            requesterTurnRunId: previousRunId,
            requesterYielded: true,
            acceptedSessionSpawns: [
              {
                runId: workerRunId,
                childSessionKey: workerSessionKey,
                expectsCompletionMessage: true,
              },
            ],
          }),
        ).toBe(true);
        await racePromiseWithAbortSignal(wakeCompleted.promise, signal);
        expect(wake).toHaveBeenCalled();
        await execution.work.runWhenIdle(() => {
          expect(wakeRespond.mock.calls.find(([ok]) => !ok)).toBeUndefined();
          expectRecordFields(context.dedupe.get(`agent:${nextRunId}`)?.payload, { status: "ok" });
        });
        expectRecordFields(continuedAtDispatch, {
          runId: nextRunId,
          taskRunId: previousRunId,
          requesterSessionKey,
          pauseReason: undefined,
        });
        await racePromiseWithAbortSignal(cleanup.cleanupCompleted, signal);
        expectRecordFields(await getSubagentRunByChildSessionKey(childSessionKey), {
          runId: nextRunId,
          cleanupCompletedAt: expect.any(Number),
        });
        const { emitAgentEvent } = await vi.importActual<
          typeof import("../../infra/agent-events.js")
        >("../../infra/agent-events.js");
        emitAgentEvent({
          runId: previousRunId,
          sessionKey: childSessionKey,
          stream: "lifecycle",
          data: { phase: "end", endedAt: Date.now(), yielded: true },
        });
        await Promise.resolve();
        expectRecordFields(await getSubagentRunByChildSessionKey(childSessionKey), {
          runId: nextRunId,
          cleanupCompletedAt: expect.any(Number),
        });
        expect(
          listSubagentRunsForRequester(requesterSessionKey).map((entry) => entry.runId),
        ).not.toContain(previousRunId);
        expect(announce).toHaveBeenCalledTimes(1);
        expect(announce).toHaveBeenCalledWith(
          expect.objectContaining({
            childRunId: nextRunId,
            requesterSessionKey,
            terminalReply,
          }),
        );
        const completed = expectDefined(
          await getSubagentRunByChildSessionKey(childSessionKey),
          "completed orchestrator",
        );
        const prepared = await readSubagentRunAnnounceResult(completed);
        expect(prepared.text).toBe(result);
        expect(prepared.isCurrent()).toBe(true);
      },
    );
  });
}
