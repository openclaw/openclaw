import { afterEach, assert, describe, expect, it, vi } from "vitest";
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
import {
  commitMemory,
  readMemory,
  mutateMemory,
} from "./session-actor-memory-publication.test-support.js";
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
  await commitMemory(storage, "session.metadata.initialize", {
    scope,
    entry: { sessionId: scope.sessionId, updatedAt: 1, incognito: true },
  });
  await commitMemory(storage, "session.metadata.append", {
    scope,
    options: {},
    event: JSON.stringify({
      type: "session",
      version: 3,
      id: scope.sessionId,
      cwd: "/synthetic",
      timestamp: "2026-10-11T00:00:00.000Z",
    }),
  });
  const hydrate = async () => {
    const result = await readMemory(storage, "session.history.hydrate", {});
    assert(result.kind === "full", "Expected complete memory transcript");
    return result.snapshot;
  };
  const custom = async (id: string, content: string) =>
    await commitMemory(storage, "session.metadata.append", {
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
    });
  return { actor, storage, hydrate, custom };
}

describe("memory transcript reports and edits", () => {
  it("reselects a mixed-case session report after an intervening append and preserves prepared bytes", async () => {
    const { storage, hydrate, custom } = await fixture();
    const reportScope = { ...scope, sessionKey: "agent:main:dashboard:incognito-RePoRtS" };
    await custom("status-1", "first");
    let intervening: Promise<unknown> | undefined;
    let selections = 0;
    await appendSessionTranscriptReport(reportScope, {
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
    expect(await readLatestSessionTranscriptReport(reportScope, ["status"])).toMatchObject({
      ok: true,
      value: { content: "after second" },
    });
    const selected = await readMemory(storage, "session.report.prepare", {
      scope: reportScope,
      selection: { kind: "custom", customTypes: ["status"] },
    });
    assert(selected.ok, "Expected report selection");
    const bytes = `{ "type":"custom_message", "id":"prepared-report", "parentId":${JSON.stringify(selected.value.facts.appendParentId)}, "timestamp":"2026-10-11T00:00:00.000Z", "customType":"status", "content":"exact", "display":true }`;
    await commitMemory(storage, "session.report.append", {
      scope: reportScope,
      version: selected.value.version,
      report: { kind: "custom", eventJson: bytes },
    });
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

  it("preserves admission for identical replay text but revokes it for projection or content edits", async () => {
    const { storage, hydrate } = await fixture();
    const user = {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-10-11T00:00:00.000Z",
      message: { role: "user", content: "question", timestamp: 1 },
    };
    await commitMemory(storage, "session.metadata.append", {
      scope,
      options: {},
      event: { ...user, type: "message" },
      message: {
        messageJson: JSON.stringify(user.message),
        cwd: "/synthetic",
        validateTurn: false,
      },
    });
    const projected = {
      ...user.message,
      __openclaw: {
        steerTargetRunId: "running-turn",
        modelPromptProjection: { version: 1, text: "question" },
      },
    };
    const changedProjection = {
      ...projected,
      __openclaw: {
        ...projected["__openclaw"],
        modelPromptProjection: { version: 1, text: "changed" },
      },
    };
    for (const [index, message] of [
      projected,
      changedProjection,
      { ...changedProjection, content: "edited" },
    ].entries()) {
      const before = await hydrate();
      const replacement = { ...user, message };
      await withPreparedTranscriptCorrection(scope, async (correction) => {
        const events = await correction.readEvents();
        await correction.replaceEvents([...events.slice(0, -1), replacement]);
      });
      const after = await hydrate();
      expect(after.eventJson?.at(-1)).toBe(JSON.stringify(replacement));
      if (index === 0) {
        expect(after.version.generation).toBe(before.version.generation);
      } else {
        expect(after.version.generation).not.toBe(before.version.generation);
      }
    }
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
      await commitMemory(storage, "session.transcript.appendMessage", {
        scope,
        messageJson: JSON.stringify({ role: "user", content, timestamp: 1 }),
        cwd: "/synthetic",
      });
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
        competing = mutateMemory(storage, "session.correction.commit", {
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
        });
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
          { role: "user", content: [{ type: "text", text: "one" }], timestamp: 1 },
          { role: "user", content: [{ type: "text", text: "two" }], timestamp: 2 },
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
          messages: [{ role: "user", content: [{ type: "text", text: "changed" }], timestamp: 1 }],
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
