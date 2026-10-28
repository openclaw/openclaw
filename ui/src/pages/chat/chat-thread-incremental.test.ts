// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { normalizeMessage } from "../../lib/chat/message-normalizer.ts";
import { extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
import * as displayText from "../../lib/strip-thinking-tags.ts";
import { buildChatItems, type BuildChatItemsProps } from "./chat-thread-build.ts";
import * as duplicatePreparation from "./chat-thread-duplicates.ts";
import { createProps } from "./chat-thread.test-support.ts";
import { buildCachedChatItems, resetChatThreadState } from "./chat-thread.ts";

function deepFreeze(value: unknown): void {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
}

function message(
  id: string,
  role: string,
  timestamp: number,
  content: unknown,
  extra: Record<string, unknown> = {},
) {
  return { role, timestamp, content, __openclaw: { id, seq: timestamp }, ...extra };
}

function fixture(): { props: BuildChatItemsProps; older: unknown[] } {
  const canvas = JSON.stringify({
    kind: "canvas",
    view: {
      backend: "canvas",
      id: "cv_incremental",
      url: "/__openclaw__/canvas/documents/cv_incremental/index.html",
      title: "Needle canvas",
      preferred_height: 320,
    },
    presentation: { target: "assistant_message" },
  });
  return {
    older: [
      message("older-user", "user", 1, "Earlier needle request"),
      message("older-answer", "assistant", 2, "Earlier needle answer"),
      message("seam-user", "user", 3, "Needle seam request"),
      message("seam-call", "assistant", 4, [
        { type: "tool_use", id: "seam-call", name: "read", input: { path: "seam.txt" } },
      ]),
    ],
    props: {
      paneId: "incremental-equivalence",
      sessionKey: "incremental-equivalence",
      messages: [
        message("seam-result", "toolResult", 5, "Needle seam output", {
          toolCallId: "seam-call",
          toolName: "read",
        }),
        message("seam-answer", "assistant", 6, "Needle seam answer"),
        message("canvas-user", "user", 10, "Needle canvas request", {
          __openclaw: { id: "canvas-user", seq: 10, senderId: "alice", senderName: "Alice" },
        }),
        message("canvas-call", "assistant", 11, [
          { type: "tool_use", id: "canvas-call", name: "canvas_render", input: {} },
        ]),
        message("canvas-result", "toolResult", 12, canvas, {
          toolCallId: "canvas-call",
          toolName: "canvas_render",
        }),
        message("canvas-answer", "assistant", 13, "Needle canvas ready"),
        message("duplicate-user", "user", 20, "Needle duplicate request"),
        message("duplicate-a", "assistant", 21, "Needle repeated update", {
          __openclaw: { seq: 21 },
        }),
        message("duplicate-b", "assistant", 22, "Needle repeated update", {
          __openclaw: { seq: 22 },
        }),
        message("compaction", "system", 25, "", {
          __openclaw: { kind: "compaction", id: "compaction", seq: 25 },
        }),
        message("hidden-user", "user", 30, "Unrelated request"),
        message("hidden-answer", "assistant", 31, "Unrelated answer"),
        message("active-user", "user", 40, "Needle active request", {
          __openclaw: {
            id: "active-user",
            seq: 40,
            idempotencyKey: "active-run:user",
            senderId: "bob",
            senderName: "Bob",
          },
        }),
      ],
      toolMessages: [
        message(
          "live-tool",
          "assistant",
          42,
          [
            { type: "toolcall", id: "live-call", name: "read", arguments: { path: "live.txt" } },
            { type: "toolresult", id: "live-call", name: "read", text: "Needle live output" },
          ],
          {
            runId: "active-run",
            toolCallId: "live-call",
            __openclawToolStreamLive: true,
            __openclawToolStreamResultReceived: true,
          },
        ),
      ],
      streamSegments: [
        { text: "Needle working.", ts: 41, runId: "active-run", toolCallId: "live-call" },
      ],
      stream: "Needle working. Still working.",
      streamStartedAt: 41,
      runId: "active-run",
      runWorking: true,
      showToolCalls: true,
      queue: [
        {
          id: "queued-input",
          text: "Needle queued follow-up",
          createdAt: 50,
          sendState: "waiting-reconnect",
          sendSubmittedAtMs: 50,
          sendAttempts: 1,
        },
      ],
    },
  };
}

function freezeNormalizedMessages(props: BuildChatItemsProps): void {
  for (const raw of [...props.messages, ...props.toolMessages]) {
    deepFreeze(normalizeMessage(raw));
  }
}

function freezeProjectedMessages(items: ReturnType<typeof buildChatItems>): void {
  for (const item of items) {
    if (item.kind === "group") {
      for (const entry of item.messages) {
        deepFreeze(normalizeMessage(entry.message));
      }
    }
  }
}

describe("incremental history build equivalence", () => {
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
    freezeNormalizedMessages(prepended);
    const initial = buildChatItems(props);
    freezeProjectedMessages(initial);
    expect(buildChatItems(props)).toEqual(coldInitial);
    expect(initial).toEqual(coldInitial);

    const warmPrepended = buildChatItems(prepended);
    freezeProjectedMessages(warmPrepended);
    expect(warmPrepended).toEqual(coldPrepended);
    expect(buildChatItems(prepended)).toEqual(coldPrepended);

    const groups = warmPrepended.filter((item) => item.kind === "group");
    const entries = groups.flatMap((group) => group.messages);
    expect(
      entries.filter((entry) =>
        normalizeMessage(entry.message).content.some(
          (block) => block.type === "text" && block.text === "Needle repeated update",
        ),
      ),
    ).toHaveLength(2);
    expect(
      entries.some((entry) =>
        normalizeMessage(entry.message).content.some((block) => block.type === "canvas"),
      ),
    ).toBe(true);
    expect(warmPrepended.some((item) => item.kind === "divider" && item.compactionId)).toBe(true);
    expect(warmPrepended.some((item) => item.kind === "stream" && item.isStreaming)).toBe(true);
    expect(warmPrepended.some((item) => item.kind === "reading-indicator")).toBe(true);
    expect(
      entries.some((entry) =>
        normalizeMessage(entry.message).content.some(
          (block) => block.type === "text" && block.text === "Needle queued follow-up",
        ),
      ),
    ).toBe(true);
    expect(JSON.stringify(warmPrepended).includes("Unrelated answer")).toBe(!options.searchOpen);
    if (options.showToolCalls && !options.searchOpen) {
      expect(entries.flatMap((entry) => extractToolCardsCached(entry.message))).toContainEqual(
        expect.objectContaining({ callId: "seam-call", outputText: "Needle seam output" }),
      );
    }
  });
});

