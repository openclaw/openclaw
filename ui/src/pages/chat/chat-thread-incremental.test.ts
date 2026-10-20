// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { normalizeMessage } from "../../lib/chat/message-normalizer.ts";
import { extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
import * as displayText from "../../lib/strip-thinking-tags.ts";
import { buildChatItems, type BuildChatItemsProps } from "./chat-thread-build.ts";
import * as duplicatePreparation from "./chat-thread-duplicates.ts";
import { queued, groupsOf, toolResult } from "./chat-thread-fixtures.test-support.ts";
import { createProps } from "./chat-thread.test-support.ts";
import { buildCachedChatItems, resetChatThreadState } from "./chat-thread.ts";

beforeEach(() => resetChatThreadState());
afterEach(() => {
  vi.restoreAllMocks();
  resetChatThreadState();
});

function chatProps(overrides: Partial<BuildChatItemsProps>): BuildChatItemsProps {
  return createProps({
    paneId: "incremental-equivalence",
    sessionKey: "incremental-equivalence",
    runId: undefined,
    ...overrides,
  });
}

function deepFreeze(value: unknown): void {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(Object.freeze(value)).forEach(deepFreeze);
  }
}

type Fields = Record<string, unknown>;
function message(id: string, role: string, ts: number, content: unknown, extra: Fields = {}) {
  return { role, timestamp: ts, content, __openclaw: { id, seq: ts }, ...extra };
}
const turn = (id: string, timestamp: number, label: string) => [
  message(`${id}-user`, "user", timestamp, `${label} request`),
  message(`${id}-answer`, "assistant", timestamp + 1, `${label} answer`),
];
function personMessage(id: string, ts: number, content: string, name: string, extra: Fields = {}) {
  const senderId = name.toLowerCase();
  const metadata = { id, seq: ts, senderId, senderName: name, ...extra };
  return message(id, "user", ts, content, { __openclaw: metadata });
}

function fixture(): { props: BuildChatItemsProps; older: unknown[] } {
  const duplicate = { role: "assistant", content: "Needle repeated update" };
  const liveContent = [
    { type: "toolcall", id: "live-call", name: "read", arguments: { path: "live.txt" } },
    { type: "toolresult", id: "live-call", name: "read", text: "Needle live output" },
  ];
  const canvas = JSON.stringify({
    kind: "canvas",
    view: {
      id: "cv_incremental",
      url: "/__openclaw__/canvas/documents/cv_incremental/index.html",
      title: "Needle canvas",
      preferred_height: 320,
    },
    presentation: { target: "assistant_message" },
  });
  return {
    older: [
      ...turn("older", 1, "Earlier needle"),
      message("seam-user", "user", 3, "Needle seam request"),
      message("seam-call", "assistant", 4, [
        { type: "tool_use", id: "seam-call", name: "read", input: { path: "seam.txt" } },
      ]),
    ],
    props: chatProps({
      messages: [
        toolResult("seam-call", "read", "Needle seam output", 5, {
          __openclaw: { id: "seam-result", seq: 5 },
        }),
        message("seam-answer", "assistant", 6, "Needle seam answer"),
        personMessage("canvas-user", 10, "Needle canvas request", "Alice"),
        message("canvas-call", "assistant", 11, [
          { type: "tool_use", id: "canvas-call", name: "canvas_render", input: {} },
        ]),
        toolResult("canvas-call", "canvas_render", canvas, 12, {
          __openclaw: { id: "canvas-result", seq: 12 },
        }),
        message("canvas-answer", "assistant", 13, "Needle canvas ready"),
        message("duplicate-user", "user", 20, "Needle duplicate request"),
        ...[21, 22].map((seq) =>
          Object.assign({}, duplicate, { timestamp: seq, __openclaw: { seq } }),
        ),
        message("compaction", "system", 25, "", {
          __openclaw: { kind: "compaction", id: "compaction", seq: 25 },
        }),
        ...turn("hidden", 30, "Unrelated"),
        personMessage("active-user", 40, "Needle active request", "Bob", {
          idempotencyKey: "active-run:user",
        }),
      ],
      toolMessages: [
        message("live-tool", "assistant", 42, liveContent, {
          runId: "active-run",
          toolCallId: "live-call",
          __openclawToolStreamLive: true,
          __openclawToolStreamResultReceived: true,
        }),
      ],
      streamSegments: [
        { text: "Needle working.", ts: 41, runId: "active-run", toolCallId: "live-call" },
      ],
      stream: "Needle working. Still working.",
      streamStartedAt: 41,
      runId: "active-run",
      runWorking: true,
      queue: [
        queued("queued-input", "Needle queued follow-up", 50, "waiting-reconnect", {
          sendSubmittedAtMs: 50,
          sendAttempts: 1,
        }),
      ],
    }),
  };
}

function freezeMessages(messages: unknown[]): void {
  messages.forEach((raw) => deepFreeze(normalizeMessage(raw)));
}

function freezeProjectedMessages(items: ReturnType<typeof buildChatItems>): void {
  freezeMessages(groupsOf(items).flatMap((group) => group.messages.map((entry) => entry.message)));
}

