/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { collectGarbageForTest } from "../../test-helpers/garbage-collection.ts";
import "./chat-pane.tsx";
import { dispatchChatSlashCommand } from "./chat-commands.ts";
import { readChatTranscriptAttachmentSource } from "./chat-history-state.ts";
import { loadChatHistory, reloadChatHistoryWindow } from "./chat-history.ts";
import type { PaneAttachmentCatalog } from "./chat-pane-attachment-catalog.ts";
import {
  createTestChatPane,
  nativeHistorySeq,
  expectNativeHistoryRange,
} from "./chat-pane-history.test-support.ts";
import { residentPane } from "./chat-pane-resident.test-support.ts";
import { createPaneHeaderWorkspaceFixture } from "./chat-pane.test-support.ts";
import * as duplicatePreparation from "./chat-thread-duplicates.ts";
import { buildMessageItems } from "./chat-thread-items.ts";
import { createProps } from "./chat-thread.test-support.ts";
import { buildCachedChatItems } from "./chat-thread.ts";
import type { ChatProps } from "./chat-view.tsx";
import { createTranscriptActions } from "./components/chat-transcript-actions.ts";
import { createTranscriptMessageElements } from "./components/chat-transcript-message-elements.ts";
import { threadProps } from "./components/chat-transcript.test-support.ts";
import { getChatSessionProjection, reduceChatSessionProjection } from "./history-merge.ts";
import { handleChatScrollTakeover } from "./scroll.ts";
import { applySessionMessagePayload } from "./session-message-apply.ts";
import { readChatSessionSnapshot } from "./session-message-cache.ts";

async function olderPages(pane: ReturnType<typeof residentPane>["pane"], count: number) {
  for (let page = 0; page < count; page++) {
    expect(await pane.loadOlderMessages(false)).toBe(true);
  }
}

it("accepts off-window persistence before retiring its exact stream and run owners", async () => {
  const { state } = residentPane();
  await loadChatHistory(state, { deferBranches: true });
  const held = state.chatMessages;
  state.chatRunId = "finishing";
  state.chatStream = "later reply";
  state.knownAgentRunIds.add("finishing");
  state.knownAgentRunIds.add("other-run");
  state.chatStreamSegments = [
    { text: "commentary", ts: 1, runId: "finishing", itemId: "commentary" },
    { text: "other segment", ts: 2, runId: "finishing", itemId: "other-item" },
    { text: "peer run", ts: 3, runId: "other-run", itemId: "commentary" },
  ];
  const commentary = {
    role: "assistant",
    content: "persisted commentary",
    __openclaw: { id: "source-80", seq: 80, runId: "finishing" },
    openclawStreamFallback: { itemId: "commentary", runId: "finishing" },
  };
  applySessionMessagePayload(state, { message: commentary, runId: "finishing" }, true, {
    kind: "live",
    activeRunId: "finishing",
  });
  expect(state.chatMessages).toEqual(held);
  expect(state.chatStream).toBe("later reply");
  expect(state.chatStreamSegments.map((segment) => [segment.runId, segment.itemId])).toEqual([
    ["finishing", "other-item"],
    ["other-run", "commentary"],
  ]);
  applySessionMessagePayload(
    state,
    {
      message: {
        role: "assistant",
        content: "durable final",
        __openclaw: { id: "source-81", seq: 81, runId: "finishing" },
      },
      runId: "finishing",
    },
    false,
    { kind: "live", activeRunId: "finishing" },
  );
  expect(state.chatMessages).toEqual(held);
  expect(state.chatStream).toBeNull();
  expect(state.chatStreamSegments.map((segment) => segment.runId)).toEqual(["other-run"]);
  expect([...state.knownAgentRunIds]).toEqual(["other-run"]);
});

