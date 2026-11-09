import { createSessionProjection, reduceSessionProjection } from "@openclaw/gateway-client/browser";
import { expect, it } from "vitest";
import { t } from "../../i18n/index.ts";
import { nativeHistoryMessageSourceIdentity } from "../../lib/chat/history-message-identity.ts";
import { visibleChatHistoryMessages } from "../../lib/chat/message-visibility.ts";
import { readPairingQrContent } from "../../lib/chat/pairing-qr.ts";
import { prepareChatHistoryPages } from "./chat-history-page-preparation.ts";
import type { ChatHistoryPagination } from "./chat-history-pagination.ts";
import { resolveChatHistoryPagination } from "./chat-history-snapshot.ts";
import {
  extendChatHistoryWindow,
  prepareChatHistorySegment,
  prepareChatHistoryPacket,
  projectResidentChatHistory,
  selectChatHistoryResidency,
  boundChatLocalOutput,
} from "./chat-history-window.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import {
  admitChatHistoryPages,
  reopenChatHistoryBoundary,
} from "./chat-pane-history-packets.runtime.ts";
import {
  getChatSessionProjection,
  publishChatSessionProjection,
  reduceChatSessionProjection,
} from "./history-merge.ts";

const CHAT_RESIDENT_WEIGHT_TARGET = 3 * 1024 * 1024;

function packetPage(messages: unknown[], olderCursor: string, newerCursor: string) {
  const pagination = { hasMore: true as const, olderCursor };
  return {
    messages,
    ...pagination,
    newerCursor,
    packet: prepareChatHistoryPacket(messages, pagination, newerCursor),
  };
}

it("revokes around packet provenance when canonical pairing media enriches its body", () => {
  const host = makeChatHost();
  const plain = {
    role: "assistant",
    content: [{ type: "text", text: "pairing" }],
    __openclaw: { id: "pairing", seq: 1 },
  };
  const qr = { type: "openclaw_pairing_qr", image_url: "data:image/png;base64,aQ==" };
  const live = { ...plain, content: [...plain.content, qr] };
  admitChatHistoryPages(host, [{ messages: [live] }], "around");
  const packet = prepareChatHistoryPacket([plain], { hasMore: false });
  expect(packet.boundedPacket).toBe(true);
  const result = { messages: [plain], packet };
  const prepared = prepareChatHistoryPages(host, [result], "around");
  expect(prepared.fits).toBe(true);
  expect(readPairingQrContent(prepared.messages[0])).toEqual([qr]);
  expect(prepared.pagination.segments?.[0]?.boundedPacket).toBeUndefined();
  expect(admitChatHistoryPages(host, [result], "around")).toBe("messages");
  expect(readPairingQrContent(host.chatMessages[0])).toEqual([qr]);
  expect(host.chatHistoryPagination.segments?.[0]?.boundedPacket).toBeUndefined();
});

it.each(["local", "pin"] as const)(
  "rechecks charged viewport fit after a %s body arrives before admission",
  (arrival) => {
    const host = makeChatHost();
    const held = [499, 500].map((seq) =>
      Object.assign(durable(seq), { content: "x".repeat(4_000) }),
    );
    admitChatHistoryPages(
      host,
      [{ messages: held, hasMore: true, olderCursor: "older-498", newerCursor: "newer-501" }],
      "around",
    );
    host.readTranscriptReaderSnapshot = () => ({
      anchor: "id:source-499",
      visibleSources: ["id:source-499", "id:source-500"],
    });
    const result = {
      messages: [{ ...durable(498), content: "y".repeat(80 * 1024) }],
      hasMore: true,
      olderCursor: "older-497",
    };
    expect(prepareChatHistoryPages(host, [result], "older").fits).toBe(true);
    const message = {
      role: arrival === "local" ? "system" : "assistant",
      content: "z".repeat(CHAT_RESIDENT_WEIGHT_TARGET - 64 * 1024),
      ...(arrival === "pin" ? { __openclaw: { id: "source-501", seq: 501, runId: "pin" } } : {}),
    };
    if (arrival === "local") {
      reduceChatSessionProjection(host, { type: "localOutput", message });
    } else {
      reduceChatSessionProjection(host, { type: "runDelta", runId: "pin", message });
      reduceChatSessionProjection(host, { type: "messagePersisted", message });
    }
    expect(host.chatMessages).toContain(message);
    const before = host.chatMessages;
    const coverage = host.chatHistoryPagination;
    expect(prepareChatHistoryPages(host, [result], "older").fits).toBe(false);
    expect(admitChatHistoryPages(host, [result], "older")).toBe(false);
    expect(host.chatMessages).toBe(before);
    expect(host.chatHistoryPagination).toBe(coverage);
    expect(host.chatMessages).toEqual([...held, message]);
  },
);

it("keeps an indivisible source group above the entry target", () => {
  const messages = Array.from({ length: 401 }, (_, index) => ({
    role: "assistant",
    content: `fragment-${index}`,
    __openclaw: { id: "source", seq: 1 },
  }));
  const pagination = { hasMore: false as const };
  const admitted = selectChatHistoryResidency(messages, {
    ...pagination,
    segments: [prepareChatHistorySegment(messages, pagination)],
  });
  expect(admitted.messages).toEqual(messages);
  expect(admitted.pagination.hasMore).toBe(false);
  expect(admitted.pagination.hasNewer).toBeUndefined();
});