it.each([
  { searchOpen: false, showToolCalls: true },
  { searchOpen: false, showToolCalls: false },
  { searchOpen: true, showToolCalls: true },
  { searchOpen: true, showToolCalls: false },
])("preserves cold output with search=$searchOpen tools=$showToolCalls", (options) => {
  const { props: base, older } = fixture();
  const props = { ...base, ...options, searchQuery: "needle" };
  const prepended = { ...props, messages: [...older, ...props.messages] };
  // New object identities guarantee cold normalization and turn-coalescing inputs.
  const coldInitial = buildChatItems(structuredClone(props));
  const coldPrepended = buildChatItems(structuredClone(prepended));
  freezeMessages([...prepended.messages, ...prepended.toolMessages]);
  const initial = buildChatItems(props);
  freezeProjectedMessages(initial);
  expect(buildChatItems(props)).toEqual(coldInitial);
  expect(initial).toEqual(coldInitial);

  const warmPrepended = buildChatItems(prepended);
  freezeProjectedMessages(warmPrepended);
  expect(warmPrepended).toEqual(coldPrepended);
  expect(buildChatItems(prepended)).toEqual(coldPrepended);

  const groups = groupsOf(warmPrepended);
  const entries = groups.flatMap((group) => group.messages);
  expect(entries.some((entry) => entry.duplicateCount === 2)).toBe(true);
  const content = entries.flatMap((entry) => normalizeMessage(entry.message).content);
  expect(content).toContainEqual(expect.objectContaining({ type: "canvas" }));
  expect(warmPrepended.some((item) => item.kind === "divider" && item.compactionId)).toBe(true);
  expect(warmPrepended.some((item) => item.kind === "stream" && item.isStreaming)).toBe(true);
  expect(warmPrepended.some((item) => item.kind === "reading-indicator")).toBe(true);
  expect(content).toContainEqual(
    expect.objectContaining({ type: "text", text: "Needle queued follow-up" }),
  );
  expect(JSON.stringify(warmPrepended).includes("Unrelated answer")).toBe(!options.searchOpen);
  if (options.showToolCalls && !options.searchOpen) {
    expect(entries.flatMap((entry) => extractToolCardsCached(entry.message))).toContainEqual(
      expect.objectContaining({ callId: "seam-call", outputText: "Needle seam output" }),
    );
  }
});

it("does not re-strip retained display payloads when older history is prepended", () => {
  const strip = vi.spyOn(displayText, "stripThinkingTags");
  const preparation = vi.spyOn(duplicatePreparation, "prepareMessagesForGrouping");
  const props = chatProps({
    paneId: "prepend-work",
    sessionKey: "prepend-work",
    messages: turn("recent", 10, "Recent"),
  });
  buildCachedChatItems(props);
  strip.mockClear();
  preparation.mockClear();
  const items = buildCachedChatItems({
    ...props,
    messages: [...turn("older", 1, "Earlier"), ...props.messages],
  });
  expect(items.filter((item) => item.kind === "group")).toHaveLength(4);
  expect(strip.mock.calls.some(([text]) => text === "Earlier answer")).toBe(true);
  expect(strip.mock.calls.filter(([text]) => text === "Recent answer")).toHaveLength(0);
  expect(
    preparation.mock.calls
      .flatMap(([source]) => source)
      .filter((item) => item.kind === "message" && props.messages.includes(item.message)),
  ).toHaveLength(0);
});

it("recomputes shared reply attribution without annotating retained grouping segments", () => {
  const alice = personMessage("alice", 10, "Alice request", "Alice");
  const props = chatProps({
    paneId: "prepend-people",
    sessionKey: "prepend-people",
    messages: [alice, message("answer", "assistant", 11, "Alice answer")],
  });
  const answer = (messages = props.messages) =>
    groupsOf(buildCachedChatItems({ ...props, messages })).findLast(
      (item) => item.role === "assistant",
    );
  const initial = answer();
  expect(initial?.replyShared).toBeUndefined();
  const shared = answer([
    personMessage("bob", 1, "Bob request", "Bob"),
    message("bob-answer", "assistant", 2, "Bob answer"),
    ...props.messages,
  ]);
  expect(shared?.replyShared).toBe(true);
  expect(shared?.replyToMessage?.message).toBe(alice);
  expect(initial?.replyShared).toBeUndefined();
  const reset = answer();
  expect([reset?.replyShared, reset?.replyToMessage]).toEqual([undefined, undefined]);
  expect(shared?.replyShared).toBe(true);
});

it.each([
  { name: "cold forwarded turns", sizes: [24], work: [24] },
  {
    name: "retired overlapping snapshots",
    sizes: [6, 12, 18, 24, 6, 24],
    work: [null, null, null, null, 6, 24],
  },
])("bounds source work for $name", ({ sizes, work }) => {
  const preparation = vi.spyOn(duplicatePreparation, "prepareMessagesForGrouping");
  const messages = Array.from({ length: 24 }, (_, index) =>
    message(`forwarded-${index}`, "assistant", index + 1, `Forwarded update ${index}`, {
      provenance: { kind: "inter_session", sourceTool: "sessions_send" },
    }),
  );
  for (const [index, count] of sizes.entries()) {
    preparation.mockClear();
    const items = buildChatItems(
      chatProps({
        paneId: "forwarded-work",
        sessionKey: "forwarded-work",
        messages: messages.slice(-count),
      }),
    );
    expect(groupsOf(items)).toHaveLength(count);
    if (work[index] !== null) {
      expect(preparation.mock.calls.reduce((total, [source]) => total + source.length, 0)).toBe(
        work[index],
      );
    }
  }
});
