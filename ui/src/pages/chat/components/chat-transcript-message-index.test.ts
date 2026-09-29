import { afterEach, describe, expect, it, vi } from "vitest";
import { buildChatItems, type BuildChatItemsProps } from "../chat-thread-build.ts";
import { buildCachedChatItems, resetChatThreadState, setExpansionState } from "../chat-thread.ts";
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

    expect(projectTranscriptChain(items, { ...chainOptions, searchActive: true })).not.toBe(chain);
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

const work = vi.hoisted(() => ({ chainCalls: 0, chainItems: 0, positionItems: 0 }));
vi.mock("../chat-thread.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../chat-thread.ts")>();
  return {
    ...original,
    coalesceStreamRuns: (...args: Parameters<typeof original.coalesceStreamRuns>) => {
      work.chainCalls++;
      work.chainItems += args[0].length;
      return original.coalesceStreamRuns(...args);
    },
  };
});
vi.mock("./chat-position-projection.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./chat-position-projection.ts")>();
  return {
    ...original,
    projectChatPositions: (...args: Parameters<typeof original.projectChatPositions>) => {
      work.positionItems += args[0].length;
      return original.projectChatPositions(...args);
    },
  };
});

afterEach(() => resetChatThreadState());

function streamInput(size: number): BuildChatItemsProps {
  const messages = Array.from({ length: size }, (_, i) => {
    const phase = i % 6;
    return {
      role: phase === 0 ? "user" : phase === 2 || phase === 4 ? "toolResult" : "assistant",
      content:
        phase === 0
          ? "Inspect the implementation"
          : phase === 5
            ? "Verified the result."
            : "Checking the evidence.",
      ...(phase === 2 || phase === 4 ? { toolName: "read", toolCallId: `call-${i}` } : {}),
      ...(phase === 1 || phase === 3
        ? { phase: "commentary" }
        : phase === 5
          ? { phase: "final_answer", stopReason: "stop" }
          : {}),
      timestamp: i + 1,
      __openclaw: { id: `history-${i}`, seq: i + 1, runId: `history-run-${Math.floor(i / 6)}` },
    };
  });
  messages.push(
    {
      role: "user",
      content: "Next task",
      timestamp: size + 1,
      __openclaw: { id: "live-user", seq: size + 1, runId: "live" },
    },
    {
      role: "assistant",
      content: "Investigating.",
      phase: "commentary",
      timestamp: size + 2,
      __openclaw: { id: "live-comment", seq: size + 2, runId: "live" },
    },
    {
      role: "toolResult",
      content: "Evidence",
      toolName: "read",
      toolCallId: "live-tool",
      timestamp: size + 3,
      __openclaw: { id: "live-tool", seq: size + 3, runId: "live" },
    },
  );
  return {
    paneId: "stream-projection",
    sessionKey,
    messages,
    toolMessages: [],
    streamSegments: [],
    stream: "Initial",
    streamStartedAt: size + 4,
    runId: "live",
    runWorking: true,
    showToolCalls: true,
  };
}

it("keeps stream-only projection work bounded by the tail across history sizes", () => {
  const measure = (size: number) => {
    resetChatThreadState();
    const input = streamInput(size);
    const expanded = new Map<string, boolean>();
    const project = (stream: string) => {
      const items = buildCachedChatItems({ ...input, stream });
      return projectTranscriptIndex(
        projectTranscriptChain(items, {
          ...chainOptions,
          runWorking: true,
        }),
        expanded,
        labels,
      );
    };
    project("Initial");
    Object.assign(work, { chainCalls: 0, chainItems: 0, positionItems: 0 });
    for (const stream of ["One", "One two", "One two three"]) {
      project(stream);
    }
    return { ...work };
  };
  const small = measure(20);
  const large = measure(400);
  expect(large).toEqual(small);
  expect(large.chainCalls).toBe(0);
  expect(large.positionItems).toBeLessThanOrEqual(6);
});