it("charges neighboring groups inside the protected reader segment to the weight target", () => {
  const messages = [1, 2].map((seq) => ({
    role: "assistant",
    content: "x".repeat(2 * 1024 * 1024),
    __openclaw: { id: `source-${seq}`, seq },
  }));
  const pagination = { hasMore: false as const };
  const segment = prepareChatHistorySegment(messages, pagination);
  const held = selectChatHistoryResidency(
    messages,
    { ...pagination, segments: [segment] },
    "tail",
    nativeHistoryMessageSourceIdentity(messages[0]),
  );
  expect(held.messages).toEqual([messages[0]]);
  expect(held.pagination).toMatchObject({
    hasMore: false,
    hasNewer: true,
    needsNewerBoundary: true,
  });
  const released = selectChatHistoryResidency(held.messages, held.pagination);
  expect(released.messages).toEqual(held.messages);
});

const durable = (seq: number) => ({
  role: "user",
  content: `source-${seq}`,
  __openclaw: { id: `source-${seq}`, seq },
});

it("rejects around coverage that cannot coexist with the newest charged local output", () => {
  const host = makeChatHost();
  const held = durable(1);
  admitChatHistoryPages(host, [{ messages: [held] }], "around");
  const output = { role: "system", content: "x".repeat(CHAT_RESIDENT_WEIGHT_TARGET - 128 * 1024) };
  reduceChatSessionProjection(host, { type: "localOutput", message: output });
  const before = host.chatMessages;
  const coverage = host.chatHistoryPagination;
  const messages = [2, 3].map((seq) =>
    Object.assign(durable(seq), { content: "y".repeat(80 * 1024) }),
  );
  const packet = prepareChatHistoryPacket(messages, { hasMore: false });
  expect(packet.boundedPacket).toBe(true);
  const result = { messages, packet };

  expect(prepareChatHistoryPages(host, [result], "around").fits).toBe(false);
  expect(() => admitChatHistoryPages(host, [result], "around")).toThrow(
    t("chat.thread.historyCapacity"),
  );
  expect(host.chatMessages).toBe(before);
  expect(host.chatMessages).toEqual([held, output]);
  expect(host.chatHistoryPagination).toBe(coverage);
});

it.each(["count", "weight"] as const)(
  "retains only the final atomic source beside charged local output under %s pressure",
  (pressure) => {
    const messages = Array.from({ length: pressure === "count" ? 400 : 1 }, (_, fragment) => ({
      ...durable(1),
      content: `fragment-${fragment}`,
    }));
    const output = boundChatLocalOutput({
      role: "system",
      content: pressure === "weight" ? "x".repeat(CHAT_RESIDENT_WEIGHT_TARGET) : "command result",
    });
    const pagination = { hasMore: false as const };
    const result = selectChatHistoryResidency(
      [...messages, output],
      { ...pagination, segments: [prepareChatHistorySegment(messages, pagination)] },
      "tail",
      undefined,
      [output],
    );
    expect(result.withinBudget).toBe(true);
    expect(result.messages).toEqual([...messages, output]);
    expect(result.pagination.intrinsicSource).toBeUndefined();
    expect(result.pagination.segments?.[0]?.sources).toEqual(["id:source-1"]);
  },
);

it.each(["sole source", "keyed reader", "unkeyed reader packet"] as const)(
  "does not lend the %s pair's unavoidable capacity to older local outcomes",
  (owner) => {
    const messages = Array.from({ length: 400 }, (_, fragment) => ({
      role: "assistant",
      content: `fragment-${fragment}`,
      __openclaw:
        owner === "unkeyed reader packet"
          ? { seq: fragment < 200 ? 1 : 2 }
          : { id: "source-1", seq: 1 },
    }));
    const outputs = Array.from({ length: 400 }, (_, index) => ({
      role: "system",
      content: `command-${index}`,
    }));
    const pagination = { hasMore: false as const };
    const packet = prepareChatHistoryPacket(messages, pagination);
    expect(packet.boundedPacket).toBe(true);
    const result = selectChatHistoryResidency(
      [...messages, ...outputs],
      { ...pagination, segments: [packet] },
      "tail",
      owner === "sole source" ? undefined : owner === "keyed reader" ? "id:source-1" : "seq:1",
      outputs,
    );
    expect(result.withinBudget).toBe(true);
    expect(result.messages).toEqual([...messages, outputs.at(-1)]);
    expect(result.pagination.segments?.[0]?.sources).toEqual(packet.sources);
    expect(result.pagination.intrinsicSource).toBeUndefined();
  },
);

it("clips escaped and multibyte local output at the existing serialized weight target", () => {
  const content = '\\"\n😀'.repeat(700_000);
  const output = boundChatLocalOutput({ role: "system", content, timestamp: 1 });
  expect(output.content.endsWith("…")).toBe(true);
  expect(output.content.isWellFormed()).toBe(true);
  expect(JSON.stringify([output]).length).toBeLessThanOrEqual(CHAT_RESIDENT_WEIGHT_TARGET);
  expect(boundChatLocalOutput({ content: "ordinary result" }).content).toBe("ordinary result");
});

