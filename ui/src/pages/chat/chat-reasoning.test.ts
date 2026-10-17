/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { extractThinkingCached } from "../../lib/chat/message-extract.ts";
import { createComposerContainer } from "./chat-composer.test-support.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import {
  activeHistory,
  createState,
  type TestState,
} from "./chat-history.inflight.test-support.ts";
import { loadChatHistory } from "./chat-history.ts";
import { projectChatReasoning } from "./chat-reasoning.ts";
import { buildCachedChatItems, getChatItemsGeneration } from "./chat-thread.ts";
import { resetChatViewState } from "./chat-view-state.ts";
import { renderChatInto } from "./chat-view.test-helpers.ts";
import { projectTranscriptChain } from "./components/chat-transcript-message-index.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import { reduceChatSessionProjection } from "./history-merge.ts";
import { adoptStartedChatRun, reconcileChatRunFromSessionRow } from "./run-lifecycle.ts";
import { applySessionMessagePayload } from "./session-message-apply.ts";
import { cacheChatSessionSnapshot, readChatMessagesFromCache } from "./session-message-cache.ts";
import { resetToolStream } from "./tool-stream-state.ts";
import { handleAgentEvent } from "./tool-stream.ts";

const runId = "reasoning-run";
const user = {
  role: "user",
  content: "Explain a synthetic puzzle.",
  timestamp: 1,
  __openclaw: { id: "user", seq: 1, idempotencyKey: `${runId}:user` },
};
let state: TestState;
let container: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  installTranscriptDomMocks();
  const history = activeHistory(runId);
  history.messages = [user];
  state = createState(history);
  state.chatMessages = [user];
  adoptStartedChatRun(state, runId, 2);
  container = createComposerContainer();
});
afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
  vi.clearAllTimers();
  vi.useRealTimers();
});

function thinking(text: string, seq = 1, owner = runId, itemId = "thinking-1") {
  handleAgentEvent(state, {
    runId: owner,
    seq,
    stream: "thinking",
    ts: 3,
    sessionKey: "main",
    data: { text, delta: text, itemId },
  });
}

function final(text = "The answer is 42.", seq = 3, sessionKey = state.sessionKey) {
  handleChatGatewayEvent(state, {
    state: "final",
    sessionKey,
    runId,
    seq,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

function receipt(
  messageId: string,
  itemId = "thinking-1",
  seq = 2,
  messageRunId = runId,
  messageSeq?: number,
) {
  handleAgentEvent(state, {
    runId,
    seq,
    stream: "thinking",
    ts: 4,
    sessionKey: "main",
    data: {
      phase: "persisted",
      itemId,
      messageId,
      messageRunId,
      ...(messageSeq === undefined ? {} : { messageSeq }),
    },
  });
}

function expectAnswer() {
  expect(container.querySelectorAll(".chat-thinking")).toHaveLength(1);
  expect(
    container.querySelector(".chat-thread-inner")?.textContent?.match(/The answer is 42\./g),
  ).toHaveLength(1);
  expect(container.querySelector(".chat-transcript-announcement")?.textContent).toBe(
    "The answer is 42.",
  );
}

function show(mode: "on" | "off" | "stream" = "on", showThinking = true) {
  renderChatInto(container, {
    sessionKey: state.sessionKey,
    messages: state.chatMessages,
    toolMessages: state.chatToolMessages,
    streamSegments: state.chatStreamSegments,
    reasoning: state.chatReasoning,
    stream: state.chatStream,
    streamStartedAt: state.chatStreamStartedAt,
    runId: state.chatRunId,
    runActive: Boolean(state.chatRunId),
    selectedSession: { key: state.sessionKey, kind: "direct", updatedAt: 1, reasoningLevel: mode },
    showThinking,
  });
}

function persistReasoning(
  text: string,
  active: boolean,
  positions = { appended: 2, displayed: 2 },
) {
  receipt("answer", "thinking-1", 2, runId, positions.appended);
  const message = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: text },
      { type: "text", text: "The answer is 42." },
    ],
    timestamp: 4,
    stopReason: "stop",
    __openclaw: { id: "answer", seq: positions.displayed, runId, runTerminal: true },
  };
  applyMessage(message, { runId }, active);
  return message;
}

