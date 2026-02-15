import { describe, expect, it } from "vitest";
import { peekSystemEvents, resetSystemEventsForTest } from "../infra/system-events.js";
import {
  clearPollAnswerCacheForTest,
  enqueuePollAnswerEvent,
  recordSentPollContext,
} from "./poll-answer-cache.js";

describe("poll answer cache", () => {
  it("enqueues a system event with selected option labels", () => {
    clearPollAnswerCacheForTest();
    resetSystemEventsForTest();
    recordSentPollContext({
      pollId: "p1",
      sessionKey: "agent:demo:main",
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
    });

    const summary = enqueuePollAnswerEvent({
      pollId: "p1",
      userLabel: "Krish",
      optionIds: [1],
    });

    expect(summary).toBeTruthy();
    expect(summary?.selectionText).toBe("Sushi");
    const events = peekSystemEvents("agent:demo:main");
    expect(events.at(-1)).toContain('selected "Sushi"');
    expect(events.at(-1)).toContain('for "Lunch?"');
  });
});