it("keeps only the actual indivisible reader source beside charged local output", () => {
  const reader = {
    ...durable(1),
    content: "r".repeat(2 * 1024 * 1024),
    __openclaw: { id: "reader", seq: 1 },
  };
  const neighbor = durable(2);
  const olderOutput = { role: "system", content: "o".repeat(2 * 1024 * 1024) };
  const output = { role: "system", content: "l".repeat(2 * 1024 * 1024) };
  const pagination = {
    hasMore: true as const,
    olderCursor: "older",
    hasNewer: true as const,
    newerCursor: "newer",
  };
  const packet = prepareChatHistorySegment([reader, neighbor], pagination, "newer");
  const admitted = selectChatHistoryResidency(
    [reader, neighbor, olderOutput, output],
    { ...pagination, segments: [packet] },
    "tail",
    "id:reader",
    [olderOutput, output],
  );
  expect(admitted.messages).toEqual([reader, neighbor, output]);
  expect(admitted.withinBudget).toBe(true);
  expect(admitted.pagination.intrinsicSource).toBeUndefined();
  expect(admitted.pagination.segments?.[0]?.sources).toEqual(["id:reader", "id:source-2"]);
  const moved = selectChatHistoryResidency(
    admitted.messages,
    admitted.pagination,
    "tail",
    "id:source-2",
    [output],
  );
  expect(moved.messages).toEqual([neighbor, output]);
  expect(moved.pagination).toMatchObject({ needsBoundary: true });
});

it("keeps only the original bounded unkeyed reader packet beside local output", () => {
  const messages = Array.from({ length: 400 }, (_, index) => ({
    role: "assistant",
    content: `fragment-${index}`,
    __openclaw: { seq: index < 200 ? 1 : 2 },
  }));
  const pagination = { hasMore: true as const, olderCursor: "opaque-before" };
  const packet = prepareChatHistoryPacket(messages, pagination, "opaque-after");
  expect(packet.boundedPacket).toBe(true);
  const output = { role: "system", content: "local result" };
  const admitted = selectChatHistoryResidency(
    [...messages, output],
    { ...pagination, hasNewer: true, newerCursor: "opaque-after", segments: [packet] },
    "tail",
    "seq:2",
    [output],
  );
  expect(admitted.messages).toEqual([...messages, output]);
  expect(admitted.withinBudget).toBe(true);
  expect(admitted.pagination).toMatchObject({
    olderCursor: "opaque-before",
    newerCursor: "opaque-after",
  });
  expect(admitted.pagination.segments).toEqual([packet]);
  const next = durable(3);
  const moved = selectChatHistoryResidency(
    [...admitted.messages, next],
    {
      ...admitted.pagination,
      segments: [packet, prepareChatHistorySegment([next], { hasMore: true })],
    },
    "newer",
    "id:source-3",
    [output],
  );
  expect(moved.messages).toEqual([output, next]);
  expect(moved.pagination.segments).toHaveLength(1);
});

it("charges ordinary neighbors independently of an admitted intrinsic source group", () => {
  const fragments = Array.from({ length: 401 }, (_, index) => ({
    ...durable(1),
    content: `fragment-${index}`,
  }));
  const state = { chatMessages: [], chatHistoryPagination: { hasMore: false as const } };
  expect(prepareChatHistoryPages(state, [{ messages: fragments }], "older").fits).toBe(true);
  expect(
    prepareChatHistoryPages(state, [{ messages: [...fragments, durable(2)] }], "older").fits,
  ).toBe(true);
});

it.each([
  { older: false, newer: false, expected: [1, 2, 3, 4, 5] },
  { older: true, newer: false, expected: [2, 3, 4, 5] },
  { older: false, newer: true, expected: [1, 2, 3, 4] },
  { older: true, newer: true, expected: [2, 3, 4] },
])(
  "admits live receipts inside certified coverage (older=$older newer=$newer)",
  ({ older, newer, expected }) => {
    const messages = [1, 2, 3, 4, 5].map(durable);
    const held = [messages[1], messages[3]];
    let projection = createSessionProjection({}, held);
    for (const message of [messages[0], messages[2], messages[4]]) {
      projection = reduceSessionProjection(projection, { type: "messagePersisted", message });
    }
    const pagination = older
      ? { hasMore: true as const, olderCursor: "older" }
      : { hasMore: false as const };
    const segment = prepareChatHistorySegment(held, pagination, newer ? "newer" : undefined);
    const admitted = projectResidentChatHistory(
      projection,
      {
        ...pagination,
        ...(newer ? { hasNewer: true as const, newerCursor: "newer" } : {}),
        segments: [segment],
      },
      null,
    );
    expect(admitted.projection.messages).toEqual(expected.map((seq) => messages[seq - 1]));
    expect(admitted.pagination.segments?.flatMap((page) => page.sources)).toEqual(
      expected.map((seq) => `id:source-${seq}`),
    );
    expect(admitted.pagination.hasMore).toBe(older);
    expect(admitted.pagination.hasNewer).toBe(newer || undefined);
  },
);