describe("incremental stream projection", () => {
  it.each([
    { name: "dashboard frame and queued tail", framed: true, searchActive: false },
    { name: "unframed stream without boundary", framed: false, searchActive: false },
    { name: "search projection", framed: true, searchActive: true },
  ])("matches full recomputation for $name", ({ framed, searchActive }) => {
    const input = streamInput(6);
    input.messages = [
      ...["user", "assistant", "toolResult", "assistant"].map((role, index) => ({
        role,
        content: ["Earlier question", "Checking", "Evidence", "Earlier answer"][index],
        toolName: role === "toolResult" ? "read" : undefined,
        toolCallId: role === "toolResult" ? "earlier-tool" : undefined,
        phase: index === 1 ? "commentary" : index === 3 ? "final_answer" : undefined,
        stopReason: index === 3 ? "stop" : undefined,
        timestamp: index + 1,
        __openclaw: { id: `earlier-${index}`, seq: index + 1 },
      })),
      ...input.messages.slice(-3),
    ];
    if (!framed) {
      input.runId = null;
    }
    if (framed && !searchActive) {
      input.queue = [
        {
          id: "queued",
          text: "Next request",
          createdAt: 100,
          sendState: "waiting-reconnect",
          sendAttempts: 1,
          sendRunId: "queued-run",
        },
      ];
    }
    const options = { ...chainOptions, runWorking: true, searchActive };
    const expanded = new Map<string, boolean>();
    const retained: {
      chain: ReturnType<typeof projectTranscriptChain>;
      index: ReturnType<typeof projectTranscriptIndex>;
      snapshot: unknown;
    }[] = [];
    const texts = [
      "   ",
      "<thinking>Private planning</thinking>",
      "First",
      "First longer",
      "First longer again",
      "Expanded answer",
      "Expanded answer continued",
      "<thinking>Still planning</thinking>",
      "Visible again",
      "Visible again continued",
    ];
    let priorItems: ReturnType<typeof buildCachedChatItems> | undefined;
    let priorLive: ReturnType<typeof buildCachedChatItems>[number] | undefined;
    let workKey: string | undefined;
    for (const [delta, stream] of texts.entries()) {
      const items = buildCachedChatItems({ ...input, stream });
      const live = items.find((item) => item.kind === "stream" && item.isStreaming);
      if (delta >= 2) {
        expect(items).toBe(priorItems);
        expect(live).not.toBe(priorLive);
      }
      const chain = projectTranscriptChain(items, options);
      if (delta === 0 && !searchActive) {
        workKey = chain.transcriptItems.find((item) => item.kind === "work-group")?.key;
        expect(workKey).toBeDefined();
        setExpansionState(expanded, workKey!, true);
      }
      if (delta === 5 && workKey) {
        setExpansionState(expanded, workKey, false);
      }
      const index = projectTranscriptIndex(chain, expanded, labels);
      const fullChain = projectTranscriptChain([...items], options);
      const fullIndex = projectTranscriptIndex(fullChain, expanded, labels);
      expect(chain.collapsedItems).toEqual(fullChain.collapsedItems);
      expect(chain.transcriptItems).toEqual(fullChain.transcriptItems);
      expect(chain.continuations).toEqual(fullChain.continuations);
      expect(index.rows).toEqual(fullIndex.rows);
      expect(index.messageRowKeysById).toEqual(fullIndex.messageRowKeysById);
      expect(index.transcriptMessageKeys).toEqual(fullIndex.transcriptMessageKeys);
      expect(index.loadedReplySources).toEqual(fullIndex.loadedReplySources);
      expect(index.positionIndex.markerIdsByMessageId).toEqual(
        fullIndex.positionIndex.markerIdsByMessageId,
      );
      expect(index.positionIndex.markers).toEqual(fullIndex.positionIndex.markers);
      expect(projectTranscriptChain(items, options)).toBe(chain);
      expect(projectTranscriptIndex(chain, expanded, labels)).toBe(index);
      if (live) {
        const ownerKey = index.transcriptMessageKeys.get(live.key);
        const owner = chain.transcriptItems.find((item) => item.key === ownerKey);
        expect(owner?.kind).toBe(framed && !searchActive ? "agent-run-frame" : "stream-run");
        const visible = delta !== 1 && delta !== 7;
        expect(index.positionIndex.markerIdsByMessageId.has(live.key)).toBe(visible);
        if (input.queue) {
          expect(chain.transcriptItems.at(-1)?.key).not.toBe(ownerKey);
        }
        if (!framed && owner?.kind === "stream-run") {
          expect(owner.boundaryId).toBeUndefined();
        }
        if (framed && visible) {
          expect(
            index.positionIndex.markers.find((marker) => marker.id === "run:live")?.message,
          ).toMatchObject({ content: [{ type: "text", text: stream }] });
        }
        if ([3, 4, 6, 9].includes(delta)) {
          const previous = retained.at(-1)!;
          expect(chain.transcriptItems[0]).toBe(previous.chain.transcriptItems[0]);
          expect(index.transcriptMessageKeys).toBe(previous.index.transcriptMessageKeys);
          expect(index.loadedReplySources).toBe(previous.index.loadedReplySources);
          expect(index.messageRowKeysById).toBe(previous.index.messageRowKeysById);
          expect(index.positionIndex.markerIdsByMessageId).toBe(
            previous.index.positionIndex.markerIdsByMessageId,
          );
          for (const [position, row] of index.rows.entries()) {
            if (row.key === ownerKey) {
              break;
            }
            expect(row).toBe(previous.index.rows[position]);
          }
        }
      }
      if (workKey) {
        expect(index.rows.some((row) => row.key.startsWith(`${workKey}:`))).toBe(delta < 5);
      }
      retained.push({ chain, index, snapshot: structuredClone({ chain, index }) });
      priorItems = items;
      priorLive = live;
    }
    for (const { chain, index, snapshot } of retained) {
      expect({ chain, index }).toEqual(snapshot);
    }
  });
});