it("rebuilds visible and unfiltered search views without resurrecting retired sources", async () => {
  const { pane, state } = residentPane();
  await loadChatHistory(state, { deferBranches: true });
  const props = () =>
    createProps({
      paneId: pane.paneId,
      sessionKey: state.sessionKey,
      messages: state.chatMessages,
      searchOpen: true,
      searchQuery: "body-601",
    });
  expect(JSON.stringify(buildCachedChatItems(props(), "visible"))).toContain("body-601");
  expect(JSON.stringify(buildCachedChatItems(props(), "unfiltered"))).toContain("body-601");
  await olderPages(pane, 6);
  for (const projection of ["visible", "unfiltered"] as const) {
    for (const searchOpen of [true, false, true]) {
      const input = { ...props(), searchOpen };
      const items = JSON.stringify(buildCachedChatItems(input, projection));
      expect(items).not.toContain("body-601");
      if (!searchOpen) {
        expect(items).toContain("body-81");
      }
      expect(input.searchQuery).toBe("body-601");
    }
  }
});

it("reuses complete survivor turns across real older and newer residency cuts", async () => {
  const { pane, state, requests } = residentPane((messages) => {
    for (const message of messages) {
      message.role = nativeHistorySeq(message)! % 2 ? "user" : "assistant";
      message.timestamp = nativeHistorySeq(message)! * 10;
    }
  });
  pane.paneId = "survivor-physical";
  pane.presentationId = JSON.stringify([pane.paneId, state.sessionKey]);
  expect(pane.presentationId).not.toBe(pane.paneId);
  await loadChatHistory(state, { deferBranches: true });
  await olderPages(pane, 4);
  expectNativeHistoryRange(state.chatMessages, 241, 400);
  const survivors = state.chatMessages.slice(0, 320);
  const retained = new Set(survivors);
  const views = ["visible", "unfiltered"] as const;
  const build = (view: (typeof views)[number]) =>
    buildCachedChatItems(
      createProps({
        paneId: pane.presentationId,
        sessionKey: state.sessionKey,
        messages: state.chatMessages,
      }),
      view,
    ).filter((item) => item.kind === "group");
  let previous = views.map(build);
  for (const items of previous) {
    expect(items.flatMap((item) => item.messages.map((entry) => entry.message))).toEqual(
      state.chatMessages,
    );
  }
  const preparation = vi.spyOn(duplicatePreparation, "prepareMessagesForGrouping");
  try {
    for (const direction of ["older", "newer"] as const) {
      preparation.mockClear();
      const before = requests.length;
      expect(
        await (direction === "older" ? pane.loadOlderMessages(false) : pane.loadNewerMessages()),
      ).toBe(true);
      const first = direction === "older" ? 161 : 241;
      expectNativeHistoryRange(state.chatMessages, first, 400);
      const currentSurvivors = state.chatMessages.filter((message) => retained.has(message));
      expect(currentSurvivors).toHaveLength(320);
      expect(currentSurvivors.every((message, index) => message === survivors[index])).toBe(true);
      expect(requests.slice(before)).toEqual([
        {
          cursor: direction === "older" ? "before-241" : "after-560",
          messageId: undefined,
          offset: undefined,
          limit: direction === "older" ? 80 : 400,
        },
      ]);
      expect(state.chatHistoryPagination.hasNewer).toBe(direction === "older" ? true : undefined);
      const next = views.map(build);
      for (const [index, items] of next.entries()) {
        expect(items.flatMap((item) => item.messages.map((entry) => entry.message))).toEqual(
          state.chatMessages,
        );
        const prior = new Map(previous[index]!.map((item) => [item.key, item]));
        const kept = items.filter((item) =>
          item.messages.every((entry) => retained.has(entry.message)),
        );
        expect(kept).toHaveLength(320);
        expect(kept.every((item) => prior.has(item.key))).toBe(true);
        const boundary = kept[0]!;
        const oldBoundary = prior.get(boundary.key)!;
        // The cut changes only source-241's adjacent-reply attribution, not its raw source.
        expect(boundary).not.toBe(oldBoundary);
        expect(boundary).toMatchObject({
          key: oldBoundary.key,
          replyPreviousMessageId: direction === "older" ? "source-240" : undefined,
        });
        expect(boundary.messages[0]!.key).toBe(oldBoundary.messages[0]!.key);
        expect(boundary.messages[0]!.message).toBe(survivors[0]);
        expect(oldBoundary).toMatchObject({
          replyPreviousMessageId: direction === "older" ? undefined : "source-240",
        });
        expect
          .soft(
            kept.slice(1).every((item) => prior.get(item.key) === item),
            direction + ": " + views[index],
          )
          .toBe(true);
      }
      expect
        .soft(
          preparation.mock.calls
            .flatMap(([items]) => items)
            .filter((item) => item.kind === "message" && retained.has(item.message)).length,
          direction + ": retained preparation",
        )
        .toBe(0);
      previous = next;
    }
  } finally {
    preparation.mockRestore();
  }
});