it("keeps a long stale-snapshot receipt prefix bounded instead of pinning every live row", () => {
  const messages = Array.from({ length: 560 }, (_, index) => durable(index + 1));
  let projection = createSessionProjection({}, messages.slice(-1));
  for (const message of messages.slice(0, -1)) {
    projection = reduceSessionProjection(projection, { type: "messagePersisted", message });
  }
  const pagination = { hasMore: false as const };
  const admitted = projectResidentChatHistory(
    projection,
    {
      ...pagination,
      segments: [prepareChatHistorySegment(messages.slice(-1), pagination)],
    },
    null,
  );
  expect(admitted.projection.messages).toEqual(messages.slice(-400));
  expect(admitted.projection.messages.at(-1)).toBe(messages.at(-1));
  expect(admitted.pagination.hasMore).toBe(true);
});

it.each([false, true])(
  "admits live receipts after an empty visible tail unless detached (newer=%s)",
  (newer) => {
    const message = durable(1);
    const projection = reduceSessionProjection(createSessionProjection(), {
      type: "messagePersisted",
      message,
    });
    const pagination = { hasMore: true as const, olderCursor: "hidden-older" };
    const admitted = projectResidentChatHistory(
      projection,
      {
        ...pagination,
        ...(newer ? { hasNewer: true as const } : {}),
        segments: [prepareChatHistorySegment([], pagination, newer ? "hidden-newer" : undefined)],
      },
      null,
    );
    expect(admitted.projection.messages).toEqual(newer ? [] : [message]);
    expect(admitted.pagination.hasMore).toBe(true);
  },
);

it("repartitions live source groups once without splitting fragments or changing repeated publication", () => {
  const messages = Array.from({ length: 50 }, (_, index) =>
    ["a", "b"].map((part) => ({
      role: "assistant",
      content: index === 19 ? "x".repeat(140 * 1024) : `${index + 1}-${part}`,
      __openclaw: { id: `source-${index + 1}`, seq: index + 1 },
      openclawStreamFallback: { itemId: `fragment-${index + 1}-${part}` },
    })),
  );
  const held = messages.at(-1)!;
  let projection = createSessionProjection({}, held);
  for (const group of messages.slice(0, -1)) {
    for (const message of group) {
      projection = reduceSessionProjection(projection, { type: "messagePersisted", message });
    }
  }
  const pagination = { hasMore: false as const };
  const admitted = projectResidentChatHistory(
    projection,
    { ...pagination, segments: [prepareChatHistorySegment(held, pagination)] },
    null,
  );
  expect(admitted.projection.messages).toEqual(messages.flat());
  expect(admitted.pagination.segments?.map((segment) => segment.sources.length)).toEqual([
    19, 1, 30,
  ]);
  expect(admitted.pagination.segments?.[1]?.sources).toEqual(["id:source-20"]);
  const repeated = projectResidentChatHistory(admitted.projection, admitted.pagination, null);
  expect(repeated.projection).toBe(admitted.projection);
  expect(repeated.pagination).toEqual(admitted.pagination);
  expect(repeated.pagination.segments).toEqual(admitted.pagination.segments);
});

it("retires an interior live alias with its authoritative page instead of leaving an isolated source", () => {
  const messages = [1, 2, 3].map(durable);
  const pagination = { hasMore: true as const, olderCursor: "raw-hidden-older" };
  const live = reduceSessionProjection(createSessionProjection(), {
    type: "messagePersisted",
    message: messages[1],
  });
  const initial = projectResidentChatHistory(
    live,
    { ...pagination, segments: [prepareChatHistorySegment([], pagination)] },
    null,
  );
  const coverage = extendChatHistoryWindow(
    initial.pagination,
    initial.projection.messages,
    messages,
    { hasMore: false },
    "after-source-3",
    "older",
  );
  let resident = projectResidentChatHistory(createSessionProjection({}, messages), coverage, null);
  const later = Array.from({ length: 398 }, (_, index) => durable(index + 4));
  let projection = resident.projection;
  for (const message of later) {
    projection = reduceSessionProjection(projection, { type: "messagePersisted", message });
  }
  resident = projectResidentChatHistory(projection, resident.pagination, null);
  expect(resident.projection.messages).toEqual(later.slice(77));
  expect(resident.pagination).toMatchObject({ hasMore: true });
  expect(resident.pagination.hasNewer).toBeUndefined();
  const repeated = projectResidentChatHistory(resident.projection, resident.pagination, null);
  expect(repeated.projection).toBe(resident.projection);
  expect(repeated.pagination).toEqual(resident.pagination);
});

it.each(["older", "newer"] as const)(
  "preserves ordinary overlapping segment membership while extending %s",
  (direction) => {
    const messages = [1, 2, 3].map(durable);
    const held = direction === "older" ? messages.slice(1) : messages.slice(0, 2);
    const incoming = direction === "older" ? messages.slice(0, 2) : messages.slice(1);
    const pagination = { hasMore: true as const, olderCursor: "held-older" };
    const segment = prepareChatHistorySegment(held, pagination, "held-newer");
    const extended = extendChatHistoryWindow(
      { ...pagination, hasNewer: true as const, newerCursor: "held-newer", segments: [segment] },
      held,
      incoming,
      pagination,
      "page-newer",
      direction,
    );
    expect(extended.segments?.[direction === "older" ? 1 : 0]).toBe(segment);
    expect(segment.sources).toEqual(held.map(nativeHistoryMessageSourceIdentity));
  },
);

