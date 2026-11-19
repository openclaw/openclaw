import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { isIndexedSessionEntry } from "../../config/sessions/session-entry-codec.js";
import { readSessionEntryInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { DecisionOutcome } from "../../decisions/host-outcomes.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import type { ReplyPayload } from "../types.js";
import { judgment } from "./group-participation.decision.test-support.js";
import { createGroupReplyFixture } from "./group-participation.reply.test-support.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";

const decision = vi.hoisted(() =>
  vi.fn<typeof import("../../decisions/runtime.js").evaluateDecision>(),
);
vi.mock("../../decisions/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../decisions/runtime.js")>()),
  evaluateDecision: decision,
}));

const answer = (content: string) => ({ delta: { role: "assistant", content } });
const unavailable: DecisionOutcome = { status: "unavailable", reason: "overloaded" };
function texts(reply: ReplyPayload | ReplyPayload[] | undefined) {
  return (Array.isArray(reply) ? reply : reply ? [reply] : []).flatMap((payload) =>
    payload.text ? [payload.text] : [],
  );
}
let fixture: Awaited<ReturnType<typeof createGroupReplyFixture>>;
afterEach(async () => {
  await fixture.close();
});
beforeEach(async () => {
  fixture = await createGroupReplyFixture();
  decision.mockReset();
});

it("observes chatter without typing or generation and persists its source", async () => {
  const previousRequests = fixture.requests.length;
  const previousTyping = fixture.typing();
  const previousPartials = fixture.partials.length;
  decision.mockImplementation(async (batch) => judgment(batch, { attention: "none" }));
  expect(texts(await fixture.reply("Bob, see you at lunch.", "observed-source"))).toEqual([]);
  expect(decision).toHaveBeenCalledOnce();
  expect(fixture.requests).toHaveLength(previousRequests);
  expect(fixture.typing()).toBe(previousTyping);
  expect(fixture.partials).toHaveLength(previousPartials);
  const sessionKey = "agent:main:telegram:group:-10001";
  const entry = await readSessionEntryInWorker({ storePath: fixture.storePath, sessionKey });
  if (!entry) {
    throw new Error("The reply flow did not create its session");
  }
  expect(entry.status).toBe("done");
  expect(entry.lifecycleRunId).toBeUndefined();
  const events = await loadTranscriptEvents({
    agentId: "main",
    sessionId: entry.sessionId,
    sessionKey,
    storePath: fixture.storePath,
  });
  expect(
    events.some(
      (event) =>
        isIndexedSessionEntry(event) &&
        event.type === "message" &&
        event.message.role === "user" &&
        extractTextFromChatContent(event.message.content, {
          joinWith: "\n",
          normalizeText: (text) => text,
        })?.includes("Bob, see you at lunch."),
    ),
  ).toBe(true);
});

it.each(["engagement", "opportunity", "unavailable"] as const)(
  "preserves ordinary tools, streaming, delivery and history after %s",
  async (attention) => {
    const previousRequests = fixture.requests.length;
    const previousTyping = fixture.typing();
    const previousPartials = fixture.partials.length;
    const previousSent = fixture.sent.length;
    const runState: ReplyOperationRunState = {};
    const final = "The TLS port is 443. Can you send the report?";
    const groupId = `-10002-${attention}`;
    fixture.respond(
      {
        delta: {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "read-port",
              type: "function",
              function: { name: "read", arguments: JSON.stringify({ path: fixture.lookupPath }) },
            },
          ],
        },
        stop: "tool_calls",
      },
      answer(final),
    );
    decision.mockImplementation(async (batch) =>
      attention === "unavailable" ? unavailable : judgment(batch, { attention }),
    );
    const delivered = await fixture.dispatch("Bob, which TLS port?", "source", groupId, {
      [REPLY_OPERATION_RUN_STATE]: runState,
    });
    expect(delivered.queuedFinal).toBe(true);
    expect(runState.replyCompletion?.expectation).toBe("required");
    expect(fixture.sent.slice(previousSent)).toEqual([final]);
    expect(decision).toHaveBeenCalledOnce();
    expect(fixture.requests).toHaveLength(previousRequests + 2);
    expect(fixture.requests[previousRequests]).toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({ function: expect.objectContaining({ name: "exec" }) }),
      ]),
    });
    expect(JSON.stringify(fixture.requests[previousRequests + 1])).toContain(
      "The published TLS port is 443.",
    );
    expect(fixture.typing()).toBeGreaterThan(previousTyping);
    expect(fixture.partials.slice(previousPartials).join("")).toContain(final);
    fixture.respond(answer("I can check the new report."));
    const mentionedPartials = fixture.partials.length;
    expect(
      texts(await fixture.reply("Please check now.", "later-invitation", groupId, undefined, true)),
    ).toContain("I can check the new report.");
    expect(fixture.partials.slice(mentionedPartials).join("")).toContain(
      "I can check the new report.",
    );
    expect(decision).toHaveBeenCalledOnce();
    expect(JSON.stringify(fixture.requests.at(-1))).toContain(final);
  },
);