it("recovers every evicted newer page through its exact opaque edge", async () => {
  const { pane, state, requests } = residentPane();
  await loadChatHistory(state, { deferBranches: true });
  await olderPages(pane, 6);
  expectNativeHistoryRange(state.chatMessages, 81, 400);
  expect(state.chatHistoryPagination.newerCursor).toBe("after-480");
  const before = requests.length;
  expect(await pane.loadNewerMessages()).toBe(true);
  expect(await pane.loadNewerMessages()).toBe(false);
  expectNativeHistoryRange(state.chatMessages, 241, 400);
  expect(state.chatHistoryPagination.hasNewer).toBeUndefined();
  expect(requests.slice(before)).toEqual([
    { cursor: "after-480", messageId: undefined, offset: undefined, limit: 400 },
  ]);
  expect(requests.every((request) => request.offset === undefined)).toBe(true);
});

it.each([2_000, 400])(
  "continues newer at a clamped %i-pixel window without scroll movement",
  async (height) => {
    const { pane, state, requests } = residentPane();
    await loadChatHistory(state, { deferBranches: true });
    await olderPages(pane, 6);
    expect(state.chatHistoryPagination.newerCursor).toBe("after-480");
    const thread = pane.transcript.scrollElement!;
    Object.defineProperty(thread, "scrollHeight", { configurable: true, value: height });
    thread.scrollTop = Math.max(0, height - thread.clientHeight);
    thread.addEventListener("wheel", (event) => pane.handleTranscriptHistoryIntent(event));
    const before = requests.length;
    // At a restored physical bottom (or a short window), native offset cannot move.
    thread.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 }));
    expect(requests.slice(before)).toEqual([
      { cursor: "after-480", messageId: undefined, offset: undefined, limit: 400 },
    ]);
    await vi.waitFor(() => expect(nativeHistorySeq(state.chatMessages.at(-1))).toBe(640));
    expect(state.chatHistoryPagination.hasNewer).toBeUndefined();
    expect(requests.slice(before)).toEqual([
      { cursor: "after-480", messageId: undefined, offset: undefined, limit: 400 },
    ]);
  },
);

it("bounds sparse response segments independently from visible entry count", async () => {
  const { pane, state } = residentPane((messages) => {
    messages.splice(1);
  }, 1_280);
  await loadChatHistory(state, { deferBranches: true });
  await olderPages(pane, 9);
  expect(state.chatMessages.map(nativeHistorySeq)).toEqual([
    481, 561, 641, 721, 801, 881, 961, 1041,
  ]);
  expect(state.chatHistoryPagination.segments).toHaveLength(8);
  expect(state.chatHistoryPagination.newerCursor).toBe("after-1120");
  expect(state.chatHistoryPagination.hasNewer).toBe(true);
});

it("reopens a refreshed partial segment before recovering its discarded successor", async () => {
  const { pane, state, requests, append } = residentPane();
  await loadChatHistory(state, { deferBranches: true });
  await olderPages(pane, 4);
  append(40);
  await loadChatHistory(state, { deferBranches: true });
  expect(nativeHistorySeq(state.chatMessages.at(-1))).toBe(680);
  await pane.loadOlderMessages(false);
  expect(nativeHistorySeq(state.chatMessages.at(-1))).toBe(640);
  expect(state.chatHistoryPagination.needsNewerBoundary).toBe(true);
  const before = requests.length;
  expect(await pane.loadNewerMessages()).toBe(true);
  expect(requests.slice(before)).toEqual([
    { messageId: "source-640", cursor: undefined, offset: undefined, limit: 1 },
    { cursor: "after-640", messageId: undefined, offset: undefined, limit: 400 },
  ]);
  expectNativeHistoryRange(state.chatMessages, 321, 360);
});