it("records one admitted intrinsic source and releases the old reader exception after movement", () => {
  const giant = (seq: number) =>
    Array.from({ length: 401 }, (_, index) => ({
      ...durable(seq),
      content: `fragment-${index}`,
    }));
  const a = giant(3);
  const b = giant(2);
  const host = makeChatHost();
  let reader: string | null = "id:source-3";
  host.readTranscriptReaderSnapshot = () => ({
    anchor: reader,
    visibleSources: reader ? [reader] : [],
  });
  admitChatHistoryPages(host, [{ messages: a, hasMore: true, olderCursor: "older-2" }], "around");
  expect(
    admitChatHistoryPages(
      host,
      [{ messages: b, hasMore: true, olderCursor: "older-1", newerCursor: "newer-3" }],
      "older",
    ),
  ).toBe("messages");
  expect(host.chatMessages).toEqual([...b, ...a]);
  expect(host.chatHistoryPagination).toHaveProperty("intrinsicSource", "id:source-2");
  publishChatSessionProjection(host, getChatSessionProjection(host));
  expect(host.chatMessages).toEqual([...b, ...a]);
  reader = "id:source-2";
  publishChatSessionProjection(host, getChatSessionProjection(host));
  expect(host.chatMessages).toEqual(b);
  expect(
    admitChatHistoryPages(host, [{ messages: [durable(1)], newerCursor: "newer-2" }], "older"),
  ).toBe("messages");
  expect(host.chatMessages).toEqual([durable(1), ...b]);
  expect(host.chatHistoryPagination).toHaveProperty("intrinsicSource", "id:source-2");
  reader = null;
  admitChatHistoryPages(host, [{ messages: [durable(9)] }], "around");
  expect(host.chatHistoryPagination).not.toHaveProperty("intrinsicSource");
});

it("retires an old intrinsic group sharing the reader's single packet after reader movement", () => {
  const giant = (seq: number) =>
    Array.from({ length: 401 }, (_, index) => ({
      ...durable(seq),
      content: `fragment-${index}`,
    }));
  const a = giant(1);
  const b = giant(2);
  const host = makeChatHost();
  let reader = "id:source-1";
  host.readTranscriptReaderSnapshot = () => ({
    anchor: reader,
    visibleSources: reader ? [reader] : [],
  });
  admitChatHistoryPages(host, [{ messages: [...a, ...b] }], "around");
  expect(host.chatMessages).toEqual([...a, ...b]);
  reader = "id:source-2";
  publishChatSessionProjection(host, getChatSessionProjection(host));
  expect(host.chatMessages).toEqual(b);
  expect(host.chatHistoryPagination).toMatchObject({
    intrinsicSource: "id:source-2",
    hasMore: true,
    needsBoundary: true,
  });
});

it("certifies only bounded wire packets and invalidates provenance on live membership changes", () => {
  const messages = [1, 2].map(durable);
  const pagination = { hasMore: false as const };
  const admitted = extendChatHistoryWindow(
    pagination,
    [],
    messages,
    pagination,
    undefined,
    "tail",
    undefined,
    prepareChatHistoryPacket(messages, pagination),
  );
  expect(admitted.segments?.[0]?.boundedPacket).toBe(true);
  expect(prepareChatHistorySegment(messages, pagination).boundedPacket).toBeUndefined();
  for (const incoming of [
    Array.from({ length: 81 }, (_unused, index) => durable(index + 1)),
    [{ ...durable(1), content: "x".repeat(256 * 1024) }],
    [{ ...durable(1), content: "界".repeat(90 * 1024) }],
  ]) {
    expect(prepareChatHistoryPacket(incoming, pagination).boundedPacket).toBeUndefined();
  }
  const projection = reduceSessionProjection(createSessionProjection({}, messages), {
    type: "messagePersisted",
    message: durable(3),
  });
  const extended = projectResidentChatHistory(projection, admitted, null);
  expect(extended.projection.messages).toEqual([...messages, durable(3)]);
  expect(extended.pagination.segments?.every((segment) => !segment.boundedPacket)).toBe(true);
});

it.each(["append", "replace"] as const)(
  "invalidates wire provenance after a same-source live %s",
  (operation) => {
    const first = {
      ...durable(1),
      role: "assistant",
      openclawStreamFallback: { source: "segment", itemId: "item-1", runId: "run-1" },
    };
    const messages = [first, durable(2)];
    const pagination = { hasMore: false as const };
    const packet = prepareChatHistoryPacket(messages, pagination);
    const admitted = { ...pagination, segments: [packet, { ...packet }] };
    expect(packet.boundedPacket).toBe(true);
    const incoming = {
      ...first,
      content: "updated-source-1",
      openclawStreamFallback: {
        ...first.openclawStreamFallback,
        itemId: operation === "append" ? "item-2" : "item-1",
      },
    };
    const projection = reduceSessionProjection(createSessionProjection({}, messages), {
      type: "messagePersisted",
      message: incoming,
    });
    expect(projection.messages).toHaveLength(operation === "append" ? 3 : 2);
    expect(projection.messages).toContain(incoming);
    expect(new Set(projection.messages.map(nativeHistoryMessageSourceIdentity))).toEqual(
      new Set(packet.sources),
    );
    expect(prepareChatHistoryPacket(projection.messages, pagination).boundedPacket).toBe(true);
    const updated = projectResidentChatHistory(projection, admitted, null);
    expect(updated.projection.messages).toEqual(projection.messages);
    expect(updated.pagination.segments?.[0]?.sources).toEqual(packet.sources);
    expect(updated.pagination.segments).toHaveLength(2);
    expect(updated.pagination.segments?.map((segment) => segment.boundedPacket)).toEqual([
      undefined,
      undefined,
    ]);
  },
);

