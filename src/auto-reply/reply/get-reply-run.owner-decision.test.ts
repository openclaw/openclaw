import "./get-reply-run.runtime-mocks.test-support.js";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { testing as controllerTesting } from "../../sessions/session-controller.test-support.js";
import { bindCommandOwnerAuthority } from "../command-owner-authority.js";
import { runReplyAgent } from "./agent-runner-run.js";
import { runPreparedReply } from "./get-reply-run.js";
import { baseParams, cleanupPreparedReplyFixtures } from "./get-reply-run.test-support.js";

describe("runPreparedReply owner decision", () => {
  afterEach(async () => {
    await cleanupPreparedReplyFixtures();
    controllerTesting.resetSessionControllerForTest();
  });

  it("runs a provided reply operation with the owner decision its commands used", async () => {
    const sessionId = "session-owner-decision";
    const operation = createReplyOperation({
      sessionId,
      sessionKey: "session-key",
      resetTriggered: false,
    });
    const params = baseParams({
      isNewSession: false,
      sessionId,
      opts: { replyOperation: operation } as never,
    });
    // A configured owner whose ingress binding has ended: command auth still names the owner.
    params.command = { ...params.command, senderIsOwner: true };
    bindCommandOwnerAuthority(params.ctx, { isCurrent: () => false });
    try {
      await expect(runPreparedReply(params)).resolves.toEqual({ text: "ok" });
      const call = expectDefined(vi.mocked(runReplyAgent).mock.calls.at(-1)?.[0], "run call");
      expect(call.followupRun.run.senderIsOwner).toBe(true);
    } finally {
      operation.complete();
    }
  });
});