it("keeps a detached reader on background refresh and restores the durable tail for Latest", async () => {
  const { pane, state, append } = residentPane();
  await loadChatHistory(state, { deferBranches: true });
  await olderPages(pane, 6);
  const held = state.chatMessages;
  append(40);
  await loadChatHistory(state, { deferBranches: true });
  expect(state.chatMessages).toEqual(held);
  state.scrollToBottom();
  await vi.waitFor(() => expect(nativeHistorySeq(state.chatMessages.at(-1))).toBe(680));
  expect(nativeHistorySeq(state.chatMessages[0])).toBe(601);
  expect(state.chatHistoryPagination.hasNewer).toBeUndefined();
});

it.each(["older", "newer"] as const)(
  "records a retryable %s read interrupted by a same-session refresh",
  async (direction) => {
    const { pane, state, requests, holdNextCursor } = residentPane();
    await loadChatHistory(state, { deferBranches: true });
    await olderPages(pane, 6);
    const loadPage = () =>
      direction === "older" ? pane.loadOlderMessages() : pane.loadNewerMessages();
    const cursor =
      direction === "older"
        ? state.chatHistoryPagination.hasMore && state.chatHistoryPagination.olderCursor
        : state.chatHistoryPagination.newerCursor;
    const before = requests.length;
    const release = holdNextCursor();
    const load = loadPage();
    await vi.waitFor(() => expect(requests.length).toBe(before + 1));
    await loadChatHistory(state, { deferBranches: true, supersedeInFlight: true });
    release();
    expect(await load).toBe(false);
    expect(
      direction === "older"
        ? state.chatHistoryPagination.hasMore && state.chatHistoryPagination.olderCursor
        : state.chatHistoryPagination.newerCursor,
    ).toBe(cursor);
    expect(direction === "older" ? pane.history.olderError : state.lastError).toBe(
      "History refreshed before this page loaded. Try again.",
    );
    const retry = requests.length;
    expect(await loadPage()).toBe(true);
    expect(requests[retry]?.cursor).toBe(cursor);
  },
);

it.each(["success", "failure"])(
  "preserves reader ownership when a held Latest reload settles with %s",
  async (outcome) => {
    const { pane, state, requests, holdNextTail } = residentPane();
    await loadChatHistory(state, { deferBranches: true });
    await olderPages(pane, 6);
    const held = state.chatMessages;
    const pagination = state.chatHistoryPagination;
    const before = requests.length;
    const release = holdNextTail(
      outcome === "failure" ? new Error("held Latest failed") : undefined,
    );
    state.scrollToBottom();
    await vi.waitFor(() => expect(requests.length).toBe(before + 1));
    const settling = loadChatHistory(state, { deferBranches: true });
    state.chatScrollElement = () => pane.transcript.scrollElement;
    pane.transcript.scrollElement!.scrollTop = 500;
    handleChatScrollTakeover(state);
    expect(state.chatReadingHistory).toBe(true);
    state.lastError = "reader-owned error";
    release();
    await settling;
    await Promise.resolve();
    await Promise.resolve();
    expect(state.chatMessages).toBe(held);
    expect(state.chatHistoryPagination).toEqual(pagination);
    expect(state.chatFollowLocked).toBe(true);
    expect(state.chatReadingHistory).toBe(true);
    expect(state.lastError).toBe("reader-owned error");
  },
);

it.each(["session", "agent", "connection"])(
  "does not scroll or publish a Latest error into a successor %s",
  async (successor) => {
    const { pane, state, requests, holdNextTail } = residentPane();
    if (successor === "agent") {
      state.sessionKey = "global";
      state.assistantAgentId = "main";
    }
    await loadChatHistory(state, { deferBranches: true });
    await olderPages(pane, 6);
    const before = requests.length;
    const release = holdNextTail();
    state.scrollToBottom();
    await vi.waitFor(() => expect(requests.length).toBe(before + 1));
    const settling = loadChatHistory(state, { deferBranches: true });
    if (successor === "session") {
      state.sessionKey = "agent:main:other";
    } else if (successor === "agent") {
      state.assistantAgentId = "other";
    } else {
      state.connectionEpoch += 1;
    }
    state.lastError = "successor error";
    state.chatFollowLocked = true;
    state.chatReadingHistory = true;
    release();
    await settling;
    await Promise.resolve();
    expect(state.lastError).toBe("successor error");
    expect(state.chatFollowLocked).toBe(true);
    expect(state.chatReadingHistory).toBe(true);
  },
);

