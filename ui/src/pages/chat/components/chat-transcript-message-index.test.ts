import { describe, expect, it } from "vitest";
import { buildChatItems, type BuildChatItemsProps } from "../chat-thread-build.ts";
import { setExpansionState } from "../chat-thread.ts";
import { rememberLiveTerminalRun } from "../terminal-message-identity.ts";
import { projectTranscriptChain, projectTranscriptIndex } from "./chat-transcript-message-index.ts";

const sessionKey = "agent:main:dashboard:0f6d5a1c-5a9e-4c1e-9b1a-2f3c4d5e6f70";
const partial = {
  role: "assistant",
  content: "Partial answer",
  timestamp: 20,
  __openclaw: { id: "partial", seq: 2, runId: "run-1" },
};
const history = [
  {
    role: "user",
    content: "Question",
    timestamp: 10,
    __openclaw: { id: "question", seq: 1, runId: "run-1" },
  },
  partial,
];

function chatItems(overrides: Partial<BuildChatItemsProps> = {}) {
  return buildChatItems({
    paneId: "message-index",
    sessionKey,
    messages: history,
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: true,
    ...overrides,
  });
}

const chainOptions = {
  sessionKey,
  runWorking: false,
  searchActive: false,
  stream: null,
};
const labels = { assistantName: "Assistant", userId: "reader", userName: "Reader" };

describe("automatic continuation activity", () => {
  it.each([false, true])("merges adjacent work across runs while live=%s", (live) => {
    const messages = [
      history[0],
      { ...partial, content: "Checking the remaining work.", phase: "commentary" },
      ...["run-1", "announce:review", "announce:resume"].map((runId, index) => ({
        role: "toolResult",
        toolCallId: `call-${index}`,
        toolName: "read",
        content: "Evidence",
        timestamp: 30 + index,
        __openclaw: { id: `tool-${index}`, seq: 3 + index, runId, turnBoundary: true },
      })),
    ];
    for (const persisted of [messages, structuredClone(messages)]) {
      const items = chatItems({
        messages: persisted,
        runId: live ? "announce:resume" : null,
        runWorking: live,
        streamStartedAt: live ? 40 : null,
      });
      const options = { ...chainOptions, runWorking: live };
      const chain = projectTranscriptChain(items, options);
      const parts = chain.transcriptItems.flatMap((item) =>
        item.kind === "agent-run-frame" ? item.parts : [item],
      );
      const activities = parts.filter((item) => item.kind === "activity-run");
      expect(activities).toHaveLength(1);
      expect(activities[0]?.groups.map((group) => group.runId)).toEqual([
        "run-1",
        "announce:review",
        "announce:resume",
      ]);
      expect(
        parts.some(
          (item) =>
            item.kind === "group" && item.messages.some(({ message }) => message === persisted[1]),
        ),
      ).toBe(true);
      expect(parts.some((item) => item.kind === "stream-run")).toBe(live);
      expect(projectTranscriptChain(items, { ...options })).toBe(chain);
      const index = projectTranscriptIndex(chain, new Map(), labels);
      expect(
        new Set([0, 1, 2].map((tool) => index.messageRowKeysById.get(`tool-${tool}`))),
      ).toEqual(new Set([activities[0]?.key]));
    }
  });
});

it.each([
  { key: sessionKey, working: true, projected: false, untagged: false },
  { key: sessionKey, working: true, projected: true, untagged: false },
  { key: "agent:main:telegram:direct:42", working: false, projected: false, untagged: false },
  { key: "agent:main:telegram:direct:42", working: false, projected: true, untagged: false },
  { key: "agent:main:telegram:direct:42", working: false, projected: true, untagged: true },
])(
  "keeps the following answer's run frame in $key with projected=$projected untagged=$untagged",
  ({ key, working, projected, untagged }) => {
    const answer = {
      role: "assistant",
      content: "Verified.",
      phase: "final_answer",
      stopReason: "stop",
      timestamp: 40,
      __openclaw: { id: "answer", seq: 4, runId: "run-b" },
    };
    const messages = [
      history[0],
      ...["run-a", "run-b"].map((runId, index) => ({
        role: "toolResult",
        toolName: "read",
        toolCallId: "call-" + index,
        content: "ok",
        timestamp: 20 + index,
        __openclaw: {
          id: "tool-" + index,
          seq: 2 + index,
          runId: untagged && index === 0 ? undefined : runId,
          turnBoundary: projected && index === 1,
        },
      })),
      answer,
    ];
    const chain = projectTranscriptChain(
      chatItems({
        sessionKey: key,
        messages,
        runWorking: working,
        runId: working ? "run-b" : null,
        streamStartedAt: working ? 40 : null,
      }),
      { ...chainOptions, sessionKey: key, runWorking: working },
    );
    const frame = chain.transcriptItems.find(
      (item) => item.kind === "agent-run-frame" && item.runId === "run-b",
    );
    expect(frame?.kind).toBe("agent-run-frame");
    if (frame?.kind !== "agent-run-frame") {
      throw new Error("expected the answer's run frame");
    }
    expect(
      frame.parts.some(
        (part) => part.kind === "group" && part.messages.some(({ message }) => message === answer),
      ),
    ).toBe(true);
    expect(frame.boundaryId).toBe(projected ? "send:run-b" : "send:run-1");
    // Without a projected continuation boundary, the live stream has its own
    // send boundary; the persisted answer retains the original request frame.
    expect(frame.outcome.kind).toBe(working && projected ? "active" : "completed");
    if (frame.outcome.kind === "completed") {
      expect(frame.outcome.actionOwner?.message).toBe(answer);
    }
  },
);

describe("transcript structure cache", () => {
  it("reuses structure for scroll renders and rebuilds for its inputs", () => {
    const items = chatItems();
    const chain = projectTranscriptChain(items, chainOptions);
    const expanded = new Map<string, boolean>();
    const index = projectTranscriptIndex(chain, expanded, labels);

    expect(projectTranscriptChain(items, { ...chainOptions })).toBe(chain);
    expect(projectTranscriptIndex(chain, expanded, { ...labels })).toBe(index);
    expect(index.messageRowKeysById.get("partial")).toBeDefined();

    // Live stream text is patched into the cached items without a new array.
    expect(projectTranscriptChain(items, { ...chainOptions, stream: "More" })).not.toBe(chain);
    const streamed = projectTranscriptChain(items, chainOptions);
    // Message-less terminals record their outcome beside published history.
    rememberLiveTerminalRun(partial, "run-1", undefined, "error");
    expect(projectTranscriptChain(items, chainOptions)).not.toBe(streamed);

    const settled = projectTranscriptChain(items, chainOptions);
    const settledIndex = projectTranscriptIndex(settled, expanded, labels);
    setExpansionState(expanded, "any-work-group", true);
    expect(projectTranscriptIndex(settled, expanded, labels)).not.toBe(settledIndex);
    const expandedIndex = projectTranscriptIndex(settled, expanded, labels);
    expect(projectTranscriptIndex(settled, expanded, { ...labels, userName: "Renamed" })).not.toBe(
      expandedIndex,
    );
  });
});
