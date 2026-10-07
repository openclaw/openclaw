import { describe, expect, it } from "vitest";
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
import { createExactAssistantMessage } from "./transcript-message.test-support.js";

function createHistory() {
  const events: Record<string, unknown>[] = [
    createSessionTranscriptHeader({ sessionId: "parent", cwd: "/workspace" }),
  ];
  return {
    events,
    turn(label: string, active = false) {
      const userId = `${label}-user`;
      const timestamp = "2026-10-07T00:00:00.000Z";
      events.push({
        type: "message",
        id: userId,
        parentId: events.length > 1 ? events.at(-1)?.id : null,
        timestamp,
        message: { role: "user", content: `${label} question`, timestamp: 0 },
      });
      events.push({
        type: "message",
        id: `${label}-assistant`,
        parentId: userId,
        timestamp,
        message: {
          ...createExactAssistantMessage({
            content: active
              ? [{ type: "toolCall", id: `${label}-call`, name: "lookup", arguments: {} }]
              : [{ type: "text", text: `${label} answer` }],
          }),
          stopReason: active ? "toolUse" : "stop",
        },
      });
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

function expectForkContext(
  events: Record<string, unknown>[],
  expectedTurns: string[],
  full = false,
) {
  const original = structuredClone(events);
  const source = resolveParentForkSourceTranscript(events, full ? undefined : "last-completed");
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

describe("last-completed parent forks", () => {
  it("does not restore cleared context during the first turn after reset", () => {
    const history = createHistory();
    history.turn("discarded");
    history.reset("clear");
    history.turn("active", true);

    expectForkContext(history.events, []);
  });

  it("preserves only the tail selected by a retaining reset", () => {
    const history = createHistory();
    for (const label of ["discarded", "kept-1", "kept-2", "kept-3"]) {
      history.turn(label);
    }
    history.reset("preserve-tail");
    history.turn("active", true);

    expectForkContext(history.events, ["kept-1", "kept-2", "kept-3"]);
  });

  it("honors a clear reset after a retaining reset", () => {
    const history = createHistory();
    history.turn("discarded");
    history.reset("preserve-tail");
    history.reset("clear");
    history.turn("active", true);

    expectForkContext(history.events, []);
  });

  it("keeps completed turns after reset while excluding the active tail", () => {
    const history = createHistory();
    history.turn("discarded");
    history.reset("clear");
    history.turn("completed");
    history.turn("active", true);

    expectForkContext(history.events, ["completed"]);
  });

  it("keeps the completed prefix when there is no reset", () => {
    const history = createHistory();
    history.turn("completed");
    history.turn("active", true);

    expectForkContext(history.events, ["completed"]);
  });

  it("leaves an empty completed prefix empty", () => {
    const history = createHistory();
    history.reset("clear");
    history.turn("active", true);

    expectForkContext(history.events, []);
  });

  it("does not count retained unanswered input against an empty fork", () => {
    const history = createHistory();
    history.events.push({
      type: "message",
      id: "unanswered-user",
      parentId: null,
      timestamp: "2026-10-07T00:00:00.000Z",
      message: {
        role: "user",
        content: "long unanswered prompt ".repeat(25_000),
        timestamp: 0,
      },
    });
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
});

it("preserves current context when forking the full transcript after reset", () => {
  const history = createHistory();
  history.turn("discarded");
  history.reset("clear");
  history.turn("current");

  expectForkContext(history.events, ["current"], true);
});
