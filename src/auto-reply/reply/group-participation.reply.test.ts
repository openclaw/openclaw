import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { loadSessionEntry, loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { isIndexedSessionEntry } from "../../config/sessions/session-entry-codec.js";
import type { DecisionOutcome } from "../../decisions/types.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import type { ReplyPayload } from "../types.js";
import { judgment } from "./group-participation.decision.test-support.js";
import { createGroupReplyFixture } from "./group-participation.reply.test-support.js";

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
  return (Array.isArray(reply) ? reply : reply ? [reply] : []).map((payload) => payload.text);
}
let fixture: Awaited<ReturnType<typeof createGroupReplyFixture>>;
beforeAll(async () => {
  fixture = await createGroupReplyFixture();
});
afterAll(async () => {
  await fixture.close();
});
beforeEach(() => {
  decision.mockReset();
});

it("keeps explicitly mentioned requests on the ordinary reply path", async () => {
  const previousRequests = fixture.requests.length;
  const previousPartials = fixture.partials.length;
  fixture.respond(answer("Use port 443."));
  expect(
    texts(await fixture.reply("Which port?", "mentioned-source", "-10006", undefined, true)),
  ).toContain("Use port 443.");
  expect(decision).not.toHaveBeenCalled();
  expect(fixture.requests).toHaveLength(previousRequests + 1);
  expect(fixture.partials.slice(previousPartials).join("")).toContain("Use port 443.");
});

it("streams invited replies and observes chatter without starting a primary run", async () => {
  const previousRequests = fixture.requests.length;
  fixture.respond(answer("Use port 443."));
  decision.mockImplementation(async (batch) => judgment(batch, { attention: "engagement" }));
  expect(texts(await fixture.reply("Agent, which port should I use?", "invited-source"))).toContain(
    "Use port 443.",
  );
  expect(fixture.partials.join("")).toContain("Use port 443.");
  expect(fixture.requests).toHaveLength(previousRequests + 1);
  expect(fixture.typing()).toBeGreaterThan(0);
  const previousTyping = fixture.typing();
  const previousPartials = fixture.partials.length;
  decision.mockImplementation(async (batch) => judgment(batch, { attention: "none" }));
  expect(texts(await fixture.reply("Bob, see you at lunch.", "observed-source"))).toEqual([
    "NO_REPLY",
  ]);
  expect(fixture.requests).toHaveLength(previousRequests + 1);
  expect(fixture.typing()).toBe(previousTyping);
  expect(fixture.partials).toHaveLength(previousPartials);
  const sessionKey = "agent:main:telegram:group:-10001";
  const entry = loadSessionEntry({ storePath: fixture.storePath, sessionKey });
  if (!entry) {
    throw new Error("The reply flow did not create its session");
  }
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

it("runs an opportunity through ordinary tools, streaming and delivery without draft review", async () => {
  const previousTyping = fixture.typing();
  const previousPartials = fixture.partials.length;
  const previousRequests = fixture.requests.length;
  const previousSent = fixture.sent.length;
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
    answer("The published TLS port is 443."),
  );
  decision.mockImplementation(async (batch) => judgment(batch, { attention: "opportunity" }));
  const delivered = await fixture.dispatch(
    "Bob, do you know the published TLS port?",
    "opportunity-source",
    "-10002",
  );
  expect(delivered.queuedFinal).toBe(true);
  expect(fixture.sent.slice(previousSent)).toEqual(["The published TLS port is 443."]);
  expect(decision).toHaveBeenCalledTimes(1);
  expect(decision.mock.calls[0]?.[1].purpose).toBe("group.participation.attention");
  expect(fixture.requests).toHaveLength(previousRequests + 2);
  expect(fixture.requests[previousRequests]).toMatchObject({
    tools: expect.arrayContaining([
      expect.objectContaining({ function: expect.objectContaining({ name: "exec" }) }),
    ]),
  });
  expect(fixture.typing()).toBeGreaterThan(previousTyping);
  expect(fixture.partials.slice(previousPartials).join("")).toContain(
    "The published TLS port is 443.",
  );
});

it("does not editorially withhold or regenerate an admitted answer", async () => {
  const previousRequests = fixture.requests.length;
  fixture.respond(answer("Can you send the report?"));
  decision.mockImplementation(async (batch) => judgment(batch, { attention: "opportunity" }));
  expect(
    texts(await fixture.reply("Bob, is the report available?", "clarification-source", "-10003")),
  ).toContain("Can you send the report?");
  expect(decision).toHaveBeenCalledTimes(1);
  expect(fixture.requests).toHaveLength(previousRequests + 1);

  // Generated replies use ordinary history, just like directly invited answers.
  const nextRequest = fixture.requests.length;
  fixture.respond(answer("I can check the new report."));
  await fixture.reply("Please check now.", "later-invitation", "-10003", undefined, true);
  expect(JSON.stringify(fixture.requests[nextRequest])).toContain("Can you send the report?");
});

it("uses ordinary streaming and tools when the preflight decision is unavailable", async () => {
  const previousRequests = fixture.requests.length;
  const previousPartials = fixture.partials.length;
  fixture.respond(answer("Ordinary answer after the outage."));
  decision.mockResolvedValue(unavailable);
  expect(
    texts(await fixture.reply("Bob, which port should I use?", "outage-source", "-10004")),
  ).toContain("Ordinary answer after the outage.");
  expect(decision).toHaveBeenCalledTimes(1);
  expect(fixture.requests).toHaveLength(previousRequests + 1);
  expect(fixture.requests[previousRequests]).toMatchObject({
    tools: expect.arrayContaining([
      expect.objectContaining({ function: expect.objectContaining({ name: "exec" }) }),
    ]),
  });
  expect(fixture.partials.slice(previousPartials).join("")).toContain(
    "Ordinary answer after the outage.",
  );
});