function applyMessage<T extends { __openclaw: { id: string; seq: number } }>(
  message: T,
  envelope: { runId?: string; clientRunId?: string; sessionKey?: string },
  active = true,
) {
  applySessionMessagePayload(
    state,
    {
      message,
      messageId: message["__openclaw"].id,
      messageSeq: message["__openclaw"].seq,
      ...envelope,
    },
    active,
    { kind: "live", activeRunId: state.chatRunId },
  );
}

it("shows thinking while generating and retains it through thinking-only history hydration", async () => {
  thinking("**Checking** the evidence.");
  show();
  expect(container.querySelector(".chat-thinking strong")?.textContent).toBe("Checking");
  expect(state.chatMessages).toEqual([user]);

  await loadChatHistory(state);
  show();
  expect(container.querySelector(".chat-thinking")?.textContent).toContain("the evidence.");
  expect(state.chatRunId).toBe(runId);
});

it.each([
  { order: "after", appended: 2, displayed: 2 },
  { order: "before", appended: 18, displayed: 7 },
])(
  "hands reasoning to history once $order final (append $appended, display $displayed)",
  async ({ order, appended, displayed }) => {
    const text = "Checking the evidence carefully.";
    thinking(text);
    show();
    expect(container.querySelectorAll(".chat-thinking")).toHaveLength(1);
    if (order === "before") {
      persistReasoning(text, true, { appended, displayed });
      show();
      expect(container.querySelectorAll(".chat-thinking")).toHaveLength(1);
      expect(state.chatReasoning?.items.at(-1)?.receipt?.persisted).toBe(true);
    }
    final();
    show();
    expectAnswer();
    expect(state.chatReasoning).toBeNull();
    if (order === "after") {
      // An intervening older snapshot must retain the reducer-owned live final.
      await loadChatHistory(state);
      expect(state.chatMessages.map(extractThinkingCached)).toContain(text);
      persistReasoning(text, false, { appended, displayed });
      show();
      expectAnswer();
    }
    expect(state.chatMessages).toHaveLength(2);
  },
);

it("applies View and session visibility independently to live and saved reasoning", () => {
  thinking("Private synthetic reasoning.");
  for (const [mode, visible] of [
    ["on", true],
    ["stream", true],
    ["off", false],
  ] as const) {
    show(mode);
    expect(Boolean(container.querySelector(".chat-thinking"))).toBe(visible);
    show(mode, false);
    expect(container.querySelector(".chat-thinking")).toBeNull();
  }
  persistReasoning("Private synthetic reasoning.", true);
  for (const mode of ["on", "stream"] as const) {
    show(mode);
    expect(container.querySelectorAll(".chat-thinking")).toHaveLength(1);
    expect(container.querySelector(".chat-thinking")?.textContent).toContain("Private synthetic");
  }
  final("The answer is 42.", 2);
  show("stream");
  expect(container.querySelector(".chat-thinking")).toBeNull();
  show("on");
  expect(container.querySelector(".chat-thinking")?.textContent).toContain("Private synthetic");
});

it("falls back to the inherited reasoning default only without a session override", () => {
  const visible = (selectedSession: { reasoningLevel?: string; reasoningDefault?: string }) =>
    projectChatReasoning({ showThinking: true, selectedSession }).showReasoning;
  expect(visible({ reasoningDefault: "on" })).toBe(true);
  expect(visible({ reasoningDefault: "stream" })).toBe(false);
  expect(visible({ reasoningLevel: "off", reasoningDefault: "on" })).toBe(false);
  expect(visible({ reasoningLevel: "on", reasoningDefault: "off" })).toBe(true);
});

