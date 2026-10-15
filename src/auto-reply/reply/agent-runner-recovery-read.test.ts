import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import * as entryReads from "../../config/sessions/session-entry-read-runtime.js";
import {
  rootDir,
  runEmbeddedAgentMock,
  setupAgentRunnerTestHooks,
} from "./agent-runner.misc.runreplyagent.test-support.js";
import { createBaseRun } from "./agent-runner.runreplyagent.test-support.js";
import { enqueueFollowupRun } from "./queue.js";
import { REPLY_ADMISSION_TICKET, reserveReplyAdmissionTicket } from "./reply-admission-ticket.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { setChannelSourceTurnId } from "./source-turn-id.js";

setupAgentRunnerTestHooks();
afterEach(() => vi.restoreAllMocks());

it("queues non-steering input while recovery metadata is unavailable", async () => {
  const sessionEntry = { sessionId: "session", updatedAt: 1 };
  const storePath = path.join(rootDir, "sessions.json");
  await replaceSessionEntry({ storePath, sessionKey: "main" }, sessionEntry);
  const read = vi
    .spyOn(entryReads, "readSessionEntryInWorker")
    .mockRejectedValueOnce(new Error("Recovery metadata is unavailable"));
  vi.mocked(enqueueFollowupRun).mockReturnValueOnce(true);
  const state: ReplyOperationRunState = {};
  const { run } = createBaseRun({
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

  await run();

  expect(state.admission).toEqual({ status: "accepted", mode: "followup" });
  expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

it.each(["source", "steer"] as const)(
  "releases reply admission and typing when the %s recovery read fails",
  async (reason) => {
    const failure = new Error("synthetic recovery read failure");
    vi.spyOn(entryReads, "readSessionEntryInWorker").mockRejectedValueOnce(failure);
    const ticket = reserveReplyAdmissionTicket(["main"]);
    if (!ticket) {
      throw new Error("expected a reply admission ticket");
    }
    const release = vi.spyOn(ticket, "release");
    const { run, typing, sessionCtx } = createBaseRun({
      reply: {
        sessionKey: "main",
        opts: { [REPLY_ADMISSION_TICKET]: ticket },
        storePath: path.join(rootDir, "sessions.json"),
        shouldSteer: reason === "steer",
        isActive: reason === "steer",
      },
    });
    if (reason === "source") {
      setChannelSourceTurnId(sessionCtx, "channel-user:recovery-source");
    }

    await expect(run()).rejects.toBe(failure);

    expect(release).toHaveBeenCalledOnce();
    expect(typing.cleanup).toHaveBeenCalledOnce();
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  },
);