it("keeps observed source-reset authority when a reader cancels Latest", async () => {
  const { pane, state, requests, holdNextTail } = residentPane();
  await loadChatHistory(state, { deferBranches: true });
  await olderPages(pane, 6);
  let before = requests.length;
  const failRecovery = holdNextTail(new Error("recovery failed"));
  const recovery = reloadChatHistoryWindow(state);
  const rejected = expect(recovery).rejects.toThrow();
  await vi.waitFor(() => expect(requests.length).toBe(before + 1));
  failRecovery();
  await rejected;
  before = requests.length;
  const release = holdNextTail();
  state.scrollToBottom();
  await vi.waitFor(() => expect(requests.length).toBe(before + 1));
  const settling = loadChatHistory(state, { deferBranches: true });
  state.chatScrollElement = () => pane.transcript.scrollElement;
  pane.transcript.scrollElement!.scrollTop = 500;
  handleChatScrollTakeover(state);
  release();
  await settling;
  await Promise.resolve();
  await Promise.resolve();
  expectNativeHistoryRange(state.chatMessages, 561, 80);
  expect(state.chatHistoryPagination.hasNewer).toBeUndefined();
  expect(state.chatFollowLocked).toBe(true);
  expect(state.chatReadingHistory).toBe(true);
});

it("keeps attachment coverage partial at the oldest source while newer history is evicted", async () => {
  const { pane, state } = residentPane();
  await loadChatHistory(state, { deferBranches: true });
  await olderPages(pane, 7);
  expect(state.chatHistoryPagination.hasMore).toBe(false);
  expect(state.chatHistoryPagination.hasNewer).toBe(true);
  expect(readChatTranscriptAttachmentSource(state).coverage).toBe("partial");
});

it("preserves an authoritative empty snapshot through resident admission and cache roundtrip", async () => {
  const { state } = createTestChatPane({
    client: {
      request: async () => ({ messages: [], hasMore: false, completeSnapshot: true }),
    } as unknown as GatewayBrowserClient,
  });
  await loadChatHistory(state, { deferBranches: true });
  const cached = readChatSessionSnapshot(state.chatMessagesBySession!, state, {
    sessionKey: state.sessionKey,
  });
  expect(cached?.messages).toEqual([]);
  expect(cached?.pagination).toMatchObject({ hasMore: false, completeSnapshot: true });
});

it.each([
  { start: 1001, end: 1080, complete: false },
  { start: 1, end: 120, complete: true },
])(
  "replaces disjoint or shrinking tail coverage with $start..$end",
  async ({ start, end, complete }) => {
    const { pane, state, replaceTail } = residentPane();
    await loadChatHistory(state, { deferBranches: true });
    await pane.loadOlderMessages(false);
    replaceTail(start, end, complete);
    await loadChatHistory(state, { deferBranches: true });
    expectNativeHistoryRange(state.chatMessages, start, end - start + 1);
    expect(state.chatHistoryPagination.hasMore).toBe(!complete);
    expect(state.chatHistoryPagination.hasNewer).toBeUndefined();
    if (state.chatHistoryPagination.hasMore) {
      expect(state.chatHistoryPagination.olderCursor).toBe(`before-${start}`);
    }
  },
);

it("uses the refreshed segment's own older edge after its retained prefix is evicted", async () => {
  const { pane, state, requests, append } = residentPane();
  await loadChatHistory(state, { deferBranches: true });
  await pane.loadOlderMessages(false);
  await pane.loadOlderMessages(false);
  for (let refresh = 0; refresh < 8; refresh++) {
    append(40);
    await loadChatHistory(state, { deferBranches: true });
  }
  const first = nativeHistorySeq(state.chatMessages[0])!;
  expect(first).toBe(601);
  expect(state.chatHistoryPagination).toMatchObject({
    hasMore: true,
    olderCursor: `before-${first}`,
  });
  expect(await pane.loadOlderMessages(false)).toBe(true);
  expect(requests.at(-1)?.cursor).toBe(`before-${first}`);
  expect(nativeHistorySeq(state.chatMessages[0])).toBe(521);
  expect(new Set(state.chatMessages.map(nativeHistorySeq)).size).toBe(state.chatMessages.length);
});

