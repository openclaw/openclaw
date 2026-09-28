import { expect, it, vi } from "vitest";
import {
  getSubagentRunByChildSessionKey,
  registerSubagentRun,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { enqueueSwarmRun, releaseSwarmRun } from "../../agents/subagents/swarm/swarm-scheduler.js";
import { testing as swarmSchedulerTesting } from "../../agents/subagents/swarm/swarm-scheduler.test-support.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  getAgentTestMocks,
  operatorWriteCliClient,
  makeContext,
  waitForAssertion,
  expectRecordFields,
  mockCallArg,
  invokeAgent,
  prime,
} from "./agent.test-harness.js";
import {
  handleChatAbortRequest,
  handleChatAbortRequestWithLifecycle,
} from "./chat-abort-handler.js";

const mocks = getAgentTestMocks();

export function registerAgentAbortSubagentTests() {
  it.each([
    { name: "announcing", expectsCompletionMessage: true, collect: false },
    { name: "nonannouncing", expectsCompletionMessage: false, collect: false },
    { name: "unspecified completion", expectsCompletionMessage: undefined, collect: false },
    { name: "collector", expectsCompletionMessage: false, collect: true },
    {
      name: "collector partial persistence error",
      expectsCompletionMessage: false,
      collect: true,
      releaseOnParent: true,
      partialFailure: true,
    },
    {
      name: "collector session cascade partial persistence error",
      expectsCompletionMessage: false,
      collect: true,
      releaseOnParent: true,
      partialFailure: true,
      cascade: true,
    },
    {
      name: "collector parent signal",
      expectsCompletionMessage: false,
      collect: true,
      releaseOnParent: true,
    },
  ])(
    "chat.abort by runId kills only registered children of its non-admin owner: $name",
    async ({ expectsCompletionMessage, collect, releaseOnParent, partialFailure, cascade }) => {
      prime();
      mocks.registryPersist.mockImplementation(() => {});
      mocks.registryPersistOrThrow.mockImplementation(() => {});
      mocks.registryCallGateway.mockImplementation(async () => await new Promise(() => {}));
      const pending = new Promise(() => {});
      let capturedSignal: AbortSignal | undefined;
      mocks.agentCommand.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
        capturedSignal = opts.abortSignal;
        return pending;
      });

      const context = makeContext();
      const client = {
        ...operatorWriteCliClient(["operator.read", "operator.write"]),
        connId: "owner-conn",
      };
      const runId = "idem-abort-owned-subagents";
      const ownedChildSessionKey = "agent:main:subagent:owned-by-aborted-turn";
      const queuedChildSessionKey = "agent:main:subagent:queued-by-aborted-turn";
      const unrelatedChildSessionKey = "agent:main:subagent:owned-by-other-turn";
      await invokeAgent(
        {
          message: "hi",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: runId,
        },
        { context, reqId: runId, client },
      );
      for (const [childSessionKey, requesterTurnRunId, queued] of [
        [ownedChildSessionKey, runId, false],
        ...(collect ? [[queuedChildSessionKey, runId, true] as const] : []),
        [unrelatedChildSessionKey, "other-parent-turn", false],
      ] as const) {
        await registerSubagentRun({
          runId: childSessionKey,
          childSessionKey,
          controllerSessionKey:
            cascade && requesterTurnRunId !== runId ? "agent:main:other" : "agent:main:main",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          requesterAgentId: "main",
          requesterTurnRunId,
          task: requesterTurnRunId,
          cleanup: "keep",
          expectsCompletionMessage,
          collect,
          queued,
        });
      }

      const queuedDispatch = vi.fn(async () => {});
      const unselectedDispatch = vi.fn(async () => {});
      let childOperation: ReturnType<typeof createReplyOperation> | undefined;
      if (collect) {
        const sessionId = "active-collector-session";
        await replaceSessionEntry(
          {
            storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
            sessionKey: ownedChildSessionKey,
          },
          { sessionId, updatedAt: Date.now() },
        );
        childOperation = createReplyOperation({
          sessionKey: ownedChildSessionKey,
          sessionId,
          resetTriggered: false,
        });
        childOperation.attachBackend({
          kind: "embedded",
          isStreaming: () => true,
          cancel: () => {
            if (!releaseOnParent) {
              expect(releaseSwarmRun(ownedChildSessionKey)).toBe(true);
            }
          },
        });
        if (releaseOnParent) {
          capturedSignal?.addEventListener(
            "abort",
            () => {
              expect(releaseSwarmRun(ownedChildSessionKey)).toBe(true);
            },
            { once: true },
          );
        }
        enqueueSwarmRun({
          groupId: "abort-owned-collectors",
          runId: queuedChildSessionKey,
          maxConcurrent: 1,
          activeRunIds: [ownedChildSessionKey],
          start: queuedDispatch,
          onStartFailure: () => true,
        });
        enqueueSwarmRun({
          groupId: "abort-owned-collectors",
          runId: unrelatedChildSessionKey,
          maxConcurrent: 1,
          activeRunIds: [],
          start: unselectedDispatch,
          onStartFailure: () => true,
        });
      }
      try {
        const foreignRespond = vi.fn();
        await handleChatAbortRequest({
          params: { sessionKey: "agent:main:main", runId },
          respond: foreignRespond as never,
          context,
          req: { type: "req", id: "foreign-abort-req", method: "chat.abort" },
          client: { ...client, connId: "foreign-conn" },
          isWebchatConnect: () => false,
        });
        expect(mockCallArg(foreignRespond)).toBe(false);
        expect(capturedSignal?.aborted).toBe(false);
        expect(getSubagentRunByChildSessionKey(ownedChildSessionKey)?.execution.status).toBe(
          "running",
        );
        if (collect) {
          expect(getSubagentRunByChildSessionKey(queuedChildSessionKey)?.execution.status).toBe(
            "queued",
          );
          expect(queuedDispatch).not.toHaveBeenCalled();
        }
        const abortRespond = vi.fn();
        const partialPersistenceError = new Error("partial persistence failed");
        if (partialFailure) {
          context.chatRunState.getOrCreate(runId).buffer = "partial";
          mocks.loadSessionEntry.mockImplementationOnce(() => {
            throw partialPersistenceError;
          });
        }
        const abort = handleChatAbortRequestWithLifecycle(
          {
            params: { sessionKey: "agent:main:main", ...(cascade ? {} : { runId }) },
            respond: abortRespond as never,
            context,
            req: { type: "req", id: "abort-req", method: "chat.abort" },
            client,
            isWebchatConnect: () => false,
          },
          cascade ? { cascadeDescendants: true } : {},
        );

        if (partialFailure) {
          await expect(abort).rejects.toBe(partialPersistenceError);
          await expect(abort).rejects.toThrow("partial persistence failed");
        } else {
          await abort;
          expect(mockCallArg(abortRespond)).toBe(true);
          expectRecordFields(mockCallArg(abortRespond, 0, 1), { aborted: true, runIds: [runId] });
        }
        expect(capturedSignal?.aborted).toBe(true);
        expect(getSubagentRunByChildSessionKey(ownedChildSessionKey)).toMatchObject({
          endedReason: "subagent-killed",
          killReconciliation: { suppressTaskDelivery: true },
        });
        expect(
          getSubagentRunByChildSessionKey(unrelatedChildSessionKey)?.execution.endedAt,
        ).toBeUndefined();
        if (collect) {
          expect(getSubagentRunByChildSessionKey(queuedChildSessionKey)).toMatchObject({
            execution: { status: "terminal" },
            endedReason: "subagent-killed",
          });
          expect(childOperation?.abortSignal.aborted).toBe(true);
          await Promise.resolve();
          expect(queuedDispatch).not.toHaveBeenCalled();
          await waitForAssertion(() => expect(unselectedDispatch).toHaveBeenCalledOnce());
        }
      } finally {
        childOperation?.complete();
        swarmSchedulerTesting.reset();
      }
    },
  );

  it("starts the next abort fixture without previously registered child runs", () => {
    expect(getSubagentRunByChildSessionKey("agent:main:subagent:owned-by-other-turn")).toBeNull();
  });
}