it("does not re-strip retained display payloads when older history is prepended", () => {
  resetChatThreadState();
  const strip = vi.spyOn(displayText, "stripThinkingTags");
  const preparation = vi.spyOn(duplicatePreparation, "prepareMessagesForGrouping");
  try {
    const props = createProps({
      paneId: "prepend-work",
      sessionKey: "prepend-work",
      messages: [
        message("recent-user", "user", 10, "Recent request"),
        message("recent-answer", "assistant", 11, "Recent answer"),
      ],
    });
    buildCachedChatItems(props);
    strip.mockClear();
    preparation.mockClear();
    const items = buildCachedChatItems({
      ...props,
      messages: [
        message("older-user", "user", 1, "Earlier request"),
        message("older-answer", "assistant", 2, "Earlier answer"),
        ...props.messages,
      ],
    });
    expect(items.filter((item) => item.kind === "group")).toHaveLength(4);
    expect(strip.mock.calls.some(([text]) => text === "Earlier answer")).toBe(true);
    expect(strip.mock.calls.filter(([text]) => text === "Recent answer")).toHaveLength(0);
    expect(
      preparation.mock.calls
        .flatMap(([source]) => source)
        .filter((item) => item.kind === "message" && props.messages.includes(item.message)),
    ).toHaveLength(0);
  } finally {
    strip.mockRestore();
    preparation.mockRestore();
    resetChatThreadState();
  }
});

