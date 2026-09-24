import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createSessionHistoryWorkerReaders,
  type SessionHistoryWorkerRequestRunner,
} from "./session-transcript-worker-readers.js";
import type {
  SessionHistoryWorkerInput,
  SessionHistoryWorkerPreparedInput,
  SessionTranscriptWorkerValues,
} from "./session-transcript-worker.types.js";

type Readers = ReturnType<typeof createSessionHistoryWorkerReaders>;
type Reply = SessionTranscriptWorkerValues[SessionHistoryWorkerInput["kind"]];
type ReaderCase = {
  name: string;
  invoke: (readers: Readers) => Promise<unknown>;
  reply: Reply;
  expected: unknown;
  description: string;
};

const target = {
  agentId: "main",
  sessionId: "session-1",
  sessionKey: "agent:main:reader",
  storePath: "/synthetic/reader.sqlite",
};
const version = { generation: "generation-1", rawSeq: 7, updatedAt: 11 };
const signal = new AbortController().signal;
const replies = {
  eviction: { kind: "historical-eviction-candidates", sessionIds: ["archived-session"] },
  archive: {
    kind: "session-archive-pruning",
    result: {
      archive_name: "session-1.archive",
      archive_sha256: "a".repeat(64),
      created_at: 7,
      encoding: "utf-8",
      generation: "generation-1",
      published_at: 11,
      reason: "archived",
      session_id: target.sessionId,
      session_key: target.sessionKey,
    },
  },
  cold: { kind: "cold-metadata", archive: undefined },
  search: { kind: "transcript-search", result: { hits: [], indexing: false, truncated: false } },
  preview: { kind: "session-preview", items: [{ role: "assistant", text: "preview" }] },
  title: {
    kind: "session-title-fields",
    fields: { firstUserMessage: "question", lastMessagePreview: "answer" },
  },
  backfill: { kind: "session-row-backfill", fields: { lastMessagePreview: "answer" } },
  current: { kind: "current-turn-entry", version, event: { type: "message" } },
  usage: { kind: "usage-refresh-lock", value: "held" },
  membership: { kind: "session-membership-facts", identity: "owner", facts: [] },
  exact: { kind: "session-exact-entries", entries: [], lifecycleTimestamps: {} },
  rows: { kind: "session-row-facts", rows: [] },
  progress: {
    kind: "session-progress-card",
    card: { sessionKey: target.sessionKey, revision: 1, updatedAt: 11, markdown: "Working" },
  },
  entry: { kind: "session-entry-read", entry: { sessionId: "session-1", updatedAt: 11 } },
  entries: { kind: "session-entry-list", entries: [] },
  identity: { kind: "session-identity-evidence", evidence: [{ status: "absent" }] },
} satisfies Record<string, Reply>;

const cases: ReaderCase[] = [
  {
    name: "eviction candidates",
    invoke: (reader) =>
      reader.readHistoricalEvictionCandidates({ env: {}, admissionIdentities: [] }),
    reply: replies.eviction,
    expected: replies.eviction.sessionIds,
    description: "eviction candidates",
  },
  {
    name: "archive pruning",
    invoke: (reader) =>
      reader.readArchivePruning({
        env: {},
        expectedIdentity: {
          kind: "file",
          physicalIdentity: "owner",
          nativeLocation: target.storePath,
        },
      }),
    reply: replies.archive,
    expected: replies.archive.result,
    description: "archive pruning",
  },
  {
    name: "cold metadata",
    invoke: (reader) => reader.readColdMetadata({ sessionId: target.sessionId, env: {} }),
    reply: replies.cold,
    expected: replies.cold,
    description: "cold metadata",
  },
  {
    name: "search",
    invoke: (reader) => reader.searchTranscripts({ agentId: "main", query: "needle" }),
    reply: replies.search,
    expected: replies.search.result,
    description: "search",
  },
  {
    name: "preview",
    invoke: (reader) => reader.readPreview({ target, maxItems: 2, maxChars: 80 }),
    reply: replies.preview,
    expected: replies.preview.items,
    description: "a preview",
  },
  {
    name: "title fields",
    invoke: (reader) => reader.readTitleFields({ scope: target }),
    reply: replies.title,
    expected: replies.title.fields,
    description: "title fields",
  },
  {
    name: "row backfill",
    invoke: (reader) => reader.readRowBackfill({ ...target, sessionEntry: replies.entry.entry }),
    reply: replies.backfill,
    expected: replies.backfill.fields,
    description: "transcript fields",
  },
  {
    name: "current turn",
    invoke: (reader) =>
      reader.readCurrentTurnEntry(
        {
          target,
          resolvedScope: target,
          entryId: "entry-1",
          version,
          includeEntry: true,
        },
        signal,
      ),
    reply: replies.current,
    expected: replies.current,
    description: "a current-turn entry",
  },
  {
    name: "usage cache",
    invoke: (reader) => reader.readUsageCache({ env: {}, request: { kind: "usage-refresh-lock" } }),
    reply: replies.usage,
    expected: replies.usage,
    description: "usage cache",
  },
  {
    name: "membership facts",
    invoke: (reader) => reader.readMembershipFacts({ env: {}, sessionKeys: [target.sessionKey] }),
    reply: replies.membership,
    expected: replies.membership,
    description: "membership facts",
  },
  {
    name: "exact entries",
    invoke: (reader) =>
      reader.readExactEntries({ env: {}, sessionKeys: [target.sessionKey] }, signal),
    reply: replies.exact,
    expected: replies.exact,
    description: "exact entries",
  },
  {
    name: "row facts",
    invoke: (reader) => reader.readRowFacts({ env: {}, sessionKeys: [target.sessionKey] }),
    reply: replies.rows,
    expected: replies.rows,
    description: "row facts",
  },
  {
    name: "progress card",
    invoke: (reader) => reader.readProgressCard({ env: {}, sessionKey: target.sessionKey }),
    reply: replies.progress,
    expected: replies.progress.card,
    description: "a progress card",
  },
  {
    name: "entry result",
    invoke: async (reader) => {
      const result = await reader.readEntryResult({
        scope: { ...target, databaseAgentId: "main" },
      });
      assert(result.ok);
      return result.value;
    },
    reply: replies.entry,
    expected: replies.entry.entry,
    description: "an entry",
  },
  {
    name: "entry list",
    invoke: (reader) => reader.readEntries({ agentId: "main", storePath: target.storePath }),
    reply: replies.entries,
    expected: replies.entries.entries,
    description: "entries",
  },
  {
    name: "identity evidence",
    invoke: (reader) => reader.readIdentityEvidence({ env: {}, identities: [] }),
    reply: replies.identity,
    expected: replies.identity.evidence,
    description: "identity evidence",
  },
];

