import { expect, it } from "vitest";
import { buildSessionContext } from "../../../packages/agent-core/src/harness/session/session.js";
import {
  buildForkedChildTranscriptEvents,
  estimateParentForkPromptTokens,
  planParentForkDecision,
  resolveParentForkSourceTranscript,
} from "./session-accessor.sqlite-parent-fork.js";
import { isIndexedSessionEntry } from "./session-entry-codec.js";
import { buildSessionResetBoundaryEvent } from "./session-reset-boundary-event.js";
import { createSessionTranscriptHeader } from "./transcript-header.js";
import { timedMessageEvent } from "./transcript-message.test-support.js";

function createHistory() {
  const events: Record<string, unknown>[] = [
    createSessionTranscriptHeader({ sessionId: "parent", cwd: "/workspace" }),
  ];
  return {
    events,
    turn(label: string, active = false) {
      const userId = `${label}-user`;
      const timestamp = "2026-10-07T00:00:00.000Z";
      events.push(
        timedMessageEvent(userId, events.length > 1 ? events.at(-1)?.id : null, timestamp, {
          role: "user",
          content: `${label} question`,
          timestamp: 0,
        }),
        timedMessageEvent(`${label}-assistant`, userId, timestamp, {
          role: "assistant",
          content: active
            ? [{ type: "toolCall", id: `${label}-call`, name: "lookup", arguments: {} }]
            : [{ type: "text", text: `${label} answer` }],
          stopReason: active ? "toolUse" : "stop",
          timestamp: 0,
        }),
      );
    },
    reset(context: "clear" | "preserve-tail") {
      events.push(
        buildSessionResetBoundaryEvent({
          events,
          context,
          reason: "reset",
          boundaryId: `reset-${events.length}`,
        }),
      );
    },
  };
}

function expectForkContext(events: Record<string, unknown>[], expectedTurns: string[]) {
  const original = structuredClone(events);
  const source = resolveParentForkSourceTranscript(events, "last-completed");
  expect(source).not.toBeNull();
  if (!source) {
    throw new Error("expected a parent transcript");
  }
  const child = buildForkedChildTranscriptEvents({
    parentSessionFile: "parent-transcript",
    source,
    targetSessionId: "child",
  });
  expect(buildSessionContext(child.filter(isIndexedSessionEntry)).messages).toEqual(
    expectedTurns.flatMap((label) => [
      expect.objectContaining({ role: "user", content: `${label} question` }),
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: `${label} answer` }],
      }),
    ]),
  );
  expect(events).toEqual(original);
  return source;
}

it.each<[string, string[], string[]]>([
  [
    "retaining reset",
    ["discarded", "kept-1", "kept-2", "kept-3", "preserve-tail", "active"],
    ["kept-1", "kept-2", "kept-3"],
  ],
  ["clear after retaining reset", ["discarded", "preserve-tail", "clear", "active"], []],
  ["completed after reset", ["discarded", "clear", "completed", "active"], ["completed"]],
  ["empty completed prefix", ["clear", "active"], []],
])("forks %s", (_name, steps, expected) => {
  const history = createHistory();
  for (const step of steps) {
    if (step === "clear" || step === "preserve-tail") {
      history.reset(step);
    } else {
      history.turn(step, step === "active");
    }
  }
  expectForkContext(history.events, expected);
});

it("does not count retained unanswered input against an empty fork", () => {
  const history = createHistory();
  history.events.push(
    timedMessageEvent("unanswered-user", null, "2026-10-07T00:00:00.000Z", {
      role: "user",
      content: "long unanswered prompt ".repeat(25_000),
      timestamp: 0,
    }),
  );
  history.reset("preserve-tail");
  expect(history.events.at(-1)).toHaveProperty("firstKeptEntryId", "unanswered-user");
  history.turn("active", true);

  const source = expectForkContext(history.events, []);
  const estimate = estimateParentForkPromptTokens(source);
  expect(estimate).toBeUndefined();
  expect(
    planParentForkDecision({ sessionId: "parent", updatedAt: 0 }, estimate, {
      preferTranscriptEstimate: true,
    }),
  ).toMatchObject({ status: "fork" });
});

it("uses the selected leaf rather than a later completed turn", () => {
  const history = createHistory();
  history.turn("discarded");
  history.reset("clear");
  history.turn("active", true);
  history.turn("sibling");
  history.events.push({
    type: "leaf",
    id: "selected-branch",
    parentId: "sibling-assistant",
    targetId: "active-assistant",
    appendParentId: "active-assistant",
    timestamp: "2026-10-07T00:00:00.000Z",
  });

  expectForkContext(history.events, []);
});
