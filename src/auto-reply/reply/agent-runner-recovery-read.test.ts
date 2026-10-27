import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { GENERIC_EXTERNAL_RUN_FAILURE_TEXT } from "../../agents/failover/user-copy.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import * as entryReads from "../../config/sessions/session-entry-read-runtime.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { reserveSessionControllerSource } from "../../sessions/session-controller.mailbox.js";
import {
  rootDir,
  runEmbeddedAgentMock,
  setupAgentRunnerTestHooks,
} from "./agent-runner.misc.runreplyagent.test-support.js";
import { createBaseRun } from "./agent-runner.runreplyagent.test-support.js";
import { enqueueFollowupRun } from "./queue.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { bindReplySourceInput } from "./reply-source-binding.js";
import { setChannelSourceTurnId } from "./source-turn-id.js";

setupAgentRunnerTestHooks();
afterEach(() => vi.restoreAllMocks());

it("queues non-steering input while session metadata is unavailable", async () => {
  const sessionEntry = { sessionId: "session", updatedAt: 1 };
  const storePath = path.join(rootDir, "sessions.json");
  await replaceSessionEntry({ storePath, sessionKey: "main" }, sessionEntry);
  const read = vi
    .spyOn(entryReads, "readSessionEntryInWorker")
    .mockRejectedValueOnce(new Error("Session metadata is unavailable"));
  vi.mocked(enqueueFollowupRun).mockReturnValueOnce(true);
  const state: ReplyOperationRunState = {};
  const { run, resolvedQueue } = createBaseRun({
    context: { Provider: "webchat" },
    reply: {
      sessionKey: "main",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      storePath,
      shouldFollowup: true,
      isActive: true,
      opts: { [REPLY_OPERATION_RUN_STATE]: state },
    },
  });

  resolvedQueue.mode = "followup";
  await run();

  expect(state.admission).toEqual({ status: "accepted", mode: "followup" });
  expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

it.each(["source", "steer"] as const)(
  "reports failure and retires the captured source and typing when the %s session read fails",
  async (reason) => {
    const failure = new Error("synthetic session read failure");
    const read = vi.spyOn(entryReads, "readSessionEntryInWorker").mockRejectedValueOnce(failure);
    const storePath = path.join(rootDir, "sessions.json");
    const input = reserveSessionControllerSource("main", {
      target: captureSessionTarget({ storeScope: storePath, sessionKey: "main", agentId: "main" }),
      policy: { mode: "interrupt" },
    });
    const { run, typing, sessionCtx } = createBaseRun({
      reply: {
        sessionKey: "main",
        opts: bindReplySourceInput({ abortSignal: input.abortSignal }, input),
        storePath,
        shouldSteer: reason === "steer",
        isActive: reason === "steer",
      },
    });
    if (reason === "source") {
      setChannelSourceTurnId(sessionCtx, "channel-user:read-failure-source");
    }

    await expect(run()).resolves.toEqual({
      isError: true,
      text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
    });

    await input.settlement.promise;
    expect(input.phase).toBe("consumed");
    expect(input.mailbox.entries).not.toContain(input);
    expect(read).toHaveBeenCalledOnce();
    expect(typing.cleanup).toHaveBeenCalledOnce();
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  },
);
