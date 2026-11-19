// @vitest-environment node
import { createSessionProjection } from "@openclaw/gateway-client/browser";
import { expect, it } from "vitest";
import { nativeHistoryMessageSourceIdentity } from "../../lib/chat/history-message-identity.ts";
import { collectGarbageForTest } from "../../test-helpers/garbage-collection.ts";
import { extendChatHistoryWindow, reconcileHistoryTail } from "./chat-history-page-preparation.ts";
import type { ChatHistoryPagination } from "./chat-history-pagination.ts";
import { chatHistoryPageSelector } from "./chat-history-request.ts";
import { prepareChatHistoryPacket } from "./chat-history-window.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import {
  admitChatHistoryPages,
  reopenChatHistoryBoundary,
} from "./chat-pane-history-packets.runtime.ts";
import { getChatSessionProjection, publishChatSessionProjection } from "./history-merge.ts";

const row = (seq: number) => ({
  role: "assistant",
  content: [{ type: "text", text: `body-${seq}` }],
  __openclaw: { seq },
});

const durable = (seq: number) => ({
  role: "user",
  content: `source-${seq}`,
  __openclaw: { id: `source-${seq}`, seq },
});

async function seedPackets(direction: "older" | "newer") {
  const readerRows = Array.from({ length: 401 }, (_, index) => ({
    role: "assistant",
    content: [{ type: "text", text: `fragment-${index}` }],
    __openclaw: { seq: index < 200 ? 100 : 101 },
  }));
  const readerPacket = prepareChatHistoryPacket(
    readerRows,
    { hasMore: true, olderCursor: "opaque-before-reader" },
    "opaque-after-reader",
  );
  const neighbors = Array.from({ length: 6 }, (_, index) =>
    row(direction === "older" ? index + 94 : index + 102),
  );
  const discarded = {
    ...row(direction === "older" ? 200 : 1),
    __openclaw: {
      seq: direction === "older" ? 200 : 1,
      media: [{ url: "media://inbound/discard.png", kind: "image" }],
    },
  };
  const neighborPackets = neighbors.map((message) =>
    prepareChatHistoryPacket([message], { hasMore: true }),
  );
  const discardedPacket = prepareChatHistoryPacket([discarded], { hasMore: true });
  const host = makeChatHost({
    readTranscriptReaderSnapshot: () => ({
      anchor: "seq:100",
      visibleSources: ["seq:100", "seq:101"],
    }),
  });
  getChatSessionProjection(host);
  host.chatHistoryPagination = {
    hasMore: true,
    olderCursor: "opaque-oldest",
    hasNewer: true,
    newerCursor: "opaque-newest",
    segments:
      direction === "older"
        ? [...neighborPackets, readerPacket, discardedPacket]
        : [discardedPacket, readerPacket, ...neighborPackets],
  };
  const messages =
    direction === "older"
      ? [...neighbors, ...readerRows, discarded]
      : [discarded, ...readerRows, ...neighbors];
  publishChatSessionProjection(
    host,
    createSessionProjection({ sessionKey: host.sessionKey }, messages),
  );
  // Only the real owner and weak probes leave this frame; the fixture must not
  // keep the retired message, its body, or its media alive across collection.
  return {
    host,
    readerPacket,
    reader: new WeakRef(readerRows[0]!),
    discardedSource: nativeHistoryMessageSourceIdentity(discarded),
    discarded: new WeakRef(discarded),
    content: new WeakRef(discarded.content),
    media: new WeakRef(discarded["__openclaw"].media[0]!),
    control: new WeakRef({ unowned: true }),
  };
}

