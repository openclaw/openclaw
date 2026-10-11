import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkerTranscriptCommitter } from "../../gateway/worker-environments/transcript-commit.js";
import {
  createRequest,
  createTranscriptCommitIdentity,
} from "../../gateway/worker-environments/transcript-commit.test-support.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  appendSessionTranscriptReport,
  readLatestSessionTranscriptReport,
} from "./session-accessor.sqlite-transcript-reports.js";
import type { SessionActorAuthority } from "./session-actor-contract.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { readSessionActorStorageResult } from "./session-actor-storage-result.js";
import { rewritePreparedTranscriptMessageAtAnchor } from "./session-message-rewrite.js";
import { SqliteTranscriptMutationConflictError } from "./session-mutation-conflict-error.js";
import { withPreparedTranscriptCorrection } from "./session-transcript-correction.js";
import { SessionTranscriptWriterClaimReboundError } from "./session-transcript-writer-claim-error.js";

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory reports opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory reports allocated a worker");
  }),
}));

const authority: SessionActorAuthority = { authorize() {}, assertCurrent() {} };
const env = { OPENCLAW_STATE_DIR: "/synthetic/reports" };
const scope = {
  env,
  agentId: "main",
  storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
  sessionKey: "agent:main:dashboard:incognito-reports",
  sessionId: "reports-1",
};
afterEach(() => {
  memorySessionActorOwners.closeDatabase({ agentId: scope.agentId, path: scope.storePath });
});

async function fixture() {
  const owner = memorySessionActorOwners.get({ agentId: scope.agentId, path: scope.storePath });
  const actor = await owner.acquire(
    { database: owner.identity, sessionKey: scope.sessionKey },
    { assertCurrent() {}, assertReadable() {} },
  );
  const storage = actor.storage!;
  readSessionActorStorageResult(
    await storage.mutate(
      {
        type: "session.metadata.initialize",
        input: { scope, entry: { sessionId: scope.sessionId, updatedAt: 1, incognito: true } },
      },
      authority,
    ),
  );
  readSessionActorStorageResult(
    await storage.mutate(
      {
        type: "session.metadata.append",
        input: {
          scope,
          options: {},
          event: JSON.stringify({
            type: "session",
            version: 3,
            id: scope.sessionId,
            cwd: "/synthetic",
            timestamp: "2026-10-11T00:00:00.000Z",
          }),
        },
      },
      authority,
    ),
  );
  const hydrate = async () => {
    const result = await storage.read({ type: "session.history.hydrate", input: {} }, authority);
    if (result.kind !== "full") {
      throw new Error("Expected complete memory transcript");
    }
    return result.snapshot;
  };
  const custom = async (id: string, content: string) =>
    readSessionActorStorageResult(
      await storage.mutate(
        {
          type: "session.metadata.append",
          input: {
            scope,
            options: { appendIntent: "active-branch" },
            event: JSON.stringify({
              type: "custom_message",
              id,
              parentId: null,
              customType: "status",
              content,
              display: true,
              timestamp: "2026-10-11T00:00:00.000Z",
            }),
          },
        },
        authority,
      ),
    );
  return { actor, storage, hydrate, custom };
}