it.each(["error", "aborted"] as const)(
  "retires reasoning on a message-less %s and ignores late thinking after sequence cleanup",
  (terminal) => {
    thinking("Unfinished reasoning.");
    handleChatGatewayEvent(state, {
      state: terminal,
      sessionKey: "main",
      runId,
      seq: 3,
      ...(terminal === "error" ? { errorMessage: "Synthetic interruption" } : {}),
    });
    resetToolStream(state);
    thinking("Late reasoning.", 4);
    expect(state.chatReasoning).toBeNull();
    expect(state.chatMessages.map(extractThinkingCached).filter(Boolean)).toEqual([]);
  },
);

it("fences replay and sibling runs and retires preview on a new run or session reset", () => {
  thinking("Current reasoning.", 3);
  thinking("Stale reasoning.", 2);
  thinking("Sibling reasoning.", 4, "other-run");
  expect(state.chatReasoning?.items.at(-1)?.text).toBe("Current reasoning.");
  adoptStartedChatRun(state, "new-run", 10);
  expect(state.chatReasoning).toBeNull();
  thinking("New reasoning.", 1, "new-run");
  reduceChatSessionProjection(state, { type: "sessionReset" });
  expect(state.chatReasoning).toBeNull();
});

it("updates reasoning deltas in the existing live slot without rebuilding loaded history", () => {
  thinking("Earlier tool reasoning.", 1, runId, "earlier");
  thinking("First sentence.", 2);
  const input = {
    paneId: "reasoning-cache",
    sessionKey: "main",
    runId,
    messages: state.chatMessages,
    toolMessages: [],
    streamSegments: [],
    stream: state.chatStream,
    streamStartedAt: state.chatStreamStartedAt,
    reasoning: state.chatReasoning,
    showToolCalls: true,
  };
  const first = buildCachedChatItems(input);
  const generation = getChatItemsGeneration(first);
  const options = { sessionKey: "main", runWorking: true, searchActive: false };
  const firstChain = projectTranscriptChain(first, options);
  thinking("First sentence. Second sentence.", 3);
  const second = buildCachedChatItems({ ...input, reasoning: state.chatReasoning });
  expect(second).toBe(first);
  expect(getChatItemsGeneration(second)).toBe(generation);
  expect(projectTranscriptChain(second, options).continuations).toBe(firstChain.continuations);
  expect(second.find((item) => item.kind === "stream" && item.isStreaming)).toMatchObject({
    thinking: "First sentence. Second sentence.",
  });
});

it("does not attach foreground thinking to another session's final with the same run ID", () => {
  thinking("Foreground private reasoning.");
  state.chatMessagesBySession = new Map();
  cacheChatSessionSnapshot(
    state.chatMessagesBySession,
    state,
    { sessionKey: "other-session" },
    {
      messages: [],
      pagination: { hasMore: false },
      sessionId: "other-session-id",
    },
  );
  final("Other session answer.", 2, "other-session");
  expect(state.chatReasoning?.items.at(-1)?.text).toBe("Foreground private reasoning.");
  const cached = readChatMessagesFromCache(state.chatMessagesBySession, state, {
    sessionKey: "other-session",
  });
  expect(cached).toHaveLength(1);
  expect(cached.map(extractThinkingCached)).toEqual([null]);
});

it("accepts pre-acknowledgment reasoning but retires it when the authoritative session ends", () => {
  state.chatRunId = null;
  state.chatQueue = [
    { id: "pending", text: "Puzzle", createdAt: 1, sendState: "sending", sendRunId: runId },
  ];
  thinking("Before acknowledgment.");
  expect(state.chatReasoning?.items.at(-1)?.text).toBe("Before acknowledgment.");
  adoptStartedChatRun(state, runId, 2);
  state.chatQueue = [];
  reconcileChatRunFromSessionRow(state, {
    key: "main",
    kind: "direct",
    updatedAt: 5,
    hasActiveRun: false,
    lastRunId: runId,
    status: "done",
  });
  thinking("After retirement.", 2);
  expect(state.chatReasoning).toBeNull();
});

