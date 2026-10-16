// Same-turn media provenance inside the single-snapshot recent-text reader, and its transport
// through the memory actor. The SQLite worker route is covered by transcript-grounding.test.ts.
import { afterEach, describe, expect, it } from "vitest";
import { readRecentSessionConversationTextAsync } from "../../gateway/session-transcript-readers.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type {
  SessionTranscriptBoundedMessageTailOptions,
  SessionTranscriptBoundedMessageTailPage,
} from "./session-accessor.sqlite-projection-read.js";
import type { SessionActorAuthority } from "./session-actor-contract.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { runWithSessionActorStorage } from "./session-actor-storage-binding.js";
import {
  readRecentTranscriptConversationText,
  type ReadRecentSessionConversationTextOptions,
} from "./transcript-recent-text.js";

let nextId = 0;
const row = (message: Record<string, unknown>) => ({
  type: "message",
  id: `row-${nextId++}`,
  message,
});
const user = (content: string) => row({ role: "user", content });
const assistant = (content: string) => row({ role: "assistant", content });
const generated = (mediaUrl: string) =>
  row({
    role: "toolResult",
    toolCallId: `call-${nextId}`,
    toolName: "image_generate",
    isError: false,
    content: "Generated",
    details: { media: { mediaUrls: [mediaUrl] } },
  });
const noop = () =>
  row({ role: "toolResult", toolCallId: `call-${nextId}`, toolName: "noop", content: "ok" });

/** One immutable snapshot, paged newest first the way the projection readers page it. */
function snapshotReader(events: readonly unknown[]) {
  const offsets: number[] = [];
  const readPage = ({
    maxMessages,
    offset,
  }: SessionTranscriptBoundedMessageTailOptions): SessionTranscriptBoundedMessageTailPage => {
    offsets.push(offset);
    const end = Math.max(0, events.length - offset);
    const start = Math.max(0, end - maxMessages);
    return {
      events: events
        .slice(start, end)
        .map((event, index) => ({ event, eventSeq: start + index, seq: start + index })),
      totalMessages: events.length,
      newestContiguousEventCount: end - start,
      scannedMessages: end - start,
      serializedBytes: 0,
      snapshot: { indexedSeq: events.length },
    };
  };
  const read = (options: ReadRecentSessionConversationTextOptions) =>
    readRecentTranscriptConversationText(readPage, options);
  return { offsets, read };
}

describe("readRecentTranscriptConversationText turn media references", () => {
  it("leaves the read unchanged when references are not requested", () => {
    const events = [user("make it"), generated("/media/a.png"), assistant("here /media/a.png")];
    const { offsets, read } = snapshotReader(events);

    expect(read({ limit: 2 })).toStrictEqual([
      { id: events[0]?.id, role: "user", text: "make it" },
      { id: events[2]?.id, role: "assistant", text: "here /media/a.png" },
    ]);
    expect(offsets).toEqual([0]);
  });

  it("gives each reply only the earlier trusted results of its own turn", () => {
    const events = [
      user("first"),
      generated("/media/previous-turn.png"),
      assistant("first reply"),
      user("second"),
      generated("/media/own.png"),
      noop(),
      assistant("second reply"),
      generated("/media/later.png"),
    ];
    const { read } = snapshotReader(events);

    expect(
      read({ includeTurnMediaReferences: true }).map(({ text, turnMediaReferences }) => ({
        text,
        turnMediaReferences,
      })),
    ).toEqual([
      { text: "first", turnMediaReferences: undefined },
      { text: "first reply", turnMediaReferences: ["/media/previous-turn.png"] },
      { text: "second", turnMediaReferences: undefined },
      { text: "second reply", turnMediaReferences: ["/media/own.png"] },
    ]);
  });

  it("reads past the limit to the oldest reply's turn start, and no further", () => {
    const events = [
      user("older turn"),
      generated("/media/older.png"),
      user("start"),
      generated("/media/own.png"),
      ...Array.from({ length: 300 }, noop),
      assistant("reply"),
      ...Array.from({ length: 300 }, () => user("newer turn")),
    ];
    const { offsets, read } = snapshotReader(events);

    // The 300 newer user rows fill the first two pages; the reply alone is the requested entry.
    expect(read({ role: "assistant", limit: 1, includeTurnMediaReferences: true })).toEqual([
      {
        id: expect.any(String),
        role: "assistant",
        text: "reply",
        turnMediaReferences: ["/media/own.png"],
      },
    ]);
    expect(offsets).toEqual([0, 250, 500]);
  });

  it("keeps a reply's provenance to the newest 1,000 rows of its turn", () => {
    const events = [
      user("start"),
      generated("/media/old.png"),
      ...Array.from({ length: 1_000 }, noop),
      generated("/media/recent.png"),
      assistant("reply"),
    ];
    const { read } = snapshotReader(events);

    expect(read({ limit: 1, includeTurnMediaReferences: true })).toEqual([
      expect.objectContaining({ text: "reply", turnMediaReferences: ["/media/recent.png"] }),
    ]);
  });
});

describe("memory actor recent text", () => {
  const env = { OPENCLAW_STATE_DIR: "/synthetic/turn-media-references" };
  const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
  afterEach(() => memorySessionActorOwners.reset());

  it("carries turn media references through the actor read", async () => {
    const agentId = "main";
    const sessionId = "turn-media";
    const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId, env });
    const owner = memorySessionActorOwners.get({ agentId, path: storePath });
    const sessionKey = `agent:${agentId}:dashboard:incognito-${sessionId}`;
    const actor = await owner.acquire(
      { database: owner.identity, sessionKey },
      { assertCurrent() {}, assertReadable() {} },
    );
    const events = [user("make it"), generated("/media/a.png"), assistant("here /media/a.png")];
    const created = await actor.storage!.mutate(
      {
        type: "session.entry.create",
        input: {
          entry: { sessionId, updatedAt: 1, incognito: true },
          transcriptEvents: [
            { type: "session", id: sessionId, version: 3, cwd: "/synthetic" },
            ...events.map((event, index) => ({
              ...event,
              parentId: index === 0 ? null : events[index - 1]?.id,
            })),
          ],
        },
      },
      authority,
    );
    expect(created.kind).toBe("committed");
    const scope = { agentId, sessionKey, sessionId, storePath, env };

    await runWithSessionActorStorage({ actor, authority, agentId, path: storePath }, async () => {
      expect(
        await readRecentSessionConversationTextAsync(scope, { includeTurnMediaReferences: true }),
      ).toEqual([
        { id: events[0]?.id, role: "user", text: "make it" },
        {
          id: events[2]?.id,
          role: "assistant",
          text: "here /media/a.png",
          turnMediaReferences: ["/media/a.png"],
        },
      ]);
      expect(await readRecentSessionConversationTextAsync(scope, {})).toStrictEqual([
        { id: events[0]?.id, role: "user", text: "make it" },
        { id: events[2]?.id, role: "assistant", text: "here /media/a.png" },
      ]);
    });
  });
});
