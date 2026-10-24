import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import type { AgentCommandOpts } from "../agents/command/types.js";
import { SessionFollowupCompletion } from "../agents/subagents/completion/session-followup-completion.js";
import { startSessionsSendReplyFlow } from "../agents/tools/sessions-send-reply-flow.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { getRpcSource } from "../sessions/session-controller.rpc-sources.js";
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
  verifyChatSuccessor: (signal: AbortSignal) => Promise<void>;
};

export function createPrivateCompletionRequest({
  sessionKey,
  sessionId,
  runId,
  message = "Synthetic private child marker",
}: {
  sessionKey: string;
  sessionId: string;
  runId: string;
  message?: string;
}) {
  return {
    sessionKey,
    expectedExistingSessionId: sessionId,
    idempotencyKey: runId,
    message,
    deliver: false,
    sourceReplyDeliveryMode: "automatic",
    inputProvenance: {
      kind: "inter_session",
      sourceTool: "subagent_announce",
      sourceSessionKey: "agent:main:subagent:synthetic-child",
    },
  };
}

export function readPrivateCompletionRecorder(
  input: unknown,
  sessionId: string,
): UserTurnTranscriptRecorder {
  const command = input as AgentCommandOpts;
  expect(command).toMatchObject({ deliver: false, privateCompletion: true, sessionId });
  return expectDefined(command.userTurnTranscriptRecorder, "Expected real private input recorder");
}

export function registerSessionsSendPrivateCompletionTests(
  getFixture: () => PrivateCompletionFixture,
) {
  it.for(["processed", "provider failed"] as const)(
    "settles a sessions_send child reply through real private admission (%s)",
    async (outcome, { signal }) => {
      const fixture = getFixture();
      const { context, sessionKey, sessionId, agentCommandMock } = fixture;
      const childRunId = `sessions-send-child-${fixture.sequence}`;
      const childSessionKey = `agent:main:subagent:${childRunId}`;
      const childReply = "Synthetic retained sessions_send child result";
      const failure = "synthetic retained parent failure";
      const runId = `announce:sessions-send:${childRunId}:completion`;
      const entered = createDeferred();
      const release = createDeferred();
      const source = new AbortController();
      const closed = createDeferred<Record<"completions" | "pending", Record<string, unknown>[]>>();
      let completionWork: Promise<unknown> | undefined;
      const completion = SessionFollowupCompletion.bind({
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
            closed.resolve({ completions: fixture.completions(), pending: fixture.pending() });
            source.abort();
          },
          run<T>(work: () => T): T {
            const result = withPluginRuntimeGatewayContextResolver(() => context, work);
            completionWork = Promise.resolve(result);
            return result;
          },
        },
      });
      const close = vi.spyOn(completion, "close");
      completion.markAccepted(childRunId);
      await completion.settle(childRunId, {
        status: "ok",
        terminalReply: { disposition: "visible", text: childReply },
        replyText: childReply,
      });
      completion.finishExecution(childRunId);
      agentCommandMock.mockImplementation(async (input) => {
        const command = input as AgentCommandOpts;
        const inputRecorder = fixture.recorder(input);
        expect(command.runId).toBe(runId);
        await command.onExecutionStarted?.();
        entered.resolve();
        await release.promise;
        if (outcome === "provider failed") {
          throw new Error(failure);
        }
        await inputRecorder.persistApproved();
        return { payloads: [], meta: { durationMs: 1, terminalReply: { disposition: "empty" } } };
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
      const finished = expectDefined(completionWork, "Expected retained completion work").catch(
        () => undefined,
      );
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
        expect(fixture.completions()).toEqual([]);
        expect(fixture.pending()).toMatchObject([{ run_id: runId, state: "queued" }]);
        release.resolve();
        await withinTest(finished, signal);
        const settled = await withinTest(closed.promise, signal);
        expect(completion.signal.aborted).toBe(true);
        const closeArgs =
          outcome === "processed"
            ? []
            : [expect.objectContaining({ message: expect.stringContaining(failure) })];
        expect(close.mock.calls).toEqual([closeArgs]);
        expect(agentCommandMock).toHaveBeenCalledOnce();
        expect(getRpcSource(runId)).toBeUndefined();
        expect(settled.completions).toMatchObject([
          { run_id: runId, succeeded: outcome === "processed" ? 1 : 0 },
        ]);
        if (outcome === "processed") {
          expect(settled.pending).toEqual([]);
          expect(JSON.stringify(fixture.transcript())).toContain(childReply);
          expect(context.dedupe.get(`agent:${runId}`)?.payload).toMatchObject({
            status: "ok",
            inputProcessingCompleted: true,
          });
          await fixture.verifyChatSuccessor(signal);
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
            error: failure,
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
