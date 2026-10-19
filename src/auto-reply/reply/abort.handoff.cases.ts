import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, onTestFinished } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  clearAgentRunContext,
  getAgentRunContext,
  registerAgentRunContext,
} from "../../infra/agent-run-registry.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";
import { formatAbortReplyText, tryFastAbortFromMessage } from "./abort.js";
import { handleStopCommand } from "./commands-session-abort.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { enqueueFollowupRun, getFollowupQueueDepth } from "./queue.js";
import { createQueueTestRun } from "./queue.test-helpers.js";

type StopFixture = {
  cfg: OpenClawConfig;
  ctx: FinalizedRuntimeMsgContext;
  entry: SessionEntry;
  params: HandleCommandsParams;
  storePath: string;
  target: ReturnType<typeof captureSessionTarget>;
  isCommandTargetCurrent: NonNullable<
    NonNullable<HandleCommandsParams["opts"]>["isCommandTargetCurrent"]
  >;
};
export function registerAbortHandoffCases({
  pathKind,
  sessionKey,
  setupStop,
}: {
  pathKind: "fast" | "command";
  sessionKey: string;
  setupStop: () => Promise<StopFixture>;
}) {
  it.each([
    { waiting: false, abortable: true },
    { waiting: true, abortable: true },
    { waiting: true, abortable: false },
  ])(
    "reports a captured local wait only for accepted cancellation: %j",
    async ({ waiting, abortable }) => {
      const state = await setupStop();
      const runId = `cancel-wait-${pathKind}`;
      registerAgentRunContext(runId, { sessionKey, agentId: "main" });
      const context = expectDefined(getAgentRunContext(runId), "run context");
      context.localModelWait = waiting ? { requestId: "request-1" } : undefined;
      const operation = createReplyOperation({
        sessionKey,
        sessionId: state.entry.sessionId,
        target: state.target,
        agentId: "main",
        resetTriggered: false,
      });
      operation.attachBackend({
        kind: "embedded",
        runId,
        cancel: () => {
          context.localModelWait = undefined;
          queueMicrotask(() => operation.complete());
        },
      });
      if (!abortable) {
        operation.freezeAbort();
      }
      try {
        const result =
          pathKind === "fast"
            ? await tryFastAbortFromMessage(state)
            : await handleStopCommand(state.params, true);
        const text =
          result && "handled" in result
            ? formatAbortReplyText(
                result.stoppedSubagents,
                result.rejectionReason,
                result.failedSubagents,
                result.localModelMayStillBeFinishing,
              )
            : result?.reply?.text;
        expect(text).toBe(
          abortable
            ? `⚙️ Agent was aborted.${waiting ? " Cancellation requested; the local model may still be finishing." : ""}`
            : "Agent reply is already finalizing and can no longer be aborted.",
        );
      } finally {
        operation.complete();
        clearAgentRunContext(runId);
      }
    },
  );

  it("clears captured inputs before cancellation without discarding later arrivals", async () => {
    const state = await setupStop();
    const queued = (prompt: string) => {
      const input = createQueueTestRun({ prompt });
      input.run.config = state.cfg;
      input.run.agentId = "main";
      input.run.sessionKey = sessionKey;
      input.run.sessionId = state.entry.sessionId;
      return input;
    };
    const operation = createReplyOperation({
      sessionKey,
      sessionId: state.entry.sessionId,
      target: state.target,
      resetTriggered: false,
    });
    enqueueFollowupRun(
      sessionKey,
      queued("captured"),
      { mode: "collect", debounceMs: 0, cap: 20, dropPolicy: "summarize" },
      "none",
    );
    const cancelled = createDeferred();
    let depthAtCancellation: number | undefined;
    operation.attachBackend({
      kind: "embedded",
      isStreaming: () => true,
      cancel: () => {
        depthAtCancellation = getFollowupQueueDepth(sessionKey);
        enqueueFollowupRun(
          sessionKey,
          queued("arrived after capture"),
          { mode: "collect", debounceMs: 0, cap: 20, dropPolicy: "summarize" },
          "none",
        );
        cancelled.resolve();
      },
    });
    let done = false;
    const stopping = (
      pathKind === "fast" ? tryFastAbortFromMessage(state) : handleStopCommand(state.params, true)
    ).finally(() => {
      done = true;
    });
    onTestFinished(async () => {
      operation.complete();
      await stopping;
    });
    await cancelled.promise;
    expect(depthAtCancellation).toBe(0);
    expect(done).toBe(false);
    expect(getFollowupQueueDepth(sessionKey)).toBe(1);
    operation.complete();
    await stopping;
    expect(getFollowupQueueDepth(sessionKey)).toBe(1);
  });

  it("preserves a replacement run and its queued input after dispatch handoff", async () => {
    const state = await setupStop();
    const admitted = createReplyOperation({
      sessionKey,
      sessionId: "session-a",
      target: state.target,
      resetTriggered: false,
    });
    const dispatch = createDeferred();
    expect(state.isCommandTargetCurrent()).toBe(true);
    const pending = dispatch.promise.then(async () =>
      pathKind === "fast" ? tryFastAbortFromMessage(state) : handleStopCommand(state.params, true),
    );
    admitted.complete();
    await replaceSessionEntry(
      { storePath: state.storePath, sessionKey },
      {
        sessionId: "session-b",
        updatedAt: Date.now(),
      },
    );
    const replacement = createReplyOperation({
      sessionKey,
      sessionId: "session-b",
      target: captureSessionTarget({ ...state.target, incarnation: "session-b" }),
      resetTriggered: false,
    });
    replacement.attachBackend({ kind: "embedded", cancel: () => {}, isStreaming: () => true });
    const queued = createQueueTestRun({ prompt: "next conversation" });
    queued.run.config = state.cfg;
    queued.run.agentId = "main";
    queued.run.sessionKey = sessionKey;
    queued.run.sessionId = "session-b";
    enqueueFollowupRun(
      sessionKey,
      queued,
      { mode: "collect", debounceMs: 0, cap: 20, dropPolicy: "summarize" },
      "none",
    );
    dispatch.resolve();
    const result = await pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(replacement.abortSignal.aborted).toBe(false);
    expect(result).toBeInstanceOf(Error);
    expect(getFollowupQueueDepth(sessionKey)).toBe(1);
    expect(
      loadSessionEntry({ storePath: state.storePath, sessionKey })?.abortedLastRun,
    ).toBeUndefined();
    replacement.complete();
  });
}