it("keeps the visible reader's segment contiguous when a growing tail exceeds the budget", async () => {
  const { pane, state, append } = residentPane();
  await loadChatHistory(state, { deferBranches: true });
  await olderPages(pane, 4);
  const held = state.chatMessages[0];
  const item = buildMessageItems(state.chatMessages)[0]!;
  const viewport = pane.transcript.scrollElement!;
  const bubble = document.createElement("div");
  bubble.dataset.messageId = item.key;
  viewport.append(bubble);
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 500 } as DOMRect);
  vi.spyOn(bubble, "getBoundingClientRect").mockReturnValue({ top: 20, bottom: 60 } as DOMRect);
  const refs = createTranscriptMessageElements(() => undefined);
  refs.forKey(item.key)(bubble);
  vi.spyOn(pane.transcript, "messageElements", "get").mockReturnValue(refs);
  append(80);
  await loadChatHistory(state, { deferBranches: true });
  expect(state.chatMessages[0]).toBe(held);
  expectNativeHistoryRange(state.chatMessages, 241, 400);
  expect(state.chatHistoryPagination.hasNewer).toBe(true);
  expect(state.chatHistoryPagination.needsNewerBoundary).toBe(true);
});

function isAlive(reference: WeakRef<object>): boolean {
  // Do not carry a dereferenced target through a suspended test frame.
  return reference.deref() !== undefined;
}

it("does not advance a rejected held page and retries its exact edge after the reader moves", async () => {
  const { pane, state, requests, holdNextCursor } = residentPane();
  await loadChatHistory(state, { deferBranches: true });
  await olderPages(pane, 4);
  const before = requests.length;
  const release = holdNextCursor();
  const load = pane.loadOlderMessages();
  await vi.waitFor(() => expect(requests.length).toBe(before + 1));
  const item = buildMessageItems(state.chatMessages).at(-1)!;
  const viewport = pane.transcript.scrollElement!;
  const bubble = document.createElement("div");
  viewport.append(bubble);
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 500 } as DOMRect);
  vi.spyOn(bubble, "getBoundingClientRect").mockReturnValue({ top: 20, bottom: 60 } as DOMRect);
  const refs = createTranscriptMessageElements(() => undefined);
  refs.forKey(item.key)(bubble);
  vi.spyOn(pane.transcript, "messageElements", "get").mockReturnValue(refs);
  release();
  expect(await load).toBe(false);
  expectNativeHistoryRange(state.chatMessages, 241, 400);
  expect(state.chatHistoryPagination).toMatchObject({ hasMore: true, olderCursor: "before-241" });
  expect(requests.slice(before).map(({ cursor, limit }) => ({ cursor, limit }))).toEqual([
    { cursor: "before-241", limit: 400 },
    { cursor: "before-241", limit: 80 },
    { cursor: "before-241", limit: 1 },
  ]);
  expect(pane.stagedHistory.page?.limit).toBe(1);
  bubble.remove();
  expect(await pane.loadOlderMessages(false)).toBe(true);
  expect(requests.length).toBe(before + 3);
  expect(pane.stagedHistory.page).toBeNull();
  expectNativeHistoryRange(state.chatMessages, 240, 321);
  expect(state.chatHistoryPagination).toMatchObject({ olderCursor: "before-240" });
  expect(await pane.loadOlderMessages(false)).toBe(true);
  expect(requests.at(-1)).toMatchObject({ cursor: "before-240", limit: 80 });
});