describe("memory transcript reports and edits", () => {
  it("reselects a custom report after an intervening in-process append and preserves prepared bytes", async () => {
    const { storage, hydrate, custom } = await fixture();
    await custom("status-1", "first");
    let intervening: Promise<unknown> | undefined;
    let selections = 0;
    await appendSessionTranscriptReport(scope, {
      kind: "custom",
      customTypes: ["status"],
      selectReport(latest) {
        selections++;
        if (selections === 1) {
          intervening = custom("status-2", "second");
        }
        return {
          customType: "status",
          content: `after ${String(latest?.content)}`,
          display: true,
        };
      },
    });
    await intervening;
    expect(selections).toBe(2);
    expect(await readLatestSessionTranscriptReport(scope, ["status"])).toMatchObject({
      ok: true,
      value: { content: "after second" },
    });
    const selected = await storage.read(
      {
        type: "session.report.prepare",
        input: { scope, selection: { kind: "custom", customTypes: ["status"] } },
      },
      authority,
    );
    if (!selected.ok) {
      throw new Error("Expected report selection");
    }
    const bytes = `{ "type":"custom_message", "id":"prepared-report", "parentId":${JSON.stringify(selected.value.facts.appendParentId)}, "timestamp":"2026-10-11T00:00:00.000Z", "customType":"status", "content":"exact", "display":true }`;
    readSessionActorStorageResult(
      await storage.mutate(
        {
          type: "session.report.append",
          input: {
            scope,
            version: selected.value.version,
            report: { kind: "custom", eventJson: bytes },
          },
        },
        authority,
      ),
    );
    expect((await hydrate()).eventJson?.at(-1)).toBe(bytes);
  });

  it("refuses durable file authority and does not recreate a missing memory session", async () => {
    const { hydrate } = await fixture();
    const before = await hydrate();
    const report = {
      kind: "custom" as const,
      customTypes: ["status"],
      selectReport: () => ({ customType: "status", content: "private", display: true }),
    };
    await expect(
      appendSessionTranscriptReport(scope, report, {
        sessionEntryCurrent: {
          source: {
            agentId: scope.agentId,
            path: "/synthetic/foreign.sqlite",
            databaseIdentity: "foreign",
            sessionKey: scope.sessionKey,
          },
          assertCurrent() {},
        },
      }),
    ).rejects.toThrow("A file session source cannot authorize a memory transcript report");
    expect((await hydrate()).eventJson).toEqual(before.eventJson);
    memorySessionActorOwners.closeDatabase({ agentId: scope.agentId, path: scope.storePath });
    await expect(appendSessionTranscriptReport(scope, report)).resolves.toMatchObject({
      ok: false,
      error: { code: "session-entry-missing" },
    });
    expect(
      memorySessionActorOwners.read({ agentId: scope.agentId, path: scope.storePath }),
    ).toBeUndefined();
  });

  it("rejects a prepared correction after a concurrent edit without losing the appended row", async () => {
    const { hydrate, custom } = await fixture();
    await custom("status-1", "first");
    const before = await hydrate();
    await expect(
      withPreparedTranscriptCorrection(scope, async (correction) => {
        const events = await correction.readEvents();
        await custom("status-2", "second");
        await correction.replaceEvents(
          events.map((event) =>
            typeof event === "object" && event !== null && "id" in event && event.id === "status-1"
              ? Object.assign({}, event, { content: "overwritten" })
              : event,
          ),
        );
      }),
    ).rejects.toBeInstanceOf(SqliteTranscriptMutationConflictError);
    const after = await hydrate();
    expect(after.eventJson?.slice(0, before.eventJson?.length)).toEqual(before.eventJson);
    expect(after.events.at(-1)).toMatchObject({ id: "status-2", content: "second" });
  });

  it("rewrites an unbound anchored message while preserving later appends and rejecting competing edits", async () => {
    const { actor, storage, hydrate } = await fixture();
    for (const content of ["first", "later"]) {
      readSessionActorStorageResult(
        await storage.mutate(
          {
            type: "session.transcript.appendMessage",
            input: {
              scope,
              messageJson: JSON.stringify({ role: "user", content, timestamp: 1 }),
              cwd: "/synthetic",
            },
          },
          authority,
        ),
      );
    }
    const anchor = actor.snapshot(authority)!.transcript.anchors[0]!;
    await expect(
      rewritePreparedTranscriptMessageAtAnchor(anchor, (message) =>
        Object.assign({}, message, { content: "revised" }),
      ),
    ).resolves.toMatchObject({ message: { content: "revised" } });
    const before = await hydrate();
    const currentAnchor = actor.snapshot(authority)!.transcript.anchors[0]!;
    const index = before.events.findIndex(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        "id" in event &&
        event.id === currentAnchor.entryId,
    );
    let competing: ReturnType<typeof storage.mutate> | undefined;
    await expect(
      rewritePreparedTranscriptMessageAtAnchor(currentAnchor, (message) => {
        competing = storage.mutate(
          {
            type: "session.correction.commit",
            input: {
              scope,
              version: before.version,
              allowLaterAppends: true,
              rows: [
                {
                  entryId: currentAnchor.entryId,
                  expectedEventJson: before.eventJson![index]!,
                  event: Object.assign({}, before.events[index], {
                    message: Object.assign({}, message, { content: "competing" }),
                  }),
                },
              ],
            },
          },
          authority,
        );
        return Object.assign({}, message, { content: "lost update" });
      }),
    ).rejects.toBeInstanceOf(SessionTranscriptWriterClaimReboundError);
    readSessionActorStorageResult(await competing!);
    expect((await hydrate()).events).toMatchObject([
      { type: "session" },
      { type: "message", message: { content: "competing" } },
      { type: "message", message: { content: "later" } },
    ]);
  });

  it("refuses a worker batch when placement authority closes during acquisition", async () => {
    const { hydrate } = await fixture();
    const before = await hydrate();
    const committer = createWorkerTranscriptCommitter({ getConfig: () => ({}) });
    let current = true;
    const commit = committer.commit({
      identity: createTranscriptCommitIdentity(scope.sessionId, 7),
      sessionTarget: scope,
      request: createRequest(),
      assertCurrent() {
        if (!current) {
          throw new Error("Placement owner ended");
        }
        return undefined;
      },
    });
    current = false;
    await expect(commit).rejects.toThrow("Placement owner ended");
    expect((await hydrate()).eventJson).toEqual(before.eventJson);
  });

  it("commits and replays ordered worker batches without creating a durable ledger", async () => {
    const { hydrate } = await fixture();
    const committer = createWorkerTranscriptCommitter({ getConfig: () => ({}) });
    const params = {
      identity: createTranscriptCommitIdentity(scope.sessionId, 7),
      sessionTarget: scope,
      request: createRequest({
        messages: [
          { role: "user", content: "one", timestamp: 1 },
          { role: "user", content: "two", timestamp: 2 },
        ],
      }),
      assertCurrent: () => undefined,
    };
    const first = await committer.commit(params);
    expect(first).toMatchObject({
      ok: true,
      result: {
        entryIds: [expect.any(String), expect.any(String)],
        newLeafId: expect.any(String),
      },
    });
    const before = await hydrate();
    expect(await committer.commit(params)).toEqual(first);
    expect(
      await committer.commit({
        ...params,
        request: {
          ...params.request,
          messages: [{ role: "user", content: "changed", timestamp: 1 }],
        },
      }),
    ).toEqual({ ok: false, reason: "invalid-batch" });
    expect(await committer.commit({ ...params, request: { ...params.request, seq: 3 } })).toEqual({
      ok: false,
      reason: "invalid-batch",
    });
    expect((await hydrate()).eventJson).toEqual(before.eventJson);
    const stale = await committer.commit({
      ...params,
      request: { ...params.request, seq: 2, baseLeafId: "other-branch" },
    });
    expect(stale).toEqual({ ok: false, reason: "stale-base-leaf" });
    expect(
      await committer.commit({
        ...params,
        request: { ...params.request, seq: 2, baseLeafId: "other-branch" },
      }),
    ).toEqual(stale);
    expect((await hydrate()).eventJson).toEqual(before.eventJson);
  });
});
