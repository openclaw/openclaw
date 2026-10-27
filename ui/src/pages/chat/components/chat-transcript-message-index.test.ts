import { afterEach, describe, expect, it } from "vitest";
import { chatItemGroups } from "../chat-agent-run-grouping.ts";
import { resetWorkingProgress } from "../chat-progress.ts";
import { buildChatItems, type BuildChatItemsProps } from "../chat-thread-build.ts";
import { makeMessage } from "../chat-thread.test-support.ts";
import { buildCachedChatItems, resetChatThreadState, setExpansionState } from "../chat-thread.ts";
import { rememberLiveTerminalRun } from "../terminal-message-identity.ts";
import {
  projectTranscriptChain,
  projectTranscriptIndex,
  projectTranscriptRows,
} from "./chat-transcript-message-index.ts";

const sessionKey = "agent:main:dashboard:0f6d5a1c-5a9e-4c1e-9b1a-2f3c4d5e6f70";

const finalAnswer = (id: string, seq: number, fields = {}) =>
  makeMessage(id, seq, { phase: "final_answer", stopReason: "stop", ...fields });
function makeTool(
  id: string,
  seq: number,
  runId: string | undefined,
  timestamp: number,
  turnBoundary?: boolean,
) {
  return {
    ...makeMessage(id, seq, { role: "toolResult", content: "Evidence", timestamp, runId }),
    toolName: "read",
    toolCallId: id,
    __openclaw: { id, seq, runId, turnBoundary },
  };
}
const partial = makeMessage("partial", 2);
const history = [makeMessage("question", 1, { role: "user" }), partial];

function chatProps(overrides: Partial<BuildChatItemsProps> = {}): BuildChatItemsProps {
  return {
    paneId: "message-index",
    sessionKey,
    messages: history,
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: true,
    ...overrides,
  };
}
const chatItems = (overrides: Partial<BuildChatItemsProps> = {}) =>
  buildChatItems(chatProps(overrides));

const chainOptions = { sessionKey, runWorking: false, searchActive: false };
const labels = { assistantName: "Assistant", userId: "reader", userName: "Reader" };
type Chain = ReturnType<typeof projectTranscriptChain>;
type Index = ReturnType<typeof projectTranscriptIndex>;
type ChainOptions = Partial<Parameters<typeof projectTranscriptChain>[1]>;
type RenderItem = Chain["transcriptItems"][number];
function chainFor(items: Parameters<typeof projectTranscriptChain>[0], options: ChainOptions = {}) {
  return projectTranscriptChain(items, { ...chainOptions, ...options });
}
function indexFor(chain: Chain, expanded = new Map<string, boolean>(), props = labels) {
  return projectTranscriptIndex(chain, expanded, props);
}
function projectHistory(
  messages: unknown[],
  options: Partial<BuildChatItemsProps> & ChainOptions = {},
) {
  return chainFor(chatItems({ messages, ...options }), options);
}
const framesOf = (chain: Chain) => kind(chain.transcriptItems, "agent-run-frame");
function onlyFrame(chain: Chain) {
  const frames = framesOf(chain);
  expect(frames).toHaveLength(1);
  return frames[0]!;
}
const transcriptParts = (chain: Chain) =>
  chain.transcriptItems.flatMap((item) => (item.kind === "agent-run-frame" ? item.parts : [item]));
const kind = <K extends RenderItem["kind"]>(items: readonly RenderItem[], type: K) =>
  items.filter((item): item is Extract<RenderItem, { kind: K }> => item.kind === type);
const messagesIn = (items: readonly Parameters<typeof chatItemGroups>[0][]) =>
  items.flatMap(chatItemGroups).flatMap((group) => group.messages.map(({ message }) => message));
const frameShows = (frame: RenderItem | undefined, message: unknown) =>
  frame?.kind === "agent-run-frame" && messagesIn(kind(frame.parts, "group")).includes(message);
const completedOutcome = (message: unknown) => ({ kind: "completed", actionOwner: { message } });
const replyFrameShape = (outcome: unknown, ...parts: unknown[]) => ({
  kind: "agent-run-frame",
  runId: "run-1",
  boundaryId: "send:run-1",
  outcome,
  parts,
});

