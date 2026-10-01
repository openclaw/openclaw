// Imported by agent.test.ts to keep its mocked suite in one Vitest module graph.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AgentWaitResult } from "../../agents/run-wait.types.js";
import {
  getSubagentRunByChildSessionKey,
  listSubagentRunsForRequester,
  resetSubagentRegistryForTests,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
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
          resetSubagentRegistryForTests({ persist: false });
          const childSessionKey = "agent:main:subagent:orchestrator";
          const workerSessionKey = "agent:main:subagent:worker";
          const previousRunId = "orchestrator-before-yield";
          const runId = "orchestrator-completion-followup";
          using cleanup = observeAgentSubagentCleanup({ runId, childSessionKey });
          const result = "All worker results are ready.";
          const completion = createDeferred<AgentWaitResult>();
          const announce = mocks.registryAnnounce.mockResolvedValue("delivered");
          mocks.registryCallGateway.mockReturnValue(completion.promise);
          seedPersistedSubagentRunForAgentTest({
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
          await racePromiseWithAbortSignal(cleanup.cleanupCompleted, signal);
          expect(announce).toHaveBeenCalledTimes(1);
          expectRecordFields(continued, { cleanupCompletedAt: expect.any(Number) });
          expectRecordFields(continued.delivery, { status: "delivered" });
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