it("recomputes shared reply attribution without annotating retained grouping segments", () => {
  resetChatThreadState();
  try {
    const alice = message("alice", "user", 10, "Alice request", {
      __openclaw: { id: "alice", seq: 10, senderId: "alice", senderName: "Alice" },
    });
    const props = createProps({
      paneId: "prepend-people",
      sessionKey: "prepend-people",
      messages: [alice, message("answer", "assistant", 11, "Alice answer")],
    });
    const answer = (items: ReturnType<typeof buildCachedChatItems>) =>
      items.findLast((item) => item.kind === "group" && item.role === "assistant");
    const initial = answer(buildCachedChatItems(props));
    expect(initial?.kind === "group" && initial.replyShared).toBeUndefined();
    const shared = answer(
      buildCachedChatItems({
        ...props,
        messages: [
          message("bob", "user", 1, "Bob request", {
            __openclaw: { id: "bob", seq: 1, senderId: "bob", senderName: "Bob" },
          }),
          message("bob-answer", "assistant", 2, "Bob answer"),
          ...props.messages,
        ],
      }),
    );
    expect(shared?.kind === "group" && shared.replyShared).toBe(true);
    expect(shared?.kind === "group" && shared.replyToMessage?.message).toBe(alice);
    expect(initial?.kind === "group" && initial.replyShared).toBeUndefined();
    const reset = answer(buildCachedChatItems(props));
    expect(reset?.kind === "group" && reset.replyShared).toBeUndefined();
    expect(reset?.kind === "group" && reset.replyToMessage).toBeUndefined();
    expect(shared?.kind === "group" && shared.replyShared).toBe(true);
  } finally {
    resetChatThreadState();
  }
});

it("groups consecutive forwarded turns with linear source work", () => {
  const preparation = vi.spyOn(duplicatePreparation, "prepareMessagesForGrouping");
  try {
    const messages = Array.from({ length: 24 }, (_, index) =>
      message(`forwarded-${index}`, "assistant", index + 1, `Forwarded update ${index}`, {
        provenance: { kind: "inter_session", sourceTool: "sessions_send" },
      }),
    );
    const items = buildChatItems(
      createProps({ paneId: "forwarded-work", sessionKey: "forwarded-work", messages }),
    );
    expect(items.filter((item) => item.kind === "group")).toHaveLength(messages.length);
    expect(preparation.mock.calls.reduce((count, [source]) => count + source.length, 0)).toBe(
      messages.length,
    );
  } finally {
    preparation.mockRestore();
  }
});

it("retires superseded grouping snapshots when prepends extend a forwarded segment", () => {
  const preparation = vi.spyOn(duplicatePreparation, "prepareMessagesForGrouping");
  try {
    const messages = Array.from({ length: 24 }, (_, index) =>
      message(`retained-${index}`, "assistant", index + 1, `Forwarded update ${index}`, {
        provenance: { kind: "inter_session", sourceTool: "sessions_send" },
      }),
    );
    const build = (count: number) =>
      buildChatItems(
        createProps({
          paneId: "forwarded-retention",
          sessionKey: "forwarded-retention",
          messages: messages.slice(-count),
        }),
      );
    for (const count of [6, 12, 18, 24]) {
      expect(build(count).filter((item) => item.kind === "group")).toHaveLength(count);
    }
    preparation.mockClear();
    build(6);
    // The old suffix must be rebuilt: its overlapping cached snapshot was retired.
    expect(preparation.mock.calls.reduce((count, [source]) => count + source.length, 0)).toBe(6);
    preparation.mockClear();
    build(24);
    expect(preparation.mock.calls.reduce((count, [source]) => count + source.length, 0)).toBe(24);
  } finally {
    preparation.mockRestore();
  }
});