it.each([
  { key: sessionKey, working: true, projected: false, untagged: false },
  { key: sessionKey, working: true, projected: true, untagged: false },
  { key: "agent:main:telegram:direct:42", working: false, projected: false, untagged: false },
  { key: "agent:main:telegram:direct:42", working: false, projected: true, untagged: false },
  { key: "agent:main:telegram:direct:42", working: false, projected: true, untagged: true },
])("frames continued answers: %j", ({ key, working, projected, untagged }) => {
  const answer = finalAnswer("answer", 4, { runId: "run-b" });
  const messages = [
    history[0],
    ...["run-a", "run-b"].map((runId, index) =>
      makeTool(
        "tool-" + index,
        2 + index,
        untagged && index === 0 ? undefined : runId,
        20 + index,
        projected && index === 1,
      ),
    ),
    answer,
  ];
  const chain = projectHistory(messages, {
    sessionKey: key,
    runWorking: working,
    runId: working ? "run-b" : null,
    streamStartedAt: working ? 40 : null,
  });
  const frame = framesOf(chain).find((item) => item.runId === "run-b");
  expect(frameShows(frame, answer)).toBe(true);
  expect(frame?.boundaryId).toBe(projected ? "send:run-b" : "send:run-1");
  expect(frame?.outcome.kind).toBe(working && projected ? "active" : "completed");
  if (frame?.outcome.kind === "completed") {
    expect(frame.outcome.actionOwner?.message).toBe(answer);
  }
});

it("changes the footprint revision when the same message ID receives new content", () => {
  const before = indexFor(projectHistory([finalAnswer("answer", 2, { content: "Before" })]))
    .rows[0]!;
  const replay = indexFor(projectHistory([finalAnswer("answer", 2, { content: "Before" })]))
    .rows[0]!;
  const after = indexFor(projectHistory([finalAnswer("answer", 2, { content: "After" })])).rows[0]!;
  expect(after.key).toBe(before.key);
  expect(after.kind === "item" && after.revision).not.toBe(
    before.kind === "item" && before.revision,
  );
  expect(replay.kind === "item" && replay.revision).toBe(before.kind === "item" && before.revision);
});

it("invalidates only a changed reaction row while retaining other cached footprints", () => {
  const chain = projectHistory([
    finalAnswer("answer", 2),
    makeMessage("neighbor", 3, { role: "user" }),
  ]);
  const expanded = new Map<string, boolean>();
  const summaries = [{ emoji: "👍", count: 1, identities: [{ id: "peer" }] }];
  const project = (reactions: Map<string, typeof summaries>) =>
    projectTranscriptIndex(chain, expanded, { ...labels, messageReactions: reactions }).rows.filter(
      (row) => row.kind === "item",
    );
  const before = project(new Map());
  const reacted = project(new Map([["answer", summaries]]));
  expect(reacted.map((row) => row.key)).toEqual(before.map((row) => row.key));
  expect(reacted[0]!.revision).not.toBe(before[0]!.revision);
  expect(reacted[1]!.revision).toBe(before[1]!.revision);
  const replay = project(
    new Map([
      ["answer", summaries],
      ["outside-window", summaries],
    ]),
  );
  expect(replay.map((row) => row.revision)).toEqual(reacted.map((row) => row.revision));
  expect(project(new Map([["answer", []]])).map((row) => row.revision)).toEqual(
    before.map((row) => row.revision),
  );
});

it("leaves an attached live continuation out of reusable row geometry", () => {
  const items = chatItems({
    messages: [
      { role: "assistant", content: "Answer", timestamp: 10, __openclaw: { id: "answer", seq: 1 } },
    ],
  });
  const settled = chainFor(items);
  const active = chainFor([...items, { kind: "reading-indicator", key: "waiting", startedAt: 32 }]);
  expect(active.continuations.size).toBe(1);
  const before = indexFor(settled).rows[0]!;
  const during = indexFor(active).rows[0]!;
  expect(during.key).toBe(before.key);
  expect(before.kind === "item" && before.revision).toEqual(expect.any(String));
  expect(during.kind === "item" && during.revision).toBeUndefined();
});

