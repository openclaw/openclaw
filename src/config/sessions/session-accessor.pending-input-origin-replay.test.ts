import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it } from "vitest";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { captureRequesterOrigin } from "../../agents/requester-origin.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { buildPersistedUserTurnMessage } from "../../sessions/user-turn-transcript.message.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { upsertSessionEntryCore } from "./session-accessor.js";
import {
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import { useTempSessionsFixture } from "./test-helpers.js";

const fixture = useTempSessionsFixture("pending-input-origin-replay-");
const receipts: SessionPendingInputReceipt[] = [];
afterEach(async () => {
  for (const receipt of receipts.splice(0)) {
    receipt.finish("interrupted");
    await receipt.settled?.();
  }
  await closeOpenClawAgentDatabasesAsync();
});

it("preserves pre-normalization requester hashes without reviving unfinished input", async () => {
  const scope = {
    agentId: "main",
    sessionKey: "agent:main:origin-replay",
    sessionId: "origin-replay",
    storePath: fixture.storePath(),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  for (const completed of [false, true]) {
    const runId = `origin-replay-${completed}`;
    const origin = { sessionKey: scope.sessionKey, operatorProfileId: "gateway-owner" };
    const message = buildPersistedUserTurnMessage({
      text: "Private worker result",
      display: false,
      idempotencyKey: `${runId}:user`,
      requesterOrigin: captureRequesterOrigin(origin),
    });
    const stage = async (input = message) => {
      const receipt = expectDefined(
        await stageSessionPendingInput(scope, {
          runId,
          message: input,
          trackCompletion: true,
          assertCurrent: () => {},
        }),
        "accepted private input",
      );
      receipts.push(receipt);
      return receipt;
    };
    // The old producer hashed these own properties before JSON storage omitted them.
    const first = await stage({
      ...message,
      __openclaw: {
        ...message["__openclaw"],
        requesterOrigin: {
          ...origin,
          messageProvider: undefined,
          accountId: undefined,
          chatType: undefined,
          conversationId: undefined,
          messageThreadId: undefined,
          groupId: undefined,
          groupChannel: undefined,
          groupSpace: undefined,
          senderId: undefined,
          senderName: undefined,
          senderUsername: undefined,
          senderE164: undefined,
        },
      },
    });
    const outcome = buildAgentRunTerminalOutcome({ status: "ok" });
    if (completed) {
      await first.completeAsync!(outcome);
    }
    first.finish("interrupted");
    await first.settled?.();
    rotateAgentEventLifecycleGeneration();
    await closeOpenClawAgentDatabasesAsync();
    await expect(stage({ ...message, content: "Changed worker result" })).rejects.toThrow(
      /conflicts with the accepted input/,
    );
    await expect(
      stage({
        ...message,
        __openclaw: {
          ...message["__openclaw"],
          requesterOrigin: { ...origin, operatorProfileId: "different-requester" },
        },
      }),
    ).rejects.toThrow(/conflicts with the accepted input/);
    if (!completed) {
      await expect(stage()).rejects.toThrow("ownership ended");
      continue;
    }
    const replay = await stage();
    expect(replay).toMatchObject({ state: "consumed", completion: outcome });
    expect(() => replay.run(() => {})).toThrow("already completed");
    replay.finish("interrupted");
    await replay.settled?.();
  }
});
