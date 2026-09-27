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