it.each([
  { direction: "older", retainQr: false },
  { direction: "older", retainQr: true },
  { direction: "newer", retainQr: false },
  { direction: "newer", retainQr: true },
] as const)(
  "rechecks wire provenance after historical publication ($direction, pairing=$retainQr)",
  ({ direction, retainQr }) => {
    const owner = {
      sessionKey: "agent:main:pairing",
      chatMessages: [] as unknown[],
      chatHistoryPagination: resolveChatHistoryPagination(undefined),
      readTranscriptReaderSnapshot: () => ({ anchor: "seq:2", visibleSources: ["seq:2"] }),
    };
    const scope = { sessionKey: owner.sessionKey };
    const reply = {
      ...durable(3),
      role: "assistant",
      content: [{ type: "text", text: "Pairing details" }],
    };
    const qr = { type: "openclaw_pairing_qr", image_url: "data:image/png;base64,aQ==" };
    const initial = retainQr ? { ...reply, content: [...reply.content, qr] } : reply;
    publishChatSessionProjection(
      owner,
      reduceSessionProjection(createSessionProjection(scope), {
        type: "messagePersisted",
        message: initial,
      }),
    );
    const messages = [{ role: "assistant", content: "reader", __openclaw: { seq: 2 } }, reply];
    const pagination = {
      hasMore: true as const,
      olderCursor: "older-packet",
      hasNewer: true as const,
      newerCursor: "newer-packet",
    };
    const packet = prepareChatHistoryPacket(messages, pagination, pagination.newerCursor);
    owner.chatHistoryPagination = { ...pagination, segments: [packet] };
    publishChatSessionProjection(owner, createSessionProjection(scope, messages));
    expect(owner.chatMessages).toEqual([messages[0], retainQr ? initial : reply]);
    expect(
      getChatSessionProjection(owner).entries.every((entry) => !entry.live && !entry.pending),
    ).toBe(true);
    expect(owner.chatHistoryPagination.segments?.[0]).toEqual({
      ...packet,
      boundedPacket: retainQr ? undefined : true,
    });
    const incoming = direction === "older" ? [durable(1), ...messages] : [...messages, durable(4)];
    const nextPagination = { hasMore: false as const };
    const nextPacket = prepareChatHistoryPacket(incoming, nextPagination);
    const prepared = prepareChatHistoryPages(
      owner,
      [{ ...nextPagination, messages: incoming, packet: nextPacket }],
      direction,
    );
    expect(prepared.fits).toBe(true);
    const replies = prepared.messages.filter(
      (message) => nativeHistoryMessageSourceIdentity(message) === "id:source-3",
    );
    expect(replies).toHaveLength(retainQr ? 2 : 1);
    if (retainQr) {
      expect(replies).toContain(owner.chatMessages[1]);
      expect(replies).toEqual([initial, initial]);
      expect(replies.map(readPairingQrContent)).toEqual([[qr], [qr]]);
    } else {
      expect(replies).toEqual([reply]);
      expect(replies[0]).toBe(reply);
    }
    const incomingPacket =
      direction === "older"
        ? prepared.pagination.segments?.[0]
        : prepared.pagination.segments?.at(-1);
    expect(incomingPacket?.boundedPacket).toBe(retainQr ? undefined : true);
  },
);

it("keeps normal unkeyed reader packets charged to the ordinary target", () => {
  const packet = (start: number) =>
    Array.from({ length: 80 }, (_unused, index) => ({
      role: "assistant",
      content: "row",
      __openclaw: { seq: start + index },
    }));
  const messages: unknown[] = [];
  let pagination: ChatHistoryPagination = { hasMore: false };
  for (let start = 1; start <= 401; start += 80) {
    const incoming = packet(start);
    pagination = extendChatHistoryWindow(
      pagination,
      messages,
      incoming,
      { hasMore: false },
      undefined,
      "newer",
      undefined,
      prepareChatHistoryPacket(incoming, { hasMore: false }),
    );
    messages.push(...incoming);
  }
  const admitted = selectChatHistoryResidency(messages, pagination, "newer", "seq:401");
  expect(admitted.withinBudget).toBe(true);
  expect(admitted.messages).toHaveLength(400);
  expect(admitted.pagination.segments).toHaveLength(5);
  expect(admitted.messages[0]).toBe(messages[80]);
});

it("preserves local outcome placement when a newer page overlaps its preceding source", () => {
  const host = makeChatHost();
  const second = durable(2);
  const third = durable(3);
  admitChatHistoryPages(host, [{ messages: [second], newerCursor: "after-2" }], "around");
  const output = { role: "system", content: "Local command result", timestamp: 1 };
  reduceChatSessionProjection(host, { type: "localOutput", message: output });

  admitChatHistoryPages(host, [{ messages: [{ ...second }, third] }], "newer");

  expect(host.chatMessages).toEqual([second, output, third]);
  expect(host.chatMessages[1]).toBe(output);
  expect(getChatSessionProjection(host).entries.filter((entry) => entry.localOutput)).toHaveLength(
    1,
  );
});