it("distinguishes terminal frame geometry when a hidden terminal changes its outcome", () => {
  const messages = [
    history[0],
    makeMessage("call", 2, {
      content: [{ type: "toolCall", id: "read", name: "read", arguments: {} }],
      stopReason: "toolUse",
    }),
    makeTool("read", 3, "run-1", 30),
  ];
  const stopped = [...messages, makeMessage("terminal", 4, { content: [], stopReason: "stop" })];
  const before = chainFor(chatItems({ messages }), { messages });
  const after = chainFor(chatItems({ messages: stopped }), { messages: stopped });
  const first = onlyFrame(before);
  const last = onlyFrame(after);
  expect(first.outcome.kind).toBe("interrupted");
  expect(last.outcome.kind).toBe("completed");
  expect(last.key).toBe(first.key);
  expect(messagesIn([last])).toEqual(messagesIn([first]));
  const beforeRow = indexFor(before).rows.find((row) => row.key === first.key)!;
  const afterRow = indexFor(after).rows.find((row) => row.key === last.key)!;
  expect(afterRow.kind === "item" && afterRow.revision).not.toBe(
    beforeRow.kind === "item" && beforeRow.revision,
  );
});

describe("completed reply frame ownership", () => {
  function replyHistory(workRunIds: (string | undefined)[] = ["run-1"], prompt = true): unknown[] {
    return [
      ...(prompt ? [history[0]] : []),
      ...workRunIds.map((runId, index) =>
        makeTool("work-" + index, 2 + index * 2, runId, 20 + index),
      ),
      finalAnswer("final", 10, { timestamp: 40 }),
    ];
  }

  it.each<[string, (string | undefined)[], boolean, string?, boolean?]>([
    ["missing prompt", ["run-1"], false],
    ["resumed run without prompt", ["run-u", "run-1"], false],
    ["untagged work", [undefined, "run-1"], true],
    ["all untagged work without prompt", [undefined], false],
    ["channel reload", ["run-1"], false, "agent:main:telegram:direct:42"],
    ["recovered failure", ["run-u", "run-1"], true, sessionKey, true],
  ])("owns the final reply: %s", (_name, workRunIds, prompt, key = sessionKey, failed = false) => {
    const messages = replyHistory(workRunIds, prompt);
    const failure = makeMessage("failed-attempt", 5, {
      stopReason: "error",
      timestamp: 25,
      runId: "run-u",
    });
    if (failed) {
      messages.splice(-1, 0, failure);
    }
    const original = structuredClone(messages);
    const options = { sessionKey: key };
    const chain = projectHistory(messages, options);
    const [frame] = framesOf(chain);
    expect(chain.transcriptItems).toEqual([
      ...(prompt ? [expect.objectContaining({ role: "user" })] : []),
      frame,
    ]);
    expect(frame).toMatchObject({
      key: 'agent-run:["run-1","send:run-1"]',
      ...replyFrameShape(
        completedOutcome(messages.at(-1)),
        { kind: key === sessionKey ? "work-group" : "group" },
        { kind: "group", role: "assistant" },
      ),
    });
    const work = frame!.parts[0]!;
    if (key === sessionKey) {
      if (work.kind !== "work-group") {
        throw new Error("expected work inside the reply frame");
      }
      if (failed) {
        expect(messagesIn([work])).toContain(failure);
      } else {
        expect(work.groups.map((group) => group.runId)).toEqual(workRunIds);
      }
    }
    expect(messagesIn([frame!])).toEqual(messages.slice(prompt ? 1 : 0));
    expect(messages).toEqual(original);
    const index = indexFor(chain);
    expect(index.transcriptMessageKeys.get(chatItemGroups(work)[0]!.messages[0]!.key)).toBe(
      frame?.key,
    );
    expect(index.messageRowKeysById.get("final")).toBe(frame?.key);
    if (!prompt) {
      for (const restored of [structuredClone(messages), [history[0], ...messages]]) {
        const next = projectHistory(restored, options);
        expect(framesOf(next)[0]?.key).toBe(frame?.key);
        const nextIndex = indexFor(next);
        for (const id of ["work-0", "final"]) {
          expect(nextIndex.messageRowKeysById.get(id)).toBe(index.messageRowKeysById.get(id));
        }
      }
    }
  });

  it.each([
    ["earlier reply in the same run", "run-1", false, "final_answer", true],
    ["earlier reply in another run", "run-other", false, "final_answer", true],
    ["forwarded commentary", "run-1", true, undefined, true],
    ["forwarded answer", "run-1", true, "final_answer", true],
    ["promptless forwarded commentary", "run-1", true, undefined, false],
    ["promptless forwarded answer", "run-1", true, "final_answer", false],
  ] as const)("preserves reply boundaries: %s", (_name, runId, forwarded, phase, prompt) => {
    const messages = replyHistory(prompt ? ["run-u", "run-1"] : ["run-1", "run-1"], prompt);
    const inserted = makeMessage("earlier", 3, {
      phase,
      ...(forwarded
        ? { senderSession: { sessionKey: "agent:other:main", agentId: "other" } }
        : { stopReason: "stop" }),
      timestamp: 20.5,
      runId,
    });
    messages.splice(prompt ? 2 : 1, 0, inserted);
    const chain = projectHistory(messages);
    expect(framesOf(chain).at(-1)?.outcome).toMatchObject(completedOutcome(messages.at(-1)));
    const work = (forwarded ? chain.transcriptItems : transcriptParts(chain)).find(
      (item) => item.kind === "work-group",
    );
    expect(work).toBeDefined();
    if (forwarded) {
      expect(messagesIn(framesOf(chain))).not.toContain(inserted);
      const standalone = phase ? kind(chain.transcriptItems, "group") : [work!];
      expect(messagesIn(standalone)).toContain(inserted);
    } else {
      expect(
        messagesIn(
          kind(transcriptParts(chain), "group").filter((item) => item.role === "assistant"),
        ),
      ).toEqual([inserted, messages.at(-1)]);
      expect(framesOf(chain).map((frame) => frame.runId)).toEqual(
        runId === "run-1" ? ["run-1"] : ["run-other", "run-1"],
      );
      expect(runId === "run-1" ? framesOf(chain)[0]?.parts[0] : chain.transcriptItems[1]).toBe(
        work,
      );
    }
  });

  it("keeps resumed work with its final answer after the steer", () => {
    const messages = replyHistory(["run-u", "run-1"]);
    const steer = makeMessage("steer", 3, {
      role: "user",
      timestamp: 20.5,
      __openclaw: { id: "steer", seq: 3, runId: "steer-send", steerTargetRunId: "run-1" },
    });
    messages.splice(2, 0, steer);
    const chain = projectHistory(messages);
    const [before, frame] = framesOf(chain);
    expect(chain.transcriptItems).toEqual([
      expect.objectContaining({ role: "user" }),
      before,
      expect.objectContaining({ role: "user" }),
      frame,
    ]);
    expect(messagesIn([before!])).toEqual([messages[1]]);
    expect(frame?.runId).toBe("run-1");
    expect(messagesIn([frame!])).toEqual(messages.slice(3));
    expect(frame?.parts[0]?.kind).toBe("work-group");
    expect(frame?.outcome).toMatchObject(completedOutcome(messages.at(-1)));
    expect(new Set(chain.transcriptItems.map((item) => item.key)).size).toBe(
      chain.transcriptItems.length,
    );
  });

  it.each([
    { working: true, withAnswer: false },
    { working: true, withAnswer: true },
    { working: false, withAnswer: false },
  ])("projects promptless history: %j", ({ working, withAnswer }) => {
    const persistedHistory = replyHistory(["run-1"], false);
    const messages = withAnswer ? persistedHistory : persistedHistory.slice(0, -1);
    const chain = projectHistory(messages, {
      runId: working ? "run-1" : null,
      runWorking: working,
      stream: working ? "Verifying the evidence" : null,
      streamStartedAt: working ? 50 : null,
    });
    expect(chain.transcriptItems).toMatchObject(
      working
        ? [
            replyFrameShape(
              { kind: "active" },
              { kind: "group", role: "tool" },
              ...(withAnswer ? [{ kind: "group", role: "assistant" }] : []),
              { kind: "stream-run" },
            ),
          ]
        : [{ kind: "group", role: "tool" }],
    );
    expect(chain.transcriptItems).toHaveLength(1);
    expect(messagesIn(chain.transcriptItems)).toEqual(messages);
  });
});