it.each(["older", "newer"] as const)(
  "collects the far-end packet after %s admission while preserving reader custody",
  async (direction) => {
    const probes = await seedPackets(direction);
    const { host, readerPacket, discardedSource } = probes;
    const retired: (string | null)[] = [];
    host.transcriptMessagesRetired = (messages) => {
      retired.push(...messages.map(nativeHistoryMessageSourceIdentity));
    };
    expect(host.chatHistoryPagination.segments).toHaveLength(8);
    expect(host.chatMessages).toHaveLength(408);
    await collectGarbageForTest();
    expect(probes.control.deref()).toBeUndefined();
    expect(probes.discarded.deref()).toBeDefined();
    expect(probes.content.deref()).toBeDefined();
    expect(probes.media.deref()).toBeDefined();
    expect(probes.reader.deref()).toBeDefined();

    const incoming = row(direction === "older" ? 93 : 108);
    const packet = prepareChatHistoryPacket([incoming], { hasMore: true });
    expect(
      admitChatHistoryPages(host, [{ messages: [incoming], packet, hasMore: true }], direction),
    ).toBe("messages");
    expect(retired).toEqual([discardedSource]);
    expect(host.chatHistoryPagination.segments).toHaveLength(8);
    expect(host.chatMessages.map(nativeHistoryMessageSourceIdentity)).not.toContain(
      discardedSource,
    );
    expect(
      getChatSessionProjection(host).messages.map(nativeHistoryMessageSourceIdentity),
    ).not.toContain(discardedSource);
    const assertReader = () => {
      const held = host.chatHistoryPagination.segments?.find((segment) =>
        segment.sources.includes("seq:100"),
      );
      expect(held?.sources).toBe(readerPacket.sources);
      expect(held).toMatchObject({
        boundedPacket: true,
        olderCursor: "opaque-before-reader",
        newerCursor: "opaque-after-reader",
      });
      const messages = host.chatMessages.filter((message) =>
        readerPacket.sources.includes(nativeHistoryMessageSourceIdentity(message) ?? ""),
      );
      expect(messages).toHaveLength(401);
      expect(messages[0]).toBe(probes.reader.deref());
    };
    assertReader();

    await collectGarbageForTest();
    expect(probes.discarded.deref()).toBeUndefined();
    expect(probes.content.deref()).toBeUndefined();
    expect(probes.media.deref()).toBeUndefined();
    expect(probes.reader.deref()).toBeDefined();

    reopenChatHistoryBoundary(
      host,
      direction === "older" ? "seq:101" : "seq:100",
      {
        hasMore: true,
        olderCursor: "reopened-before-reader",
        hasNewer: true,
        newerCursor: "reopened-after-reader",
      },
      direction === "older" ? "newer" : "older",
    );
    publishChatSessionProjection(host, getChatSessionProjection(host));
    assertReader();
    expect(retired).toEqual([discardedSource]);
    expect(host.chatMessages.map(nativeHistoryMessageSourceIdentity)).not.toContain(
      discardedSource,
    );
    expect(probes.discarded.deref()).toBeUndefined();
  },
);

