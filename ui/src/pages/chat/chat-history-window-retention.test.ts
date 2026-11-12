// @vitest-environment node
import { createSessionProjection } from "@openclaw/gateway-client/browser";
import { expect, it } from "vitest";
import { nativeHistoryMessageSourceIdentity } from "../../lib/chat/history-message-identity.ts";
import { collectGarbageForTest } from "../../test-helpers/garbage-collection.ts";
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