it("collects an evicted local command outcome while the same pane and newest output stay alive", async () => {
  const { pane, state } = residentPane();
  await loadChatHistory(state, { deferBranches: true });
  const firstOutput = async () => {
    expect(await dispatchChatSlashCommand(state, "help", "")).toBe("completed");
    return {
      output: new WeakRef(state.chatMessages.at(-1) as object),
      control: new WeakRef({ unowned: true }),
    };
  };
  const references = await firstOutput();
  await collectGarbageForTest();
  expect(isAlive(references.control)).toBe(false);
  expect(isAlive(references.output)).toBe(true);

  for (let index = 0; index < 400; index++) {
    expect(await dispatchChatSlashCommand(state, "help", "")).toBe("completed");
  }
  await collectGarbageForTest();
  expect(isAlive(references.output)).toBe(false);
  expect(state.chatMessages).toHaveLength(400);
  expect(state.chatMessages.at(-1)).toMatchObject({ role: "system", content: expect.any(String) });
  expect(
    getChatSessionProjection(state).entries.some(
      (entry) => entry.localOutput && entry.message === state.chatMessages.at(-1),
    ),
  ).toBe(true);
  expect(pane.state).toBe(state);
});

it("collects retired concrete bodies and dormant projections while the pane and an error pin stay alive", async () => {
  type BodyReferences = {
    message: WeakRef<object>;
    content: WeakRef<object>;
    media: WeakRef<object>;
  };
  let retired: BodyReferences | undefined;
  let pinned: BodyReferences | undefined;
  const { pane, state } = residentPane((messages) => {
    for (const seq of [601, 602]) {
      const message = messages.find((candidate) => nativeHistorySeq(candidate) === seq);
      if (!message) {
        continue;
      }
      const media = {
        type: "image",
        source: { type: "base64", mediaType: "image/png", data: "c3ludGhldGlj" },
      };
      const content = [
        { type: "text", text: `body-${seq} ${"x".repeat(seq === 601 ? 64 * 1024 : 32)}` },
        media,
      ];
      Object.assign(message, {
        role: "assistant",
        content,
        __openclaw: { id: `source-${seq}`, seq, runId: seq === 601 ? "settled" : "error-pin" },
      });
      const references = {
        message: new WeakRef(message),
        content: new WeakRef(content),
        media: new WeakRef(media),
      };
      if (seq === 601) {
        retired = references;
      } else {
        pinned = references;
      }
    }
    const original = messages.find((candidate) => nativeHistorySeq(candidate) === 601);
    const reply = messages.find((candidate) => nativeHistorySeq(candidate) === 603);
    if (original && reply) {
      Object.assign(reply, {
        __openclaw: {
          id: "source-603",
          seq: 603,
          replyToId: "source-601",
          replyToMessage: { ok: true, message: original },
        },
      });
    }
  });
  pane.paneId = "dormant-physical";
  pane.presentationId = JSON.stringify([pane.paneId, state.sessionKey]);
  expect(pane.presentationId).not.toBe(pane.paneId);
  await loadChatHistory(state, { deferBranches: true });
  const populateDormantOwners = () => {
    for (const [seq, runId, status] of [
      [601, "settled", "completed"],
      [602, "error-pin", "error"],
    ] as const) {
      reduceChatSessionProjection(state, {
        type: "runTerminal",
        runId,
        status,
        message: state.chatMessages.find((message) => nativeHistorySeq(message) === seq),
      });
    }
    expect(pane.readReplyMessage("source-601")).toBeDefined();
    const input = createProps({
      paneId: pane.presentationId,
      sessionKey: state.sessionKey,
      messages: state.chatMessages,
    });
    buildCachedChatItems(input, "visible");
    buildCachedChatItems(input, "unfiltered");
    const actionContext: Parameters<typeof createTranscriptActions>[0] = {};
    const onFocusComposer = vi.fn();
    const actionProps = threadProps(pane.presentationId, state.sessionKey, state.chatMessages, {
      toolMessages: state.chatToolMessages,
      onFocusComposer,
    });
    const actions = createTranscriptActions(actionContext, actionProps).actions;
    const catalog = Reflect.get(pane, "attachmentCatalog") as PaneAttachmentCatalog;
    const chatProps = {
      paneId: pane.presentationId,
      sessionKey: state.sessionKey,
      connectionEpoch: state.connectionEpoch,
    } as ChatProps;
    const catalogInput = {
      state,
      selectedSession: undefined,
      currentAgentId: "main",
      chatProps,
      paneChatProps: chatProps,
      gateway: pane.context.gateway,
      presentation: "desktop" as const,
      workspacePresented: true,
      sessionWorkspace: createPaneHeaderWorkspaceFixture(state),
    };
    expect(catalog.read(catalogInput)?.entries.length).toBeGreaterThan(0);
    catalog.read({ ...catalogInput, workspacePresented: false });
    return { control: new WeakRef({ unowned: true }), actionContext, actions, onFocusComposer };
  };
  const { control, actionContext, actions, onFocusComposer } = populateDormantOwners();
  await collectGarbageForTest();
  expect(isAlive(control)).toBe(false);
  expect(isAlive(retired!.content)).toBe(true);
  expect(isAlive(pinned!.media)).toBe(true);

  await olderPages(pane, 6);
  const run = getChatSessionProjection(state).runs["settled"]!;
  expect(run.message).toBeUndefined();
  expect(JSON.stringify(run).length).toBeLessThan(1_000);
  await collectGarbageForTest();
  expect(isAlive(retired!.message)).toBe(false);
  expect(isAlive(retired!.content)).toBe(false);
  expect(isAlive(retired!.media)).toBe(false);
  expect(isAlive(pinned!.message)).toBe(true);
  expect(isAlive(pinned!.content)).toBe(true);
  expect(isAlive(pinned!.media)).toBe(true);
  expect(state.currentSessionId).toBe("resident-session");
  expect(state.chatHistoryPagination.hasNewer).toBe(true);
  expect(pane.state).toBe(state);
  expect(actionContext.actions?.onFocusComposer).toBe(onFocusComposer);
  actions.onFocusComposer?.();
  expect(onFocusComposer).toHaveBeenCalledOnce();
});

