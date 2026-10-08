import { expect, it, vi } from "vitest";
import { forkReplySession } from "./plugin-command-conversation-fork-reply-cut.js";

const forkSessionAtMessage = vi.hoisted(() => vi.fn(async () => ({ status: "created" })));

// mock-isolation: Keep stateful Gateway, session, and channel effects synthetic for this fork contract test.
vi.mock("../config/sessions/session-accessor.js", () => ({ forkSessionAtMessage }));

it("uses the canonical message-cut owner for reply forks", async () => {
  const params = {
    sessionKey: "agent:main:source",
    entryId: "user-1",
    targetKey: "agent:main:fork",
  };
  const expected = { sessionId: "source-id", lifecycleRevision: "source-rev" };
  await expect(forkReplySession(params, expected)).resolves.toEqual({ status: "created" });
  expect(forkSessionAtMessage).toHaveBeenCalledWith(params, expected);
});
