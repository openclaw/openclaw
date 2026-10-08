import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import type { AgentCommandOpts } from "../agents/command/types.js";
import { SessionFollowupCompletion } from "../agents/subagents/completion/session-followup-completion.js";
import type { FollowupRequest } from "../agents/subagents/completion/session-followup-completion.types.js";
import { startSessionsSendReplyFlow } from "../agents/tools/sessions-send-reply-flow.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import type { UserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.types.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import type { agentCommandMock as gatewayAgentCommandMock } from "./test-helpers.js";

type PrivateCompletionFixture = {
  context: GatewayRequestContext;
  sequence: number;
  sessionKey: string;
  sessionId: string;
  completions: () => Record<string, unknown>[];
  pending: () => Record<string, unknown>[];
  transcript: () => unknown;
  recorder: (input: unknown) => UserTurnTranscriptRecorder;
  agentCommandMock: typeof gatewayAgentCommandMock;
};

export function readPrivateCompletionRecorder(
  input: unknown,
  sessionId: string,
): UserTurnTranscriptRecorder {
  const command = input as AgentCommandOpts;
  expect(command.deliver).toBe(false);
  expect(command.privateCompletion).toBe(true);
  expect(command.sessionId).toBe(sessionId);
  return expectDefined(command.userTurnTranscriptRecorder, "Expected real private input recorder");
}

export function registerSessionsSendPrivateCompletionTests(
  getFixture: () => PrivateCompletionFixture,
) {
  it.for(["processed", "provider failed"] as const)(
    "settles a sessions_send child reply through real private admission (%s)",
    async (outcome, { signal }) => {
      const {
        context,
        sequence,
        sessionKey,
        sessionId,
        completions,
        pending,
        transcript,
        recorder,
        agentCommandMock,
      } = getFixture();
      const childRunId = `sessions-send-child-${sequence}`;
      const childSessionKey = `agent:main:subagent:${childRunId}`;
      const childReply = "Synthetic retained sessions_send child result";
      const runId = `announce:sessions-send:${childRunId}:completion`;
      const entered = createDeferred();
      const release = createDeferred();
      const source = new AbortController();
      const closed = createDeferred<{
        completions: ReturnType<typeof completions>;
        pending: ReturnType<typeof pending>;
      }>();
      let completionWork: Promise<unknown> | undefined;
      const followup: FollowupRequest = {
        runId: childRunId,
        requesterAgentId: "main",
        requesterSessionKey: sessionKey,
        requesterSessionId: sessionId,
        targetAgentId: "main",
        targetSessionKey: childSessionKey,
        custody: {
          signal: source.signal,
          assertCurrent: () => source.signal.throwIfAborted(),
          release: () => {
            closed.resolve({ completions: completions(), pending: pending() });
            source.abort();
          },
          run<T>(work: () => T): T {
            const result = withPluginRuntimeGatewayContextResolver(() => context, work);
            completionWork = Promise.resolve(result);
            return result;
          },
        },
      };
      const completion = SessionFollowupCompletion.bind(followup);
      const close = vi.spyOn(completion, "close");
      completion.markAccepted(childRunId);
      await completion.settle(childRunId, { status: "ok", replyText: childReply });
      completion.finishExecution(childRunId);
      agentCommandMock.mockImplementation(async (input) => {
        const command = input as AgentCommandOpts;
        const inputRecorder = recorder(input);
        expect(command.runId).toBe(runId);
        await command.onExecutionStarted?.();
        entered.resolve();
        await release.promise;
        if (outcome === "provider failed") {
          throw new Error("synthetic retained parent failure");
        }
        await inputRecorder.persistApproved();
        return { payloads: [], meta: { durationMs: 1 } };
      });
      await startSessionsSendReplyFlow({
        runId: childRunId,
        completion,
        skip: false,
        targetSessionKey: childSessionKey,
        targetAgentId: "main",
        displayKey: childSessionKey,
        replyTimeoutMs: 10_000,
        replyMode: "one-way",
        requesterSessionKey: sessionKey,
        requesterAgentId: "main",
        requesterSession: { sessionId },
      });
      const work = expectDefined(completionWork, "Expected retained completion work");
      const finished = work.catch(() => undefined);
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            entered.promise,
            finished,
            "Retained child result ended before private parent admission",
          ),
          signal,
        );
        expect(completion.signal.aborted).toBe(false);
        expect(completions()).toEqual([]);
        expect(pending()).toMatchObject([{ run_id: runId, state: "queued" }]);
        release.resolve();
        await withinTest(finished, signal);
        const settled = await withinTest(closed.promise, signal);
        expect(completion.signal.aborted).toBe(true);
        expect(close.mock.calls).toEqual(
          outcome === "processed"
            ? [[]]
            : [
                [
                  expect.objectContaining({
                    message: expect.stringContaining("synthetic retained parent failure"),
                  }),
                ],
              ],
        );
        expect(agentCommandMock).toHaveBeenCalledOnce();
        expect(context.chatAbortControllers.has(runId)).toBe(false);
        expect(settled.completions).toMatchObject([
          { run_id: runId, succeeded: outcome === "processed" ? 1 : 0 },
        ]);
        if (outcome === "processed") {
          expect(settled.pending).toEqual([]);
          expect(JSON.stringify(transcript())).toContain(childReply);
          expect(context.dedupe.get(`agent:${runId}`)?.payload).toMatchObject({
            status: "ok",
            inputProcessingCompleted: true,
          });
        } else {
          expect(settled.pending).toMatchObject([
            {
              run_id: runId,
              state: "interrupted",
              message_json: expect.stringContaining(childReply),
            },
          ]);
          expect(JSON.parse(String(settled.completions[0]?.outcome_json))).toMatchObject({
            reason: "failed",
            error: "synthetic retained parent failure",
          });
        }
      } finally {
        release.resolve();
        await finished;
        close.mockRestore();
        completion.close();
      }
    },
  );
}
