// Imported by agent.test.ts to keep its mocked suite in one Vitest module graph.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AgentWaitResult } from "../../agents/run-wait.types.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { subscribeSubagentRunChanges } from "../../agents/subagents/registry/subagent-registry-publication.js";
import { loadSubagentRegistryFromSqlite } from "../../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import {
  getSubagentRunByChildSessionKey,
  listSubagentRunsForRequester,
  resetSubagentRegistryForTests,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { bindInProcessSubagentResume } from "../in-process-subagent-resume.js";
import { bindParentSubagentResume } from "../session-subagent-resume.js";
import {
  mockSpawnedChildSessionEntry,
  observeAgentSubagentCleanup,
  seedPersistedSubagentRunForAgentTest,
  withPluginSubagentTestState,
} from "./agent.spawned-child.test-support.js";
import {
  backendGatewayClient,
  describe0AfterEach0,
  expectRecordFields,
  expectRespondError,
  getAgentTestMocks,
  invokeAgent,
  makeContext,
  requireValue,
  waitForAssertion,
} from "./agent.test-harness.js";

const mocks = getAgentTestMocks();

describe("gateway agent handler yielded orchestrator follow-ups", () => {
  afterEach(describe0AfterEach0);

  it("settles the adopted native row when parent resume admission fails after commit", async () => {
    await withPluginSubagentTestState(
      "openclaw-parent-resume-postcommit-rejection-",
      async ({ stateDir: root }) => {
        const childSessionKey = "agent:main:subagent:postcommit-resume";
        const previousRunId = "postcommit-paused";
        const runId = "postcommit-successor";
        await seedPersistedSubagentRunForAgentTest({
          runId: previousRunId,
          childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "Wait for the parent's answer",
          startedAt: Date.now() - 10,
          endedAt: Date.now(),
          pauseReason: "sessions_yield",
          expectsCompletionMessage: true,
        });
        mockSpawnedChildSessionEntry(childSessionKey, root);
        mocks.registryCallGateway.mockResolvedValue({ status: "pending" });
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
        const context = makeContext();
        const failure = new Error("parent resume admission retired after commit");
        let adopted: SubagentRunRecord | undefined;
        const unsubscribe = subscribeSubagentRunChanges("persistence", () => {
          const current = subagentRuns.get(runId);
          if (adopted || current?.runId !== runId || current.execution.status !== "running") {
            return;
          }
          // Publication follows the native ACK; abort before the admission frame resumes.
          adopted = loadSubagentRegistryFromSqlite().get(runId);
          context.chatAbortControllers.get(runId)?.controller.abort(failure);
        });
        const respond = vi.fn();
        try {
          await invokeAgent(
            {
              message: "Continue with the supplied answer",
              sessionKey: childSessionKey,
              idempotencyKey: runId,
              inputProvenance: {
                kind: "inter_session",
                sourceSessionKey: "agent:main:main",
                sourceTool: "sessions_send",
              },
            },
            { context, client, respond, reqId: runId, flushDispatch: false },
          );
        } finally {
          unsubscribe();
        }
        expect(adopted).toMatchObject({
          runId,
          taskRunId: previousRunId,
          execution: { status: "running" },
        });
        expectRespondError(respond, { message: expect.stringContaining(failure.message) });
        expect(respond.mock.calls.some(([accepted]) => accepted === true)).toBe(false);
        expect(mocks.agentCommand).not.toHaveBeenCalled();
        expect(context.chatAbortControllers.has(runId)).toBe(false);
        const terminal = {
          runId,
          taskRunId: previousRunId,
          execution: {
            status: "terminal",
            endedAt: expect.any(Number),
            outcome: { status: "error", error: expect.stringContaining(failure.message) },
            suppressSessionEffects: true,
          },
        };
        expect(await getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject(terminal);
        const stored = loadSubagentRegistryFromSqlite();
        expect(stored.has(previousRunId)).toBe(false);
        expect(stored.get(runId)).toMatchObject(terminal);
      },
    );
  });

  it.for(
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
    async ({ requesterSessionKey, sourceTool, continuesRun, resume, inputFailure }, { signal }) => {
      await withPluginSubagentTestState(
        "openclaw-gateway-yield-completion-",
        async ({ stateDir: root }) => {
          await resetSubagentRegistryForTests({ persist: false });
          const childSessionKey = "agent:main:subagent:orchestrator";
          const workerSessionKey = "agent:main:subagent:worker";
          const previousRunId = "orchestrator-before-yield";
          const runId = "orchestrator-completion-followup";
          using cleanup = observeAgentSubagentCleanup({ runId, childSessionKey });
          const result = "All worker results are ready.";
          const completion = createDeferred<AgentWaitResult>();
          const announce = mocks.registryAnnounce.mockResolvedValue("delivered");
          mocks.registryCallGateway.mockReturnValue(completion.promise);
          await seedPersistedSubagentRunForAgentTest({
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
                caller: {
                  agentId: "main",
                  sessionKey: requesterSessionKey,
                  assertCurrent: vi.fn(),
                },
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
          // Fake dispatch timers also fire registry maintenance while worker IO is pending.
          await invokeAgent(request, {
            context,
            reqId: runId,
            client,
            respond,
            flushDispatch: false,
          });
          if (inputFailure) {
            expectRespondError(respond, { message: "resume input admission failed" });
            expect(mocks.agentCommand).not.toHaveBeenCalled();
            expect(await getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
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
            await getSubagentRunByChildSessionKey(childSessionKey),
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
          await racePromiseWithAbortSignal(cleanup.cleanupCompleted, signal);
          expect(announce).toHaveBeenCalledTimes(1);
          const completed = requireValue(
            await getSubagentRunByChildSessionKey(childSessionKey),
            "expected the orchestrator's completed run",
          );
          expectRecordFields(completed, { cleanupCompletedAt: expect.any(Number) });
          expectRecordFields(completed.delivery, { status: "delivered" });
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
        },
      );
    },
  );
});