it.each(["mixed", "separate", "unavailable"])(
  "reopens physical compaction coverage after %s packet removal",
  (layout) => {
    const positioned = (id: string, rawSeq: number) => ({
      role: "assistant",
      content: id,
      __openclaw: { id, seq: rawSeq, transcriptPosition: { source: "history", rawSeq } },
    });
    // Relocated activity can precede an older physical row. A sequence-only
    // row cannot prove changed-leaf ancestry, even in the same held packet.
    const future = positioned("future", 5);
    const first = positioned("first", 1);
    const shared = positioned("shared", 2);
    const sequenceOnly = { role: "assistant", content: "unanchored", __openclaw: { seq: 4 } };
    const previousMessages = [future, first, shared, sequenceOnly];
    const firstPacket = prepareChatHistoryPacket(
      layout === "mixed" ? [future, first, sequenceOnly] : [first],
      { hasMore: true, olderCursor: "first-older" },
      "first-newer",
    );
    const sharedPacket = prepareChatHistoryPacket([shared], { hasMore: true });
    const previousPagination: ChatHistoryPagination = {
      hasMore: true,
      olderCursor: layout === "unavailable" ? undefined : "removed-older",
      needsBoundary: layout === "mixed" ? true : undefined,
      nextOffset: 5,
      totalMessages: 5,
      segments:
        layout === "mixed"
          ? [firstPacket, sharedPacket]
          : [
              prepareChatHistoryPacket([future], { hasMore: true, olderCursor: "removed-older" }),
              firstPacket,
              sharedPacket,
              prepareChatHistoryPacket([sequenceOnly], { hasMore: true }),
            ],
    };
    const next = positioned("next", 6);
    const nextMessages = [shared, next];
    const nextPagination: ChatHistoryPagination = {
      hasMore: true,
      olderCursor: "older-fresh",
      nextOffset: 5,
      totalMessages: 6,
    };
    const result = reconcileHistoryTail({
      sameLeaf: false,
      previousMessages,
      previousPagination,
      previousSessionId: "session",
      nextMessages,
      nextPagination,
      nextSessionId: "session",
    })!;
    expect(result.messages).toEqual([first, shared, next]);
    expect(result.messages[0]).toBe(first);
    expect(result.retainedCoverage).toBe(true);
    expect(result.pagination.segments?.flatMap((packet) => packet.sources)).toEqual([
      "id:first",
      "id:shared",
    ]);
    expect(result.pagination.segments?.[1]).toBe(sharedPacket);
    expect(result.pagination).not.toHaveProperty("nextOffset");
    if (layout === "mixed") {
      expect(result.pagination.segments?.[0]).toMatchObject({
        boundedPacket: undefined,
        olderCursor: undefined,
        newerCursor: undefined,
        hasOlder: true,
        hasNewer: true,
      });
    } else {
      expect(result.pagination.segments?.[0]).toBe(firstPacket);
    }
    const host = makeChatHost({ currentSessionId: "session" });
    getChatSessionProjection(host);
    host.chatHistoryPagination = extendChatHistoryWindow(
      previousPagination,
      previousMessages,
      nextMessages,
      nextPagination,
      undefined,
      "tail",
      result.pagination,
    );
    publishChatSessionProjection(
      host,
      createSessionProjection({ sessionKey: host.sessionKey }, result.messages),
    );
    const sources = new Set(host.chatMessages.map(nativeHistoryMessageSourceIdentity));
    expect(
      host.chatHistoryPagination.segments?.every((packet) =>
        packet.sources.every((source) => sources.has(source)),
      ),
    ).toBe(true);
    expect(chatHistoryPageSelector(host, "older")).toEqual(
      layout === "mixed"
        ? { messageId: "first", sessionId: "session", limit: 1 }
        : { cursor: "first-older" },
    );
    if (layout === "mixed") {
      reopenChatHistoryBoundary(host, "id:first", {
        hasMore: true,
        olderCursor: "reopened-first",
      });
      expect(chatHistoryPageSelector(host, "older")).toEqual({ cursor: "reopened-first" });
    }
    const older = positioned("older", 0);
    expect(
      admitChatHistoryPages(
        host,
        [
          {
            messages: [older],
            hasMore: false,
            packet: prepareChatHistoryPacket([older], { hasMore: false }),
          },
        ],
        "older",
      ),
    ).toBe("messages");
    expect(host.chatMessages).toEqual([older, first, shared, next]);
  },
);

it.each([true, false])("keeps detached history only on the same leaf: %s", (sameLeaf) => {
  const previousMessages = [durable(1), durable(2)];
  const previousPagination: ChatHistoryPagination = {
    hasMore: false,
    hasNewer: true,
    newerCursor: "newer-held",
  };
  const result = reconcileHistoryTail({
    sameLeaf,
    previousMessages,
    previousPagination,
    previousSessionId: "session",
    nextMessages: [durable(8)],
    nextPagination: { hasMore: true, olderCursor: "older-fresh" },
    nextSessionId: "session",
  });
  if (sameLeaf) {
    expect(result?.messages).toBe(previousMessages);
    expect(result?.pagination).toBe(previousPagination);
  } else {
    expect(result).toBeNull();
  }
});