it.each([
  { retired: false, sequenceOnly: false, roleless: false },
  { retired: true, sequenceOnly: false, roleless: false },
  { retired: false, sequenceOnly: true, roleless: false },
  { retired: true, sequenceOnly: true, roleless: false },
  { retired: false, sequenceOnly: true, roleless: true },
  { retired: true, sequenceOnly: true, roleless: true },
])(
  "keeps local output at its recorded cut through older overlap $retired/$sequenceOnly/$roleless",
  ({ retired, sequenceOnly, roleless }) => {
    const row = (seq: number) =>
      sequenceOnly ? { role: "user", content: `source-${seq}`, __openclaw: { seq } } : durable(seq);
    const host = makeChatHost();
    const second = row(2);
    const fourth = row(4);
    admitChatHistoryPages(host, [{ messages: [second] }], "around");
    const output = { role: "system", content: "Local command result", timestamp: 1 };
    reduceChatSessionProjection(host, { type: "localOutput", message: output });
    if (retired) {
      admitChatHistoryPages(host, [{ messages: [fourth] }], "around");
    } else {
      reduceChatSessionProjection(host, { type: "messagePersisted", message: fourth });
    }
    expect(host.chatMessages).toEqual(retired ? [output, fourth] : [second, output, fourth]);
    const local = getChatSessionProjection(host).entries.find((entry) => entry.localOutput);
    expect(local).toMatchObject({ message: output, localOutput: true, afterSequence: 2 });
    const first = row(1);
    const third = roleless ? { type: "compaction", __openclaw: { seq: 3 } } : row(3);
    const incoming = [first, { ...second }, third, { ...fourth }];
    const packet = prepareChatHistoryPacket(incoming, { hasMore: false });
    expect(packet.boundedPacket).toBe(true);

    expect(admitChatHistoryPages(host, [{ messages: incoming, packet }], "older")).toBe("messages");

    expect(host.chatMessages).toEqual([first, second, output, third, fourth]);
    expect(host.chatMessages[2]).toBe(output);
    expect(host.chatMessages.at(-1)).toBe(fourth);
    expect(getChatSessionProjection(host).entries.filter((entry) => entry.localOutput)).toEqual([
      local,
    ]);
    if (sequenceOnly) {
      expect(host.chatMessages.filter((message) => message !== output)).toEqual([
        first,
        second,
        third,
        fourth,
      ]);
    }
  },
);

it.each(["older", "newer"] as const)(
  "preserves original reader-packet custody when %s admission changes only its adjacent edge",
  (direction) => {
    const readerRows = Array.from({ length: 401 }, (_, index) => ({
      role: "assistant",
      content: `fragment-${index}`,
      __openclaw: { seq: index < 200 ? 100 : 101 },
    }));
    const readerPacket = prepareChatHistoryPacket(
      readerRows,
      { hasMore: true, olderCursor: "opaque-before-reader" },
      "opaque-after-reader",
    );
    expect(readerPacket.boundedPacket).toBe(true);
    const neighbors = Array.from({ length: 7 }, (_, index) => durable(index + 1));
    const discarded = durable(200);
    const retained =
      direction === "older" ? [...neighbors, ...readerRows] : [...readerRows, ...neighbors];
    const messages = direction === "older" ? [...retained, discarded] : [discarded, ...retained];
    const neighborPackets = neighbors.map((message) =>
      prepareChatHistoryPacket([message], { hasMore: true }),
    );
    const discardedPacket = prepareChatHistoryPacket([discarded], { hasMore: true });
    const segments =
      direction === "older"
        ? [...neighborPackets, readerPacket, discardedPacket]
        : [discardedPacket, readerPacket, ...neighborPackets];

    const admitted = selectChatHistoryResidency(
      messages,
      { hasMore: true, segments },
      direction,
      "seq:101",
    );

    expect(admitted.withinBudget).toBe(true);
    expect(admitted.messages).toEqual(retained);
    expect(admitted.pagination.segments).toHaveLength(8);
    expect(
      admitted.pagination.segments?.find((segment) => segment.sources.includes("seq:101")),
    ).toMatchObject({
      sources: readerPacket.sources,
      boundedPacket: true,
      olderCursor: "opaque-before-reader",
      newerCursor: "opaque-after-reader",
    });
  },
);