it("reuses transcript structure for scroll renders and rebuilds for its inputs", () => {
  const items = chatItems();
  const chain = chainFor(items);
  const expanded = new Map<string, boolean>();
  const index = indexFor(chain, expanded);

  expect(chainFor(items, { ...chainOptions })).toBe(chain);
  expect(indexFor(chain, expanded, { ...labels })).toBe(index);
  expect(index.messageRowKeysById.get("partial")).toBeDefined();

  expect(chainFor(items, { searchActive: true })).not.toBe(chain);
  const streamed = chainFor(items);
  rememberLiveTerminalRun(partial, "run-1", "error");
  expect(chainFor(items)).not.toBe(streamed);

  const settled = chainFor(items);
  const settledIndex = indexFor(settled, expanded);
  setExpansionState(expanded, "any-work-group", true);
  expect(indexFor(settled, expanded)).not.toBe(settledIndex);
  const expandedIndex = indexFor(settled, expanded);
  expect(indexFor(settled, expanded, { ...labels, userName: "Renamed" })).not.toBe(expandedIndex);
});

afterEach(() => resetChatThreadState());

it.each([
  { name: "dashboard frame and rejected input tail", framed: true, searchActive: false },
  { name: "unframed stream without boundary", framed: false, searchActive: false },
  { name: "search projection", framed: true, searchActive: true },
])("retains streamed structure until visibility changes: $name", ({ framed, searchActive }) => {
  const historical = (seq: number, fields: Record<string, unknown>) =>
    makeMessage(`history-${seq - 1}`, seq, {
      timestamp: seq,
      __openclaw: { id: `history-${seq - 1}`, seq },
      ...fields,
    });
  const input = chatProps({
    paneId: "stream-projection",
    messages: [
      historical(1, { role: "user", content: "Question" }),
      historical(2, { content: "Work", phase: "commentary" }),
      historical(3, {
        role: "toolResult",
        content: "Work",
        toolName: "read",
        toolCallId: "call-2",
      }),
      historical(4, { content: "Answer", phase: "final_answer", stopReason: "stop" }),
      makeMessage("live-user", 7, { role: "user", timestamp: 7, runId: "live" }),
      makeMessage("live-comment", 8, { phase: "commentary", timestamp: 8, runId: "live" }),
      makeTool("live-tool", 9, "live", 9),
    ],
    stream: "Initial",
    streamStartedAt: 10,
    runId: "live",
    runWorking: true,
  });
  if (!framed) {
    input.runId = null;
  }
  if (framed && !searchActive) {
    input.queue = [
      {
        id: "queued",
        text: "Next request",
        createdAt: 100,
        sendState: "failed",
        sendError: "The follow-up was rejected.",
        sendAttempts: 1,
        sendRunId: "queued-run",
      },
    ];
  }
  const options = { runWorking: true, searchActive };
  const expanded = new Map<string, boolean>();
  const previews = new Map();
  const retained: { chain: Chain; index: Index; snapshot: unknown }[] = [];
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
    const chain = chainFor(items, options);
    if (delta === 0 && !searchActive) {
      workKey = chain.transcriptItems.find((item) => item.kind === "work-group")?.key;
      expect(workKey).toBeDefined();
      setExpansionState(expanded, workKey!, true);
    }
    if (delta === 5 && workKey) {
      setExpansionState(expanded, workKey, false);
    }
    const index = indexFor(chain, expanded);
    expect(chainFor(items, options)).toBe(chain);
    expect(indexFor(chain, expanded)).toBe(index);
    if (live) {
      const ownerKey = index.transcriptMessageKeys.get(live.key);
      const owner = chain.live?.item ?? chain.transcriptItems.find((item) => item.key === ownerKey);
      expect(owner?.kind).toBe(framed && !searchActive ? "agent-run-frame" : "stream-run");
      const visible = delta !== 1 && delta !== 7;
      expect(index.positionIndex.markerIdsByMessageId.has(live.key)).toBe(visible);
      if (input.queue) {
        expect(chain.transcriptItems.at(-1)?.key).not.toBe(ownerKey);
      }
      if (!framed && owner?.kind === "stream-run") {
        expect(owner.boundaryId).toBeUndefined();
      }
      if ([3, 4, 6, 9].includes(delta)) {
        const previous = retained.at(-1)!;
        expect(chain).toBe(previous.chain);
        expect(chain.transcriptItems[0]).toBe(previous.chain.transcriptItems[0]);
        expect(index.transcriptMessageKeys).toBe(previous.index.transcriptMessageKeys);
        expect(index.loadedReplySources).toBe(previous.index.loadedReplySources);
        expect(index.messageRowKeysById).toBe(previous.index.messageRowKeysById);
        expect(index.positionIndex.markerIdsByMessageId).toBe(
          previous.index.positionIndex.markerIdsByMessageId,
        );
        expect(projectTranscriptRows(index.rows, previews, [])).toBe(
          projectTranscriptRows(previous.index.rows, previews, []),
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

describe("subagent handoff", () => {
  const prose = makeMessage("prose", 2);
  const readRow = (id: string, runId: string, seq: number) => makeTool(id, seq, runId, 20 + seq);
  const waiting = [
    history[0],
    prose,
    readRow("read-1", "run-1", 3),
    makeMessage("yield-call", 4, {
      content: [{ type: "toolCall", id: "yield", name: "sessions_yield", arguments: {} }],
      timestamp: 30,
    }),
    makeMessage("yield-result", 5, {
      content: [{ type: "text", text: '{"status":"yielded"}' }],
      role: "toolResult",
      toolCallId: "yield",
      toolName: "sessions_yield",
      timestamp: 31,
    }),
  ];
  const answer = makeMessage("answer", 8, {
    stopReason: "stop",
    timestamp: 50,
    runId: "announce:resume",
  });
  const waitingChain = () =>
    projectHistory(waiting, { subagentWait: { startedAt: 32, runId: "run-1" } });
  const resumedSession = {
    key: sessionKey,
    lastRunId: "announce:resume",
    status: "done",
    runtimeMs: 4_000,
  } as const;
  it.each([
    [
      "waiting",
      { subagentWait: { startedAt: 32, runId: "run-1" } },
      "run-1",
      { waitingOn: "subagents" },
    ],
    ["wait ended", {}, "run-1", null],
    ["resume pending", { runWorking: true, runActive: true }, undefined, { startedAt: 10 }],
    ["answered", { session: resumedSession }, "announce:resume", null],
  ] as const)("preserves handoff: %s", (state, options, runId, statusShape) => {
    const waitingKey = onlyFrame(waitingChain()).key;
    if (state === "resume pending") {
      resetWorkingProgress();
    }
    const completed = state === "answered";
    const messages = completed
      ? [...waiting, readRow("read-2", "announce:resume", 7), answer]
      : waiting;
    const chain = projectHistory(messages, options);
    const frame = onlyFrame(chain);
    const indexed = indexFor(chain).rows.find((row) => row.key === frame.key);
    expect(indexed?.kind).toBe("item");
    expect(indexed?.kind === "item" && indexed.revision).toEqual(
      statusShape ? undefined : expect.any(String),
    );
    expect(frame).toMatchObject({
      key: waitingKey,
      ...(runId ? { runId } : {}),
    });
    expect(frameShows(frame, prose)).toBe(true);
    expect(frame.parts.some((part) => part.kind === "work-group")).toBe(false);
    expect(chain.transcriptItems.some((item) => item.kind === "notice")).toBe(false);
    expect(chain.transcriptItems.some((item) => item.kind === "stream-run")).toBe(false);
    if (state !== "wait ended") {
      expect(frame.outcome).toMatchObject(
        completed ? completedOutcome(answer) : { kind: "active" },
      );
    }
    if (statusShape) {
      const status = frame.parts.flatMap((part) => (part.kind === "stream-run" ? part.parts : []));
      expect(status).toEqual([
        expect.objectContaining({ kind: "reading-indicator", ...statusShape }),
      ]);
      if (state === "resume pending") {
        expect(status[0]).not.toHaveProperty("runId");
      }
    }
    if (completed) {
      expect(frameShows(frame, answer)).toBe(true);
      expect(new Set(chatItemGroups(frame).map((group) => group.runId))).toEqual(
        new Set(["run-1", "announce:resume"]),
      );
    }
    if (state === "wait ended") {
      expect(frame.parts.at(-1)).toMatchObject({ kind: "group", role: "tool" });
    }
  });

  it("keeps operations on either side of a handoff in one row unless the agent spoke between", () => {
    const logsOf = (messages: unknown[]) =>
      framesOf(projectHistory(messages)).flatMap((frame) => kind(frame.parts, "activity-run"));
    const waitingRow = framesOf(waitingChain())[0]?.parts.find(
      (part) => part.kind === "group" && part.messages.every((source) => source.message !== prose),
    );
    const resumedRow = readRow("read-2", "announce:resume", 7);
    const resumed = projectHistory([...waiting, resumedRow, answer]);
    const logs = framesOf(resumed).flatMap((frame) => kind(frame.parts, "activity-run"));
    expect(logs).toHaveLength(1);
    // The row the reader may have opened while waiting keeps its identity.
    expect(logs[0]).toMatchObject({ key: `activity:${waitingRow?.key}` });
    expect(logs[0]?.groups.map((group) => group.runId)).toEqual(["run-1", "announce:resume"]);
    const index = indexFor(resumed);
    expect(new Set(["read-1", "read-2"].map((id) => index.messageRowKeysById.get(id)))).toEqual(
      new Set([framesOf(resumed)[0]?.key]),
    );
    const spoke = makeMessage("spoke", 6, {
      timestamp: 45,
      runId: "announce:resume",
    });
    expect(logsOf([...waiting, spoke, resumedRow, answer])).toEqual([]);
  });

  it("moves successful late work before the answer but preserves failure and channel ordering", () => {
    const wrapper = readRow("wrapper", "announce:resume", 9);
    const stopped = makeMessage("stopped", 9, {
      content: [{ type: "toolCall", id: "late", name: "read", arguments: {} }],
      stopReason: "error",
      timestamp: 60,
      runId: "announce:resume",
    });
    for (const [trailing, answerLast, logSizes, key] of [
      [wrapper, true, [3], sessionKey],
      [{ ...wrapper, isError: true }, false, [2], sessionKey],
      [stopped, false, undefined, sessionKey],
      [wrapper, false, [2], "agent:main:main"],
    ] as const) {
      const { parts } = onlyFrame(
        projectHistory([...waiting, readRow("read-2", "announce:resume", 7), answer, trailing], {
          sessionKey: key,
          session: { key, lastRunId: "announce:resume", status: "done" },
        }),
      );
      const last = parts.at(-1);
      expect(
        last?.kind === "group" && last.messages.some((source) => source.message === answer),
      ).toBe(answerLast);
      if (logSizes) {
        expect(kind(parts, "activity-run").map((part) => part.groups.length)).toEqual(logSizes);
      }
    }
  });

  it("keeps a later request apart from the block that handed off", () => {
    const chain = projectHistory([
      ...waiting,
      makeMessage("next", 6, {
        role: "user",
        timestamp: 40,
        runId: "run-2",
      }),
      { ...answer, __openclaw: { id: "answer", seq: 7, runId: "run-2" } },
    ]);
    expect(framesOf(chain).map((frame) => frame.runId)).toEqual(["run-1", "run-2"]);
  });
});

describe("system event presentation", () => {
  const systemMessage = (id: string, runId: string) => ({
    role: "user",
    content: "[System] Continue the interrupted turn.",
    timestamp: 20,
    provenance: { kind: "internal_system", sourceTool: "main_session_restart_recovery" },
    __openclaw: { id, idempotencyKey: runId + ":user" },
  });

  it("folds only consecutive events after preserving the following run's boundary", () => {
    const messages = [
      history[0],
      systemMessage("recover-a", "run-a"),
      systemMessage("recover-b", "run-b"),
      { ...partial, __openclaw: { id: "reply-b", runId: "run-b" } },
      systemMessage("recover-c", "run-c"),
      { role: "user", content: "Keep this human message visible.", timestamp: 40 },
      systemMessage("recover-d", "run-d"),
    ];
    const chain = chainFor(chatItems({ messages }), { ...chainOptions, messages });
    expect(chain.transcriptItems.map((item) => item.kind)).toEqual([
      "group",
      "system-event-group",
      "agent-run-frame",
      "notice",
      "group",
      "notice",
    ]);
    expect(chain.transcriptItems[1]).toMatchObject({
      events: [expect.anything(), expect.anything()],
    });
    expect(chain.transcriptItems[2]).toMatchObject({
      kind: "agent-run-frame",
      runId: "run-b",
      boundaryId: "send:run-b",
    });
    const searched = chainFor(chatItems({ messages }), {
      ...chainOptions,
      searchActive: true,
    });
    expect(searched.transcriptItems.filter((item) => item.kind === "notice")).toHaveLength(4);
    expect(searched.transcriptItems.some((item) => item.kind === "system-event-group")).toBe(false);
  });

  it("keeps pending custody and ordinary notices outside the fold", () => {
    const events = chatItems({
      messages: [systemMessage("recover-a", "run-a"), systemMessage("recover-b", "run-b")],
    });
    const pending = {
      kind: "notice",
      key: "pending",
      text: "Delivery interrupted. Review the saved message.",
      timestamp: 25,
    } as const;
    const chain = chainFor([events[0]!, pending, events[1]!], chainOptions);
    expect(chain.transcriptItems.map((item) => item.kind)).toEqual(["notice", "notice", "notice"]);
    expect(chain.transcriptItems[1]).toBe(pending);
  });
});