function readersReturning(reply: Reply) {
  const run: SessionHistoryWorkerRequestRunner = async (_prepare, _bytes, receive) =>
    receive(reply);
  return createSessionHistoryWorkerReaders(run);
}

it.each(cases)("returns the worker's $name projection without cloning", async (testCase) => {
  expect(await testCase.invoke(readersReturning(testCase.reply))).toBe(testCase.expected);
});

const wrongReplies = [false, [], { kind: "message-count", count: 7 }] satisfies Reply[];
it.each(cases)("rejects other reply shapes for $name with its domain error", async (testCase) => {
  for (const reply of wrongReplies) {
    await expect(testCase.invoke(readersReturning(reply))).rejects.toThrow(
      new Error(
        `Session history worker returned another result instead of ${testCase.description}`,
      ),
    );
  }
});

it("keeps usage-cache requests distinct from their usage-refresh-lock replies", async () => {
  const input = { env: {}, request: { kind: "usage-refresh-lock" as const } };
  const run: SessionHistoryWorkerRequestRunner = async (prepare, bytes, receive) => {
    expect(prepare()).toEqual({ kind: "usage-cache", ...input });
    expect(bytes).toBe(JSON.stringify(input).length * 2);
    return receive(replies.usage);
  };
  expect(await createSessionHistoryWorkerReaders(run).readUsageCache(input)).toBe(replies.usage);
});

it.each(["current turn", "exact entries"])("forwards cancellation for %s", async (name) => {
  const testCase = cases.find((item) => item.name === name);
  assert(testCase);
  const run: SessionHistoryWorkerRequestRunner = async (_prepare, _bytes, receive, forwarded) => {
    expect(forwarded).toBe(signal);
    return receive(testCase.reply);
  };
  await testCase.invoke(createSessionHistoryWorkerReaders(run));
});

it("retains admitted row facts and byte accounting until lazy dispatch", async () => {
  const input = {
    env: { OPENCLAW_STATE_DIR: "/synthetic/state" },
    sessionKeys: [target.sessionKey],
  };
  const admitted = structuredClone(input);
  let captured: { prepare: () => SessionHistoryWorkerPreparedInput; bytes: number } | undefined;
  const dispatch = createDeferredCore();
  const run: SessionHistoryWorkerRequestRunner = async (prepare, bytes, receive) => {
    captured = { prepare, bytes };
    await dispatch.promise;
    return receive(replies.rows);
  };
  const pending = createSessionHistoryWorkerReaders(run).readRowFacts(input);
  try {
    assert(captured);
    input.env.OPENCLAW_STATE_DIR = "/synthetic/changed";
    input.sessionKeys.push("agent:main:later");
    expect(captured.prepare()).toEqual({ kind: "session-row-facts", ...admitted });
    expect(captured.bytes).toBe(JSON.stringify(admitted).length * 2);
  } finally {
    dispatch.resolve();
    await pending;
  }
});

it("distinguishes an absent entry from a decoded read failure", async () => {
  const input = { scope: { ...target, databaseAgentId: "main" } };
  const missing = readersReturning({ kind: "session-entry-read", entry: undefined });
  expect(await missing.readEntryResult(input)).toEqual({ ok: true, value: undefined });
  const failed = readersReturning({
    kind: "session-entry-read",
    entry: undefined,
    readError: { kind: "syntax", message: "invalid entry" },
  });
  const result = await failed.readEntryResult(input);
  assert(!result.ok);
  expect(result.error).toBeInstanceOf(SyntaxError);
  expect(result.error).toMatchObject({ message: "invalid entry" });
});
