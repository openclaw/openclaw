import { mergeChatStreamMessage } from "@openclaw/gateway-client/browser";
import { afterEach, expect, it, vi } from "vitest";
import * as fingerprint from "../../../../../src/shared/fnv1a.js";
import * as historyIdentity from "../../../lib/chat/history-message-identity.ts";
import { chatItemGroups } from "../chat-agent-run-grouping.ts";
import { makeMessage } from "../chat-thread.test-support.ts";
import { buildCachedChatItems, resetChatThreadState, retireChatThreadSources } from "../chat-thread.ts";
import { finalAnswer, chatProps, chatItems, chainFor, indexFor, projectHistory, messagesIn } from "./chat-transcript-message-index.test-support.ts";

afterEach(() => resetChatThreadState());

it.each(["older", "newer"] as const)(
  "reuses retained terminal footprint work after %s history retirement",
  (direction) => {
    const sources = Array.from({ length: 480 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `Footprint source ${index + 1}. ${"Stable transcript content. ".repeat(160)}`,
      timestamp: (index + 1) * 10,
      __openclaw: { id: `footprint-${index + 1}`, seq: index + 1 },
    }));
    const before = direction === "older" ? sources.slice(80) : sources.slice(0, 400);
    const after = direction === "older" ? sources.slice(0, 400) : sources.slice(80);
    const retained = before.filter((message) => after.includes(message));
    const fresh = after.filter((message) => !before.includes(message));
    const retainedSources = new Set<unknown>(retained);
    const freshSources = new Set<unknown>(fresh);
    const input = chatProps({ paneId: `footprint-${direction}`, messages: before });
    const firstItems = buildCachedChatItems(input);
    const firstChain = chainFor(firstItems, { messages: before });
    const identity = vi.spyOn(historyIdentity, "nativeHistoryMessageIdentity");
    const hash = vi.spyOn(fingerprint, "fnv1aUtf16");
    try {
      const firstIndex = indexFor(firstChain);
      const firstRows = firstIndex.rows.filter((row) => row.kind === "item");
      expect(firstRows).toHaveLength(400);
      expect(messagesIn(firstRows.map((row) => row.item))).toEqual(before);
      const hashInputs = new Map(
        hash.mock.calls.map(([content], index) => [
          `${content.length}:${hash.mock.results[index]!.value}`,
          content,
        ]),
      );
      const priorRows = new Map(before.map((message, index) => [message, firstRows[index]!]));
      const retainedHashes = new Set(
        retained.map((message) => hashInputs.get(priorRows.get(message)!.revision!)),
      );
      expect(retainedHashes.size).toBe(320);
      expect(retainedHashes.has(undefined)).toBe(false);
      identity.mockClear();
      hash.mockClear();
      retireChatThreadSources(
        input.paneId,
        before.filter((message) => !after.includes(message)),
      );
      const nextItems = buildCachedChatItems({ ...input, messages: after });
      const nextChain = chainFor(nextItems, { messages: after });
      const nextIndex = indexFor(nextChain);
      const rows = nextIndex.rows.filter((row) => row.kind === "item");
      expect(nextChain).not.toBe(firstChain);
      expect(rows).toHaveLength(400);
      expect(messagesIn(rows.map((row) => row.item))).toEqual(after);
      expect(nextIndex.positionIndex.markers.map((marker) => marker.message)).toEqual(after);
      for (const [index, message] of after.entries()) {
        const row = rows[index]!;
        expect(nextIndex.messageRowKeysById.get(message["__openclaw"].id)).toBe(row.key);
        expect(nextIndex.loadedReplySources.get(message["__openclaw"].id)?.message).toBe(message);
        const sourceKey = chatItemGroups(row.item)[0]!.messages[0]!.key;
        expect(nextIndex.transcriptMessageKeys.get(sourceKey)).toBe(row.key);
        const prior = priorRows.get(message);
        if (prior) {
          if (message === retained[0]) {
            // The retained boundary gains/loses its preceding reply; adjacent
            // reply chrome must refresh while its measured body stays reusable.
            expect(row.item).not.toBe(prior.item);
            expect(row.item).toMatchObject({
              replyPreviousMessageId: direction === "older" ? "footprint-80" : undefined,
            });
          } else {
            expect(row.item).toBe(prior.item);
          }
          expect(row.key).toBe(prior.key);
          expect(row.revision).toBe(prior.revision);
        }
      }
      expect(
        identity.mock.calls.filter(([message]) => freshSources.has(message)).length,
      ).toBeGreaterThan(0);
      expect(
        hash.mock.calls.filter(([content]) => !retainedHashes.has(content)).length,
      ).toBeGreaterThan(0);
      expect(identity.mock.calls.filter(([message]) => retainedSources.has(message))).toEqual([]);
      expect(
        hash.mock.calls
          .filter(([content]) => retainedHashes.has(content))
          .map(([content]) => content),
      ).toEqual([hashInputs.get(priorRows.get(retained[0]!)!.revision!)]);
    } finally {
      identity.mockRestore();
      hash.mockRestore();
    }
  },
);

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

it("does not serialize settled history again when a live status changes the row model", () => {
  let serializations = 0;
  const message = makeMessage("older", 1, {
    role: "user",
    metadata: {
      toJSON: () => {
        serializations++;
        return { label: "Settled history" };
      },
    },
  });
  const items = chatItems({ messages: [message] });
  serializations = 0;
  const before = indexFor(chainFor(items)).rows[0]!;
  expect(serializations).toBe(1);
  const during = indexFor(
    chainFor([...items, { kind: "reading-indicator", key: "waiting", startedAt: 32 }]),
  ).rows[0]!;
  expect(during.kind === "item" && during.revision).toBe(before.kind === "item" && before.revision);
  expect(serializations).toBe(1);
});