it.each(["plain", "bundle"] as const)(
  "releases a retired %s neighbor while the first turn and bundle owner stays pinned",
  async (kind) => {
    let retired:
      | { message: WeakRef<object>; content: WeakRef<object>; media: WeakRef<object> }
      | undefined;
    let pinned: WeakRef<object> | undefined;
    const { pane, state } = residentPane((messages) => {
      const first = messages.find((message) => nativeHistorySeq(message) === 601);
      const next = messages.find((message) => nativeHistorySeq(message) === 602);
      if (!first || !next) {
        return;
      }
      const media = {
        type: "image",
        source: { type: "base64", mediaType: "image/png", data: "c3ludGhldGlj" },
      };
      const content =
        kind === "bundle"
          ? [
              { type: "tool_result", id: "call", name: "read", text: "result ".repeat(10_000) },
              media,
            ]
          : [{ type: "text", text: "neighbor ".repeat(10_000) }, media];
      Object.assign(first, {
        role: "assistant",
        content:
          kind === "bundle"
            ? [{ type: "tool_call", id: "call", name: "read", arguments: {} }]
            : "first owner",
        __openclaw: { id: "source-601", seq: 601, runId: "error-pin" },
      });
      Object.assign(next, {
        role: kind === "bundle" ? "toolResult" : "assistant",
        content,
        __openclaw: { id: "source-602", seq: 602 },
      });
      pinned = new WeakRef(first);
      retired = {
        message: new WeakRef(next),
        content: new WeakRef(content),
        media: new WeakRef(media),
      };
    });
    await loadChatHistory(state, { deferBranches: true });
    const prime = () => {
      reduceChatSessionProjection(state, {
        type: "runTerminal",
        runId: "error-pin",
        status: "error",
        message: state.chatMessages.find((message) => nativeHistorySeq(message) === 601),
      });
      const props = createProps({
        paneId: pane.paneId,
        sessionKey: state.sessionKey,
        messages: state.chatMessages,
      });
      buildCachedChatItems(props, "visible");
      buildCachedChatItems(props, "unfiltered");
      return new WeakRef({ unowned: true });
    };
    const control = prime();
    await collectGarbageForTest();
    expect(isAlive(control)).toBe(false);
    expect(isAlive(retired!.media)).toBe(true);
    await olderPages(pane, 6);
    await collectGarbageForTest();
    expect(isAlive(retired!.message)).toBe(false);
    expect(isAlive(retired!.content)).toBe(false);
    expect(isAlive(retired!.media)).toBe(false);
    expect(isAlive(pinned!)).toBe(true);
    expect(state.chatMessages.some((message) => nativeHistorySeq(message) === 601)).toBe(true);
    expect(pane.state).toBe(state);
  },
);