it.each(
  (["older", "newer"] as const).flatMap((direction) =>
    (["empty", "filtered", "overlap"] as const).flatMap((mode) =>
      [false, true].map((exhausted) => ({ direction, mode, exhausted })),
    ),
  ),
)(
  "preserves bounded reader packet through $mode $direction admission (exhausted=$exhausted)",
  ({ direction, mode, exhausted }) => {
    const readerRows = Array.from({ length: 401 }, (_, index) => ({
      role: "assistant",
      content: `fragment-${index}`,
      __openclaw: { seq: index < 200 ? 100 : 101 },
    }));
    const readerPage = packetPage(readerRows, "opaque-before-reader", "opaque-after-reader");
    const { packet } = readerPage;
    expect(packet.boundedPacket).toBe(true);
    const host = makeChatHost({
      readTranscriptReaderSnapshot: () => ({
        anchor: "seq:101",
        visibleSources: ["seq:100", "seq:101"],
      }),
    });
    expect(admitChatHistoryPages(host, [readerPage], "around")).toBe("messages");
    expect(host.chatMessages).toEqual(readerRows);
    expect(host.chatMessages.every((message, index) => message === readerRows[index])).toBe(true);
    expect(host.chatHistoryPagination.segments).toEqual([packet]);
    const incoming =
      mode === "overlap"
        ? readerRows
        : mode === "filtered"
          ? visibleChatHistoryMessages([{ role: "assistant", content: "HEARTBEAT_OK" }])
          : [];
    if (mode !== "overlap") {
      expect(incoming).toEqual([]);
    }
    const result =
      direction === "older"
        ? {
            messages: incoming,
            totalMessages: 900,
            hasMore: !exhausted,
            olderCursor: exhausted ? undefined : "advanced-older",
          }
        : {
            messages: incoming,
            totalMessages: 900,
            hasMore: true,
            newerCursor: exhausted ? undefined : "advanced-newer",
          };
    const prepared = prepareChatHistoryPages(host, [result], direction);
    expect(prepared.messages).toEqual(readerRows);
    expect([...prepared.requiredSources]).toEqual(["seq:100", "seq:101"]);
    expect(host.chatHistoryPagination.segments).toEqual([packet]);
    expect(prepared.fits).toBe(true);
    expect(prepared.pagination.segments).toEqual([packet]);
    expect(prepared.pagination.totalMessages).toBe(900);
    const navigation =
      direction === "older"
        ? {
            hasMore: !exhausted,
            olderCursor: exhausted ? undefined : "advanced-older",
            hasNewer: true,
            newerCursor: "opaque-after-reader",
          }
        : {
            hasMore: true,
            olderCursor: "opaque-before-reader",
            hasNewer: exhausted ? undefined : true,
            newerCursor: exhausted ? undefined : "advanced-newer",
          };
    expect(prepared.pagination.hasMore).toBe(navigation.hasMore);
    expect(prepared.pagination.hasMore ? prepared.pagination.olderCursor : undefined).toBe(
      navigation.olderCursor,
    );
    expect(prepared.pagination.hasNewer).toBe(navigation.hasNewer);
    expect(prepared.pagination.newerCursor).toBe(navigation.newerCursor);
    const warm = selectChatHistoryResidency(
      prepared.messages,
      prepared.pagination,
      "tail",
      "seq:101",
    );
    expect(warm.withinBudget).toBe(true);
    expect(warm.pagination).toEqual(prepared.pagination);
    host.chatHistoryPagination = prepared.pagination;
    const next = durable(direction === "older" ? 99 : 102);
    const actual = prepareChatHistoryPages(
      host,
      [{ messages: [next], hasMore: true, olderCursor: "next-older", newerCursor: "next-newer" }],
      direction,
    );
    expect(actual.fits).toBe(true);
    expect(actual.messages).toEqual(
      direction === "older" ? [next, ...readerRows] : [...readerRows, next],
    );
    expect(actual.pagination.segments).toContainEqual(packet);
  },
);

it.each(["older", "newer"] as const)(
  "reopens only the %s navigation edge without rewriting a held packet",
  (direction) => {
    const rows = [durable(100), durable(101)];
    const readerPage = packetPage(rows, "original-older", "original-newer");
    const { packet } = readerPage;
    const host = makeChatHost();
    admitChatHistoryPages(host, [readerPage], "around");
    reopenChatHistoryBoundary(
      host,
      direction === "older" ? "id:source-100" : "id:source-101",
      direction === "older"
        ? { hasMore: true, olderCursor: "reopened-older" }
        : { hasMore: true, hasNewer: true, newerCursor: "reopened-newer" },
      direction,
    );
    expect(host.chatHistoryPagination.segments).toEqual([packet]);
    const warm = selectChatHistoryResidency(host.chatMessages, host.chatHistoryPagination);
    expect(warm.pagination).toMatchObject(
      direction === "older"
        ? { olderCursor: "reopened-older", newerCursor: "original-newer" }
        : { olderCursor: "original-older", newerCursor: "reopened-newer" },
    );
  },
);

it.each([false, true])(
  "retires complete snapshot authority on older traversal (exhausted=%s)",
  (exhausted) => {
    const rows = [durable(100), durable(101)];
    const packet = prepareChatHistoryPacket(rows, { hasMore: false });
    const previous = { hasMore: false, completeSnapshot: true, segments: [packet] } as const;
    const next = extendChatHistoryWindow(
      previous,
      rows,
      [],
      exhausted ? { hasMore: false } : { hasMore: true, olderCursor: "advanced-older" },
      undefined,
      "older",
    );
    expect(next).not.toHaveProperty("completeSnapshot");
    expect(next).toMatchObject(
      exhausted ? { hasMore: false } : { hasMore: true, olderCursor: "advanced-older" },
    );
    expect(previous).toEqual({ hasMore: false, completeSnapshot: true, segments: [packet] });
    expect(next.segments?.[0]).toBe(packet);
    expect(packet.boundedPacket).toBe(true);
    expect(packet).toMatchObject({ hasOlder: false, hasNewer: false });
    const warm = selectChatHistoryResidency(rows, next);
    expect(warm.withinBudget).toBe(true);
    expect(warm.messages).toEqual(rows);
    expect(warm.messages.every((message, index) => message === rows[index])).toBe(true);
    expect(warm.pagination).not.toHaveProperty("completeSnapshot");
  },
);
