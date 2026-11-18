import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { isIndexedSessionEntry } from "../../config/sessions/session-entry-codec.js";
import { readSessionEntryInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { getSessionControllerOperation } from "../../sessions/session-controller.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import {
  readGroupParticipationInputs,
  recordGroupParticipationInput,
} from "./group-participation-inputs.js";
import { judgment } from "./group-participation.decision.test-support.js";
import { createGroupReplyFixture } from "./group-participation.reply.test-support.js";

const decision = vi.hoisted(() =>
  vi.fn<typeof import("../../decisions/runtime.js").evaluateDecision>(),
);
vi.mock("../../decisions/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../decisions/runtime.js")>()),
  evaluateDecision: decision,
}));

let fixture: Awaited<ReturnType<typeof createGroupReplyFixture>>;
beforeAll(async () => {
  fixture = await createGroupReplyFixture("whatsapp");
  fixture.config.agents!.defaults!.typingMode = "instant";
});
afterAll(async () => {
  await fixture.close();
});

beforeEach(() => {
  decision.mockReset();
});

it.for([
  { initial: "none", attention: "none" },
  { initial: "engagement", attention: "engagement" },
  { initial: "none", attention: "engagement" },
] as const)(
  "waits for a queued WhatsApp group's $initial -> $attention decision before typing",
  async ({ initial, attention }, { signal }) => {
    const modelStarted = createDeferred();
    const releaseModel = createDeferred();
    const queuedSettled = createDeferred();
    const queuedPublished = createDeferred();
    let queued: ReturnType<typeof fixture.dispatch> | undefined;
    let ownerSettlement: Promise<void> | undefined;
    const previousRequests = fixture.requests.length;
    const previousTyping = fixture.typing();
    const groupId =
      initial !== attention
        ? "120363000000006@g.us"
        : attention === "none"
          ? "120363000000001@g.us"
          : "120363000000002@g.us";
    const typingEvents: Array<{ decisions: number; requests: number }> = [];
    const onReplyStart = vi.fn(() => {
      typingEvents.push({
        decisions: decision.mock.calls.length,
        requests: fixture.requests.length - previousRequests,
      });
    });
    let typingBeforeDecision = -1;
    decision.mockImplementationOnce(async (batch) => judgment(batch, { attention: initial }));
    decision.mockImplementation(async (batch) => judgment(batch, { attention }));
    fixture.respond({
      delta: { role: "assistant", content: "Use port 443." },
      beforeResponse: async () => {
        modelStarted.resolve();
        await releaseModel.promise;
      },
    });
    if (attention === "engagement") {
      fixture.respond({ delta: { role: "assistant", content: "The queued answer." } });
    }
    const first = fixture.dispatch(
      "Agent, which port?",
      `invited-before-${attention}`,
      groupId,
      undefined,
      true,
    );
    try {
      await withinTest(
        awaitGateBeforeSettlement(modelStarted.promise, first, "The invited reply did not start"),
        signal,
      );
      expect(fixture.typing()).toBeGreaterThan(previousTyping);
      queued = fixture.dispatch(
        "Bob, which port?",
        `queued-${attention}`,
        groupId,
        {
          onReplyStart,
          progressRequiresReply: true,
          onRunVerbosityResolved: () => {
            const operation = getSessionControllerOperation(`agent:main:whatsapp:group:${groupId}`);
            if (!operation) {
              throw new Error("The queued reply owner is missing");
            }
            ownerSettlement = operation.ownerSettlement;
            if (initial === attention) {
              return;
            }
            const source = readGroupParticipationInputs(operation).sources[0];
            if (!source) {
              throw new Error("The queued group source is missing");
            }
            recordGroupParticipationInput(operation, {
              userTurnTranscriptRecorder: source.recorder,
              messageId: "accepted-during-queued-preflight",
              run: { messageProvider: "whatsapp" },
            });
          },
          onQueuedFollowupSettled: () => queuedSettled.resolve(),
        },
        false,
        () => queuedPublished.resolve(),
      );
      await withinTest(
        awaitGateBeforeSettlement(
          queuedPublished.promise,
          queued,
          "The queued dispatch did not publish",
        ),
        signal,
      );
      expect(decision).not.toHaveBeenCalled();
      typingBeforeDecision = onReplyStart.mock.calls.length;
    } finally {
      releaseModel.resolve();
      await first;
      await queued;
    }
    await withinTest(queuedSettled.promise, signal);
    await ownerSettlement;
    expect(typingBeforeDecision).toBe(0);
    const decisions = initial === attention ? 1 : 2;
    expect(decision).toHaveBeenCalledTimes(decisions);
    expect(fixture.requests.length - previousRequests).toBe(attention === "none" ? 1 : 2);
    expect(typingEvents).toEqual(attention === "none" ? [] : [{ decisions, requests: 1 }]);
    if (attention === "engagement") {
      expect(fixture.sent).toContain("The queued answer.");
    }
  },
);

it("keeps a fresh WhatsApp group input quiet while the decision is pending and after silence", async ({
  signal,
}) => {
  const decisionStarted = createDeferred();
  const releaseDecision = createDeferred();
  const previousRequests = fixture.requests.length;
  const previousPartials = fixture.partials.length;
  const onReplyStart = vi.fn();
  decision.mockImplementation(async (batch) => {
    decisionStarted.resolve();
    await releaseDecision.promise;
    return judgment(batch, { attention: "none" });
  });
  const reply = fixture.reply("Bob, see you at lunch.", "fresh-silence", "120363000000003@g.us", {
    onReplyStart,
  });
  try {
    await withinTest(
      awaitGateBeforeSettlement(decisionStarted.promise, reply, "The decision did not start"),
      signal,
    );
    expect(onReplyStart).not.toHaveBeenCalled();
    expect(fixture.requests).toHaveLength(previousRequests);
  } finally {
    releaseDecision.resolve();
    await reply;
  }
  const result = await reply;
  expect(
    (Array.isArray(result) ? result : [result]).flatMap((payload) =>
      payload?.text ? [payload.text] : [],
    ),
  ).toEqual([]);
  expect(fixture.partials).toHaveLength(previousPartials);
  expect(onReplyStart).not.toHaveBeenCalled();
  expect(fixture.requests).toHaveLength(previousRequests);
  const sessionKey = "agent:main:whatsapp:group:120363000000003@g.us";
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

it.for([undefined, "never"] as const)(
  "applies typing mode %s before an approved WhatsApp reply's model request",
  async (typingMode) => {
    fixture.config.agents!.defaults!.typingMode = typingMode;
    const previousRequests = fixture.requests.length;
    const typingRequests: number[] = [];
    decision.mockImplementation(async (batch) => judgment(batch, { attention: "engagement" }));
    fixture.respond({ delta: { role: "assistant", content: "Use port 443." } });
    try {
      const reply = await fixture.reply(
        "Agent, which port should I use?",
        `approved-${typingMode ?? "default"}`,
        typingMode === "never" ? "120363000000005@g.us" : "120363000000004@g.us",
        {
          onReplyStart: () => {
            typingRequests.push(fixture.requests.length - previousRequests);
          },
        },
      );
      expect(Array.isArray(reply) ? reply : [reply]).toEqual(
        expect.arrayContaining([expect.objectContaining({ text: "Use port 443." })]),
      );
      expect(fixture.requests).toHaveLength(previousRequests + 1);
      expect(typingRequests).toEqual(typingMode === "never" ? [] : [0]);
    } finally {
      fixture.config.agents!.defaults!.typingMode = "instant";
    }
  },
);