it("does not let an earlier receipt consume equal reasoning from the next assistant occurrence", () => {
  const text = "Checking the same evidence.";
  thinking(text, 1, runId, "earlier");
  thinking(text, 2, runId, "later");
  show();
  expect(container.querySelectorAll(".chat-thinking")).toHaveLength(2);
  receipt("earlier", "earlier", 3);
  applyMessage(
    {
      role: "assistant",
      timestamp: 3,
      stopReason: "toolUse",
      content: [
        { type: "thinking", thinking: text },
        { type: "toolCall", id: "tool-1", name: "read", arguments: {} },
      ],
      __openclaw: { id: "earlier", seq: 2, runId },
    },
    { runId },
  );
  expect(state.chatReasoning?.items.at(-1)).toMatchObject({ itemId: "later", text });
  expect(state.chatReasoning?.items.at(-1)?.receipt?.messageId).toBeUndefined();
  for (const mode of ["on", "stream"] as const) {
    show(mode);
    expect(container.querySelectorAll(".chat-thinking")).toHaveLength(2);
  }
});

it("keeps persisted tool-step reasoning visible until its run finishes", () => {
  const sessionKey = "agent:main:dashboard:reasoning";
  const toolMessage = (index: number, owner: string, text: string, timestamp: number) => ({
    role: "assistant",
    timestamp,
    stopReason: "toolUse",
    content: [
      { type: "thinking", thinking: text },
      {
        type: "toolCall",
        id: `read-${index}`,
        name: "read",
        arguments: { path: `evidence-${index}.txt` },
      },
    ],
    __openclaw: { id: `${owner}-${index}`, seq: timestamp, runId: owner },
  });
  const history = activeHistory(runId);
  history.messages = [
    {
      role: "user",
      content: "Earlier question.",
      timestamp: 100,
      __openclaw: { id: "earlier-user", seq: 100 },
    },
    toolMessage(0, "earlier-run", "Earlier first thought.", 200),
    toolMessage(1, "earlier-run", "Earlier second thought.", 300),
    {
      role: "assistant",
      content: "Earlier answer.",
      timestamp: 400,
      __openclaw: { id: "earlier-answer", seq: 400, runId: "earlier-run" },
    },
    { ...user, timestamp: 1_000, __openclaw: { ...user["__openclaw"], seq: 1_000 } },
  ];
  state = createState(history);
  state.sessionKey = sessionKey;
  state.chatMessages = history.messages;
  adoptStartedChatRun(state, runId, 1_050);
  const thoughts = [
    "Inspect the first file.",
    "Compare the second file.",
    "Explain the result.",
  ] as const;
  let seq = 0;
  const agent = (stream: string, data: Record<string, unknown>, ts: number) =>
    handleAgentEvent(state, { sessionKey, runId, seq: ++seq, stream, data, ts });
  for (const index of [0, 1]) {
    agent("thinking", { itemId: `thought-${index}`, text: thoughts[index] }, 1_100 + index * 100);
    agent(
      "tool",
      {
        toolCallId: `read-${index}`,
        name: "read",
        phase: "start",
        args: { path: `evidence-${index}.txt` },
      },
      1_150 + index * 100,
    );
    agent(
      "tool",
      {
        toolCallId: `read-${index}`,
        name: "read",
        phase: "result",
        result: { content: [{ type: "text", text: "42" }] },
      },
      1_160 + index * 100,
    );
  }
  agent("thinking", { itemId: "thought-2", text: thoughts[2] }, 1_300);
  const expectSteps = () => {
    expect(container.querySelectorAll(".chat-thinking")).toHaveLength(3);
    expect(
      [...container.querySelectorAll(".chat-thinking, .chat-tool-msg-summary")].map(
        (node) => node.textContent,
      ),
    ).toEqual([
      expect.stringContaining(thoughts[0]),
      expect.stringContaining("evidence-0.txt"),
      expect.stringContaining(thoughts[1]),
      expect.stringContaining("evidence-1.txt"),
      expect.stringContaining(thoughts[2]),
    ]);
  };
  show();
  expectSteps();
  for (const index of [0, 1]) {
    const message = toolMessage(index, runId, thoughts[index]!, 1_050 + index * 100);
    agent(
      "thinking",
      {
        phase: "persisted",
        itemId: `thought-${index}`,
        messageId: message["__openclaw"].id,
        messageRunId: runId,
      },
      1_400 + index,
    );
    applyMessage(message, { sessionKey });
    for (const mode of ["on", "stream"] as const) {
      show(mode);
      expectSteps();
    }
  }
  show("on", false);
  expect(container.querySelectorAll(".chat-thinking")).toHaveLength(0);
  show();
  expectSteps();

  const worked = () =>
    container.querySelectorAll<HTMLButtonElement>(
      ".chat-work-group > .chat-activity-group__summary",
    );
  const rawDetails = () =>
    [...container.querySelectorAll<HTMLButtonElement>(".chat-activity-group__summary")].find(
      (button) => button.textContent?.includes("Raw details"),
    )!;
  expect(worked()).toHaveLength(1);
  worked()[0]!.click();
  show();
  expect(rawDetails().getAttribute("aria-expanded")).toBe("false");
  expectSteps();
  worked()[0]!.click();
  show();

  final("The answer is 42.", ++seq);
  show();
  expect(worked()).toHaveLength(2);
  expect(container.querySelectorAll(".chat-thinking")).toHaveLength(1);
  worked()[1]!.click();
  show();
  expect(rawDetails().getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelectorAll(".chat-thinking")).toHaveLength(1);
  rawDetails().click();
  show();
  expect(container.querySelectorAll(".chat-thinking")).toHaveLength(3);
});

