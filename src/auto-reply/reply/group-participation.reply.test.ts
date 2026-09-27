import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { loadSessionEntry, loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { isIndexedSessionEntry } from "../../config/sessions/session-entry-codec.js";
import type { DecisionBatch, DecisionOutcome } from "../../decisions/types.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { ReplyPayload } from "../types.js";
import { judgment } from "./group-participation.decision.test-support.js";
import { createGroupReplyFixture } from "./group-participation.reply.test-support.js";

const decision = vi.hoisted(() =>
  vi.fn<typeof import("../../decisions/runtime.js").evaluateDecision>(),
);
vi.mock("../../decisions/runtime.js", () => ({ evaluateDecision: decision }));

const answer = (content: string) => ({ delta: { role: "assistant", content } });
const unavailable: DecisionOutcome = { status: "unavailable", reason: "overloaded" };
const useful = {
  attention: "opportunity",
  fit: "applicable",
  effect: "substantive",
  coverage: "complete",
};
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

it("uses read tools privately and judges the actual lookup and contribution", async () => {
  const previousTyping = fixture.typing();
  const previousPartials = fixture.partials.length;
  const previousRequests = fixture.requests.length;
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
  let reviewed: DecisionBatch | undefined;
  decision.mockImplementation(async (batch, options) => {
    if (options.purpose === "group.participation.publication") {
      reviewed = batch;
    }
    return judgment(batch, useful);
  });
  const delivered = await fixture.dispatch(
    "Bob, do you know the published TLS port?",
    "opportunity-source",
    "-10002",
  );
  expect(delivered.queuedFinal).toBe(true);
  expect(fixture.sent).toEqual(["The published TLS port is 443."]);
  expect(reviewed?.state).toMatchObject({
    contribution: {
      draft: [{ text: "The published TLS port is 443.", media: [] }],
      completedLookups: [
        {
          tool: "read",
          error: false,
          result: expect.stringContaining("The published TLS port is 443."),
        },
      ],
    },
  });
  expect(fixture.requests).toHaveLength(previousRequests + 2);
  expect(fixture.requests[previousRequests]).not.toMatchObject({
    tools: expect.arrayContaining([
      expect.objectContaining({ function: expect.objectContaining({ name: "exec" }) }),
    ]),
  });
  expect(fixture.typing()).toBe(previousTyping);
  expect(fixture.partials).toHaveLength(previousPartials);
});

it("withholds clarification-only unsolicited replies", async () => {
  const previousTyping = fixture.typing();
  const previousPartials = fixture.partials.length;
  fixture.respond(answer("I couldn't find it. Can you send the report?"));
  decision.mockImplementation(async (batch) =>
    judgment(batch, { ...useful, effect: "missing_input_or_limitation" }),
  );
  expect(
    texts(await fixture.reply("Bob, is the report available?", "limitation-source", "-10003")),
  ).toEqual([]);
  expect(fixture.typing()).toBe(previousTyping);
  expect(fixture.partials).toHaveLength(previousPartials);
});

it("revises a partly useful contribution and reviews the complete replacement", async () => {
  fixture.respond(
    answer("Use TLS port 443. Disable certificate checks."),
    answer("Use TLS port 443."),
  );
  const drafts: unknown[] = [];
  decision.mockImplementation(async (batch, options) => {
    if (options.purpose === "group.participation.publication") {
      drafts.push(batch.state);
    }
    return judgment(batch, { ...useful, coverage: drafts.length === 1 ? "partial" : "complete" });
  });
  expect(
    texts(await fixture.reply("Bob, what is the TLS port?", "revision-source", "-10007")),
  ).toEqual(["Use TLS port 443."]);
  expect(drafts).toHaveLength(2);
  expect(drafts[0]).toMatchObject({
    contribution: { draft: [{ text: "Use TLS port 443. Disable certificate checks." }] },
  });
  expect(drafts[1]).toMatchObject({ contribution: { draft: [{ text: "Use TLS port 443." }] } });
});

it("restores ordinary streaming and tools when the publication decision is unavailable", async () => {
  const previousRequests = fixture.requests.length;
  const previousPartials = fixture.partials.length;
  fixture.respond(
    answer("Private provisional answer."),
    answer("Ordinary answer after the outage."),
  );
  decision.mockImplementation(async (batch, options) =>
    options.purpose === "group.participation.publication" ? unavailable : judgment(batch, useful),
  );
  expect(
    texts(await fixture.reply("Bob, which port should I use?", "outage-source", "-10004")),
  ).toContain("Ordinary answer after the outage.");
  expect(fixture.requests).toHaveLength(previousRequests + 2);
  expect(fixture.requests[previousRequests + 1]).toMatchObject({
    tools: expect.arrayContaining([
      expect.objectContaining({ function: expect.objectContaining({ name: "exec" }) }),
    ]),
  });
  expect(fixture.partials.slice(previousPartials).join("")).toContain(
    "Ordinary answer after the outage.",
  );
  expect(fixture.partials.slice(previousPartials).join("")).not.toContain(
    "Private provisional answer.",
  );
});

it("incorporates an accepted human answer before publishing and keeps completed lookup evidence", async () => {
  const previousRequests = fixture.requests.length;
  const previousTyping = fixture.typing();
  const reviewing = createDeferredCore();
  const releaseReview = createDeferredCore();
  const queuedSettled = createDeferredCore();
  let answered = false;
  let deferred = false;
  fixture.respond(
    {
      delta: {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "late-read-port",
            type: "function",
            function: { name: "read", arguments: JSON.stringify({ path: fixture.lookupPath }) },
          },
        ],
      },
      stop: "tool_calls",
    },
    {
      ...answer("The published TLS port is 443."),
      beforeResponse: async () => {
        reviewing.resolve();
        await releaseReview.promise;
      },
    },
    answer("NO_REPLY"),
  );
  decision.mockImplementation(async (batch) => {
    return judgment(
      batch,
      answered ? { ...useful, attention: "none", fit: "inapplicable", coverage: "none" } : useful,
    );
  });
  const pending = fixture.reply(
    "Bob, do you know the published TLS port?",
    "late-source",
    "-10005",
  );
  await reviewing.promise;
  try {
    answered = true;
    await fixture.reply(
      "Bob answered: the TLS port is 443; this is resolved.",
      "human-answer",
      "-10005",
      {
        turnAdoptionLifecycle: {
          admission: "cancel-only",
          onDeferred: () => {
            deferred = true;
            return true;
          },
          onAdopted: () => {},
          onSettled: () => queuedSettled.resolve(),
        },
      },
    );
    expect(deferred).toBe(true);
  } finally {
    releaseReview.resolve();
  }
  expect(texts(await pending)).toEqual([]);
  await queuedSettled.promise;
  expect(fixture.requests).toHaveLength(previousRequests + 3);
  expect(JSON.stringify(fixture.requests.at(-1))).toContain("Bob answered: the TLS port is 443");
  expect(fixture.requests.at(-1)).toMatchObject({
    messages: expect.arrayContaining([
      expect.objectContaining({
        role: "tool",
        content: expect.stringContaining("The published TLS port is 443."),
      }),
    ]),
  });
  expect(fixture.typing()).toBe(previousTyping);
});