it.each(["stream delta", "snapshot"] as const)(
  "invalidates a retained terminal item after immutable %s replacement",
  (replacement) => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "Before" }],
      timestamp: 10,
      __openclaw: { id: "replacement", seq: 1 },
    };
    const previousContent = message.content;
    const previousBlock = message.content[0];
    let items = chatItems({ messages: [message] });
    const originalItems = items;
    const project = () => {
      const rows = indexFor(chainFor([...items])).rows.filter((row) => row.kind === "item");
      expect(rows).toHaveLength(1);
      return rows[0]!;
    };
    const hash = vi.spyOn(fingerprint, "fnv1aUtf16");
    try {
      const before = project();
      expect(messagesIn(items)).toEqual([message]);
      expect(before.kind).toBe("item");
      hash.mockClear();
      const unchanged = project();
      expect(unchanged.kind === "item" && unchanged.item).toBe(
        before.kind === "item" && before.item,
      );
      expect(unchanged.revision).toBe(before.revision);
      expect(hash).not.toHaveBeenCalled();
      const snapshot = { ...message, content: [{ type: "text", text: "Snapshot" }] };
      const nextMessage = mergeChatStreamMessage(
        message,
        replacement === "stream delta" ? { deltaText: " appended" } : { message: snapshot },
      );
      expect(nextMessage).not.toBe(message);
      if (replacement === "snapshot") {
        expect(nextMessage).toBe(snapshot);
      }
      expect(nextMessage).toMatchObject({
        content: [
          { type: "text", text: replacement === "stream delta" ? "Before appended" : "Snapshot" },
        ],
      });
      items = chatItems({ messages: [nextMessage] });
      // Count the new envelope and row digest, independently of item preparation.
      hash.mockClear();
      const after = project();
      expect(messagesIn(items)).toEqual([nextMessage]);
      expect(message.content).toBe(previousContent);
      expect(message.content[0]).toBe(previousBlock);
      expect(message.content[0]?.text).toBe("Before");
      expect(messagesIn(originalItems)).toEqual([message]);
      expect(after.kind === "item" && after.item).not.toBe(before.kind === "item" && before.item);
      expect(after.key).toBe(before.key);
      expect(after.revision).not.toBe(before.revision);
      expect(hash).toHaveBeenCalledTimes(2);
      hash.mockClear();
      expect(project().revision).toBe(after.revision);
      expect(hash).not.toHaveBeenCalled();
    } finally {
      hash.mockRestore();
    }
  },
);
it("fingerprints loaded rows once when an older page rebuilds the index", () => {
  const turn = (id: string, seq: number, content: string) =>
    makeMessage(id, seq, { role: seq % 2 ? "user" : "assistant", runId: `run-${seq}`, content });
  const body = "Loaded reply. ".repeat(400);
  const loaded = Array.from({ length: 20 }, (_, index) =>
    turn(`loaded-${index}`, 21 + index, body),
  );
  const older = Array.from({ length: 20 }, (_, index) =>
    turn(`older-${index}`, 1 + index, "Older"),
  );
  const before = indexFor(projectHistory(loaded)).rows;
  const hash = vi.spyOn(fingerprint, "fnv1aUtf16");
  const after = indexFor(projectHistory([...older, ...loaded])).rows;
  const hashed = hash.mock.calls.reduce((sum, [value]) => sum + value.length, 0);
  hash.mockRestore();
  expect(after.slice(-before.length).map((row) => row.kind === "item" && row.revision)).toEqual(
    before.map((row) => row.kind === "item" && row.revision),
  );
  expect(hashed).toBeLessThan(body.length);
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
  const hash = vi.spyOn(fingerprint, "fnv1aUtf16");
  try {
    const before = project(new Map());
    hash.mockClear();
    const reacted = project(new Map([["answer", summaries]]));
    expect(reacted.map((row) => row.key)).toEqual(before.map((row) => row.key));
    expect(reacted[0]!.revision).not.toBe(before[0]!.revision);
    expect(reacted[1]!.revision).toBe(before[1]!.revision);
    expect(hash).toHaveBeenCalledTimes(1);
    hash.mockClear();
    const replay = project(
      new Map([
        ["answer", summaries],
        ["outside-window", summaries],
      ]),
    );
    expect(replay.map((row) => row.revision)).toEqual(reacted.map((row) => row.revision));
    expect(hash).not.toHaveBeenCalled();
    expect(project(new Map([["answer", []]])).map((row) => row.revision)).toEqual(
      before.map((row) => row.revision),
    );
    expect(hash).toHaveBeenCalledTimes(1);
  } finally {
    hash.mockRestore();
  }
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
  const hash = vi.spyOn(fingerprint, "fnv1aUtf16");
  try {
    const before = indexFor(settled).rows[0]!;
    hash.mockClear();
    const during = indexFor(active).rows[0]!;
    expect(during.key).toBe(before.key);
    expect(before.kind === "item" && before.revision).toEqual(expect.any(String));
    expect(during.kind === "item" && during.revision).toBeUndefined();
    expect(hash).not.toHaveBeenCalled();
    const restored = indexFor(chainFor([...items])).rows[0]!;
    expect(restored.kind === "item" && restored.item).toBe(before.kind === "item" && before.item);
    expect(restored.kind === "item" && restored.revision).toBe(
      before.kind === "item" && before.revision,
    );
    expect(hash).not.toHaveBeenCalled();
  } finally {
    hash.mockRestore();
  }
});