it("does not attach known-committed pre-tool reasoning to a later final answer", () => {
  thinking("Reasoning belonging to the tool call.");
  receipt("tool-answer");
  final("Separate final answer.");
  expect(state.chatMessages.map(extractThinkingCached).filter(Boolean)).toEqual([]);
});

it.each([false, true])(
  "clears the current draft without promoting earlier reasoning (%s)",
  (earlier) => {
    if (earlier) {
      thinking("Keep the earlier tool reasoning.", 1, runId, "earlier");
    }
    const itemId = earlier ? "later" : "thinking-1";
    const seq = earlier ? 2 : 1;
    thinking("A discarded draft.", seq, runId, itemId);
    show();
    expect(container.querySelector(".chat-thinking")).not.toBeNull();
    thinking("", seq + 1, runId, itemId);
    show();
    expect(container.querySelectorAll(".chat-thinking")).toHaveLength(earlier ? 1 : 0);
    if (earlier) {
      expect(container.querySelector(".chat-thinking")?.textContent).toContain(
        "Keep the earlier tool reasoning.",
      );
    }
    final("The final answer.", seq + 2);
    expect(state.chatMessages.map(extractThinkingCached).filter(Boolean)).toEqual([]);
  },
);

it("uses the producer run in the receipt when Gateway remaps the live client run", () => {
  thinking("A remapped source occurrence.");
  receipt("source-answer", "thinking-1", 2, "source-run");
  applyMessage(
    {
      role: "assistant",
      timestamp: 4,
      content: [
        { type: "thinking", thinking: "A remapped source occurrence." },
        { type: "text", text: "Source answer." },
      ],
      __openclaw: { id: "source-answer", seq: 2, runId: "source-run" },
    },
    { runId: "source-run", clientRunId: runId },
  );
  expect(state.chatReasoning?.items.at(-1)?.receipt).toEqual({
    runId: "source-run",
    messageId: "source-answer",
    persisted: true,
  });
  show();
  expect(container.querySelectorAll(".chat-thinking")).toHaveLength(1);
});
