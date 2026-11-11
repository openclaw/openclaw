import { copyFileSync, readFileSync, renameSync } from "node:fs";
import { symlink } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { afterEach, describe, expect, it as baseIt, onTestFinished, vi } from "vitest";
import { expectBytesEqual } from "../../../test/helpers/file-snapshots.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { admitSqliteSchema } from "../../infra/sqlite-schema-facts.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import type { AssistantMessage } from "../../llm/types.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../../logging/secret-redaction-registry.test-support.js";
import { onInternalSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import {
  appendSessionTranscriptReport,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { retainPreparedSessionEntryPredicate } from "./session-accessor.sqlite-entry-cache-publication-state.js";
import { appendAbortedSessionTranscriptPartial } from "./session-accessor.sqlite-transcript-reports.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { createRetainedSkillsSnapshotFixture } from "./session-skills-snapshot.test-support.js";
import { messageEvent } from "./transcript-message.test-support.js";
import {
  createTranscriptEventInserter,
  createTranscriptPayloadUpdater,
  prepareTranscriptPayload,
} from "./transcript-payload.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "./types.js";
import { CURRENT_SESSION_VERSION } from "./version.js";

afterEach(() => {
  resetSecretRedactionRegistryForTest();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

const body = "synthetic report content ".repeat(400);
const scope = { agentId: "main", sessionKey: "agent:main:reports", sessionId: "reports" };
const assistant = {
  ...makeAgentAssistantMessage({
    content: [{ type: "text", text: body }],
    model: "synthetic",
    timestamp: 1,
  }),
  responseId: "response",
};
const selected = { customType: "status", content: body, details: { selected: true } };
const header = { type: "session", id: scope.sessionId, version: CURRENT_SESSION_VERSION };

const statusReport = (content: string) => ({ customType: "status", content, display: true });
const agentDatabase = () => openOpenClawAgentDatabase({ agentId: scope.agentId });
const nativeDatabase = () => requireNativeSqliteDatabase(agentDatabase().db);
const row = (db: DatabaseSync, sql: string) => db.prepare(sql).get(scope.sessionId);
const textContent = (text: string, textSignature?: string) => [
  {
    type: "text" as const,
    text,
    ...(textSignature ? { textSignature } : {}),
  },
];
const partition = (
  name: string,
  message: Partial<AssistantMessage> & Record<string, unknown> = {},
  skipped = false,
) => ({ name, message, skipped });
const insertEvent = (db: DatabaseSync, seq: number, event: unknown) =>
  createTranscriptEventInserter(
    db,
    scope.sessionId,
  )({
    seq,
    eventJson: JSON.stringify(event),
    createdAt: 1,
  });
const abortPartial = (
  runId: string,
  overrides: Partial<Parameters<typeof appendAbortedSessionTranscriptPartial>[1]> = {},
) =>
  appendAbortedSessionTranscriptPartial(scope, {
    runId,
    message: { ...assistant, idempotencyKey: `${runId}:assistant` },
    expectedLifecycleRevision: "current-lifecycle",
    ...overrides,
  });

const it = baseIt.extend<{ state: OpenClawTestState }>({
  state: [
    async ({ task: _task }, use) =>
      withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        setRuntimeConfigSnapshot({});
        await use(state);
      }),
    { auto: true },
  ],
});
const custom = (
  selectReport: Extract<
    Parameters<typeof appendSessionTranscriptReport>[1],
    { kind: "custom" }
  >["selectReport"],
) => ({ kind: "custom", customTypes: ["status"], selectReport }) as const;
async function blockWriter() {
  const release = createDeferredCore();
  const admitted = createDeferredCore();
  const blocker = runOpenClawAgentWriteAdmission({ agentId: scope.agentId }, async () => {
    admitted.resolve();
    await release.promise;
  });
  await admitted.promise;
  return { release, blocker };
}

async function seedEvents(events: unknown[]) {
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  await replaceTranscriptEvents(scope, [header, ...events]);
  return nativeDatabase();
}
async function seedReports() {
  return seedEvents([
    messageEvent("root", null, { role: "user", content: body }),
    { type: "custom_message", id: "old", parentId: "root", ...statusReport(body) },
    { type: "custom_message", id: "selected", parentId: "old", ...selected, display: true },
    messageEvent("assistant", "selected", { ...assistant, __openclaw: { runId: "run" } }),
    messageEvent("tail", "assistant", { role: "user", content: body }),
  ]);
}

function transcriptSnapshot(db: DatabaseSync) {
  return {
    events: db
      .prepare("SELECT * FROM transcript_events WHERE session_id = ? ORDER BY seq")
      .all(scope.sessionId),
    watermark: row(db, "SELECT * FROM transcript_rewrite_watermarks WHERE session_id = ?"),
  };
}

const expectReport = async (report: Parameters<typeof appendSessionTranscriptReport>[1]) =>
  expect(appendSessionTranscriptReport(scope, report)).resolves.toMatchObject({ ok: true });
const expectAssistant = (message: AssistantMessage & { responseId: string }) =>
  expectReport({ kind: "assistant", message });

describe("SQLite report payload selection", () => {
  it("reserves report identity, environment, and queue order", async ({ state }) => {
    await seedReports();
    const options = { agentId: scope.agentId };
    const { release, blocker } = await blockWriter();
    const order: string[] = [];
    const target = { ...scope, env: { OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR } };
    const report = appendSessionTranscriptReport(target, {
      kind: "custom",
      customTypes: ["status"],
      selectReport: () => {
        order.push("report");
        return statusReport("queued report");
      },
    });
    target.sessionId = "successor";
    target.env.OPENCLAW_STATE_DIR = state.path("successor-state");
    const later = runOpenClawAgentWriteAdmission(options, () => {
      order.push("later write");
    });
    release.resolve();
    await Promise.all([blocker, report, later]);
    expect(order).toEqual(["report", "later write"]);
    expect((await loadTranscriptEvents(scope)).at(-1)).toMatchObject({
      type: "custom_message",
      content: "queued report",
    });
  });

  it("rejects byte-identical file replacement while queued", async ({ state }) => {
    const db = await seedReports();
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const { path: databasePath } = agentDatabase();
    await closeOpenClawAgentDatabaseByPathAsync(databasePath);
    const replacement = state.path("same-report.sqlite");
    const retired = state.path("retired-report.sqlite");
    copyFileSync(databasePath, replacement);
    const { release, blocker } = await blockWriter();
    const selectReport = vi.fn(() => statusReport("stale"));
    const report = appendSessionTranscriptReport(scope, custom(selectReport));
    const rejected = expect(report).rejects.toThrow(/target changed|identity|physical file/i);
    renameSync(databasePath, retired);
    renameSync(replacement, databasePath);
    release.resolve();
    try {
      await Promise.all([blocker, rejected]);
      expect(selectReport).not.toHaveBeenCalled();
      expectBytesEqual(readFileSync(databasePath), readFileSync(retired), "replacement database");
    } finally {
      release.resolve();
      await Promise.allSettled([blocker, report]);
    }
  });

  it("rejects redirection to another store with the same key", async ({ state }) => {
    const requested = { ...scope, storePath: state.path("requested.sqlite") };
    const other = { ...scope, storePath: state.path("other.sqlite") };
    for (const target of [requested, other]) {
      await upsertSessionEntryCore(target, { sessionId: scope.sessionId, updatedAt: 1 });
      await replaceTranscriptEvents(target, [header]);
    }
    const before = await Promise.all(
      [requested, other].map((target) => loadTranscriptEvents(target)),
    );
    const identity = readDatabasePathIdentitySync(other.storePath);
    if (!identity.key.startsWith("file:")) {
      throw new Error("The second session store must exist");
    }
    await expect(
      appendSessionTranscriptReport(
        requested,
        custom(() => statusReport("must stay in requested store")),
        {
          sessionEntryCurrent: {
            source: {
              agentId: scope.agentId,
              path: other.storePath,
              databaseIdentity: identity.key.slice("file:".length),
              databaseBirthtime: identity.birthtime,
              sessionKey: scope.sessionKey,
            },
            assertCurrent: (entry) => {
              if (entry?.sessionId !== scope.sessionId) {
                throw new Error("Session changed");
              }
            },
          },
        },
      ),
    ).rejects.toThrow("Transcript report target differs from its session source restriction");
    expect(
      await Promise.all([requested, other].map((target) => loadTranscriptEvents(target))),
    ).toEqual(before);
  });

  it("preserves retained workspace snapshots through fallback publication", async () => {
    await seedEvents([]);
    await upsertSessionEntryCore(scope, {
      lifecycleRevision: "current-lifecycle",
      skillsSnapshot: createRetainedSkillsSnapshotFixture(),
    });
    const retained = retainPreparedSessionEntryPredicate({
      databaseIdentity: readDatabasePathIdentitySync(agentDatabase().path).key,
      sessionKey: scope.sessionKey,
      entry: loadSessionEntry(scope),
      projection: ["skillsSnapshot"],
      matches: (before, after) =>
        before?.sessionId === after?.sessionId &&
        before?.lifecycleRevision === after?.lifecycleRevision &&
        isDeepStrictEqual(
          before?.skillsSnapshot?.librarySelections,
          after?.skillsSnapshot?.librarySelections,
        ),
    });
    onTestFinished(() => retained.release());
    expect(retained.isCurrent()).toBe(true);
    await expect(abortPartial("retained-workspace")).resolves.toMatchObject({
      ok: true,
      value: { skipped: false, append: { appended: true } },
    });
    expect(retained.isCurrent()).toBe(true);
    await upsertSessionEntryCore(scope, {
      skillsSnapshot: { prompt: "", skills: [], librarySelections: [] },
    });
    expect(retained.isCurrent()).toBe(false);
  });

  it("fences abort fallbacks and preserves authoritative answers", async () => {
    const db = await seedReports();
    const usage = {
      inputTokens: 2_605,
      outputTokens: 19,
      cacheRead: 12,
      cacheWrite: 3,
      totalTokens: 2_624,
      totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
      estimatedCostUsd: 0.25,
    };
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      lifecycleRevision: "current-lifecycle",
      ...usage,
      totalTokensFresh: true,
      updatedAt: 1,
    });
    const partial = {
      runId: "stopped-run",
      message: {
        ...assistant,
        usage: { ...assistant.usage, usageReport: { state: "unavailable" as const } },
        idempotencyKey: "stopped-run:assistant",
      },
    };
    const before = transcriptSnapshot(db);
    const onUpdate = vi.fn();
    onTestFinished(onInternalSessionTranscriptUpdate(onUpdate));
    for (const expectedLifecycleRevision of [null, "previous-lifecycle"]) {
      await expect(
        abortPartial(partial.runId, { ...partial, expectedLifecycleRevision }),
      ).rejects.toThrow("session writer claim changed before transcript persistence");
      expect(transcriptSnapshot(db)).toEqual(before);
      expect(onUpdate).not.toHaveBeenCalled();
    }
    const result = await abortPartial(partial.runId, partial);
    if (!result.ok || result.value.skipped) {
      throw new Error("Expected a committed fallback receipt");
    }
    expect(result.value).toMatchObject({
      lifecycleRevision: "current-lifecycle",
      append: { appended: true },
    });
    const saved = loadSessionEntry(scope);
    expect(saved).toMatchObject({
      usageReport: { state: "unavailable" },
      totalTokensFresh: false,
    });
    for (const field of Object.keys(usage)) {
      expect(saved).not.toHaveProperty(field);
    }
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ...scope,
        runId: partial.runId,
        target: expect.objectContaining(scope),
        lifecycleRevision: result.value.lifecycleRevision,
        messageSeq: result.value.messageSeq,
        message: result.value.append.message,
        messageId: result.value.append.messageId,
      }),
    );
    onUpdate.mockClear();
    await expect(abortPartial(partial.runId, partial)).resolves.toMatchObject({ ok: true });
    expect(onUpdate).not.toHaveBeenCalled();
    const events = await loadTranscriptEvents(scope);
    expect(events).toHaveLength(7);
    expect(events.at(-1)).toMatchObject({
      type: "message",
      parentId: "tail",
      message: { idempotencyKey: "stopped-run:assistant", __openclaw: { runId: "stopped-run" } },
    });

    const partitions = [
      partition("success", { content: textContent("Final answer") }, true),
      partition("error-partial", { stopReason: "error" }, true),
      partition("empty-success", { content: [] }),
      partition("empty-error", { content: [], stopReason: "error", errorMessage: "Failure" }),
      partition("commentary", {
        content: textContent(body, JSON.stringify({ v: 1, id: "commentary", phase: "commentary" })),
      }),
      partition("media-only", {
        content: [],
        openclawDisplayContent: [{ type: "image", mimeType: "image/png", data: "synthetic" }],
      }),
      partition("nonterminal"),
      partition("same-text-other-run"),
    ];
    for (const { name, skipped, message } of partitions) {
      const runId = `stopped-${name}`;
      const nativeMessage = {
        ...assistant,
        ...message,
        responseId: `response-${name}`,
        idempotencyKey: `native-${name}:assistant`,
        __openclaw: {
          runId: name === "same-text-other-run" ? `other-${runId}` : runId,
          mirrorOrigin: "codex-app-server",
          ...(name !== "nonterminal" ? { runTerminal: true } : {}),
        },
      };
      await expectAssistant(nativeMessage);
      const committed = transcriptSnapshot(db);
      onUpdate.mockClear();
      const settled = await abortPartial(runId);
      expect(settled, name).toMatchObject({
        ok: true,
        value: skipped
          ? { skipped: true }
          : { skipped: false, append: { appended: true, message: { __openclaw: { runId } } } },
      });
      const after = transcriptSnapshot(db);
      expect(onUpdate, name).toHaveBeenCalledTimes(skipped ? 0 : 1);
      if (skipped) {
        expect(after, name).toEqual(committed);
      } else {
        expect(after.events, name).toHaveLength(committed.events.length + 1);
        expect(after.events.slice(0, -1), name).toEqual(committed.events);
      }
    }
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      lifecycleRevision: "current-lifecycle",
      activeWriterRunId: "successor-run",
      updatedAt: 1,
    });
    onUpdate.mockClear();
    const beforeSuccessorFallback = transcriptSnapshot(db);
    await expect(abortPartial("superseded-without-answer")).rejects.toThrow(
      "session writer claim changed before transcript persistence",
    );
    await expect(abortPartial("stopped-success")).resolves.toEqual({
      ok: true,
      value: { skipped: true },
    });
    expect(transcriptSnapshot(db)).toEqual(beforeSuccessorFallback);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it.each(["custom", "response"] as const)(
    "keeps %s reporting independent of unselected compressed bodies",
    async (kind) => {
      const db = await seedReports();
      // Unselected bodies are unavailable; their recorded navigation still supports report decisions.
      const changed = db
        .prepare(
          "UPDATE transcript_events SET event_zstd = x'010203' WHERE session_id = ? AND event_zstd IS NOT NULL AND seq != 3 AND seq != ?",
        )
        .run(scope.sessionId, -1);
      expect(changed.changes).toBe(4);
      const before = transcriptSnapshot(db);
      const selectReport = vi.fn(() => undefined);
      const report: Parameters<typeof appendSessionTranscriptReport>[1] =
        kind === "response" ? { kind: "assistant", message: assistant } : custom(selectReport);
      await expect(appendSessionTranscriptReport(scope, report)).resolves.toMatchObject({
        ok: true,
      });
      expect(transcriptSnapshot(db)).toEqual(before);
      if (kind === "custom") {
        expect(selectReport).toHaveBeenCalledExactlyOnceWith(selected);
      } else {
        expect(selectReport).not.toHaveBeenCalled();
      }
    },
  );

  it("reselects an alias after a competing branch commit", async ({ state }) => {
    await seedReports();
    const { path: databasePath } = agentDatabase();
    const alias = state.path("report-alias");
    await symlink(path.dirname(databasePath), alias, "junction");
    const aliasedScope = { ...scope, storePath: path.join(alias, path.basename(databasePath)) };
    const competitor = {
      customType: "status",
      content: "concurrent report",
      details: { revision: 2 },
    };
    {
      using other = openNodeSqliteDatabase(databasePath);
      admitSqliteSchema(other);
      const selectReport = vi.fn((latest: { content: unknown } | undefined) => {
        if (selectReport.mock.calls.length === 1) {
          // Force the actual selection-to-commit race without a timer or worker test hook.
          insertEvent(other, 6, {
            type: "custom_message",
            id: "competitor",
            parentId: "tail",
            ...competitor,
            display: true,
          });
        }
        return statusReport(String(latest?.content));
      });
      await expect(
        appendSessionTranscriptReport(aliasedScope, custom(selectReport)),
      ).resolves.toEqual({ ok: true, value: undefined });
    }
    const events = await loadTranscriptEvents(scope);
    expect(events).toHaveLength(8);
    expect(events[7]).toMatchObject({
      type: "custom_message",
      parentId: "competitor",
      content: competitor.content,
    });
  });

  it("serializes reports before worker transfer", async () => {
    await seedReports();
    const serializedKeys: string[] = [];
    const serializable = <T extends object>(value: T) => ({
      ...value,
      toJSON(key: string) {
        serializedKeys.push(key);
        return { ...this, toJSON: undefined };
      },
    });
    await expect(
      appendSessionTranscriptReport(
        scope,
        custom(() =>
          serializable({
            ...statusReport("serialized report"),
            details: serializable({ nested: serializable({ revision: 3 }), omitted: undefined }),
          }),
        ),
      ),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(serializedKeys).toEqual(["", "details", "nested"]);
    const events = await loadTranscriptEvents(scope);
    expect(events.at(-1)).toMatchObject({
      type: "custom_message",
      parentId: "tail",
      content: "serialized report",
      details: { nested: { revision: 3 } },
    });
    expect(JSON.stringify(events.at(-1))).not.toContain("omitted");
  });

  it.each(["compressed facts", "later header"] as const)(
    "refuses malformed %s before selecting or appending a report",
    async (kind) => {
      const db = await seedReports();
      const selectReport = vi.fn(() =>
        kind === "compressed facts" ? { ...selected, display: true } : undefined,
      );
      const report = custom(selectReport);
      if (kind === "compressed facts") {
        db.prepare(`UPDATE transcript_events SET navigation_json = json_set(navigation_json, '$.report', json(?))
            WHERE session_id = ? AND seq = 1`).run(
          JSON.stringify({
            kind: "canonical",
            hasParentId: true,
            entry: { id: "root", type: "message" },
          }),
          scope.sessionId,
        );
      } else {
        insertEvent(db, 6, { type: "session", id: "later", version: 1 });
        await expect(appendSessionTranscriptReport(scope, report)).resolves.toMatchObject({
          ok: true,
        });
        expect(selectReport).toHaveBeenCalledExactlyOnceWith(selected);
        db.prepare(
          "UPDATE transcript_events SET event_json = '{' WHERE session_id = ? AND seq = 6",
        ).run(scope.sessionId);
        selectReport.mockClear();
      }
      const before = transcriptSnapshot(db);
      await expect(appendSessionTranscriptReport(scope, report)).rejects.toThrow(
        kind === "compressed facts" ? "Invalid compressed transcript report facts" : SyntaxError,
      );
      expect(selectReport).not.toHaveBeenCalled();
      expect(transcriptSnapshot(db)).toEqual(before);
    },
  );

  it("does not suppress responses for unreadable assistants", async () => {
    const unreadable = {
      type: "message",
      id: "unreadable",
      parentId: null,
      message: { role: "assistant", content: null, responseId: assistant.responseId },
      padding: body,
    };
    const db = await seedEvents([unreadable]);
    expect(
      row(
        db,
        "SELECT event_json IS NULL AS encoded FROM transcript_events WHERE session_id = ? AND seq = 1",
      ),
    ).toEqual({ encoded: 1 });
    const secret = "synthetic-report-redaction-registered-value";
    registerSecretValueForRedaction(secret);
    const reportMessage = {
      ...assistant,
      content: [{ type: "text" as const, text: `${body}${secret}` }],
    };
    await expectAssistant(reportMessage);
    const events = await loadTranscriptEvents(scope);
    expect(events).toHaveLength(3);
    expect(events[1]).toEqual(unreadable);
    expect(events[2]).toMatchObject({
      type: "message",
      parentId: "unreadable",
      message: {
        responseId: assistant.responseId,
        content: [{ type: "text", text: `${body}${secret}` }],
      },
    });
  });

  it("suppresses by the last original duplicate member", async () => {
    const raw = `{"type":"message","id":"duplicate","parentId":null,
        "message":{"role":"assistant","content":${JSON.stringify(body)},"responseId":"first"},
        "message":{"role":"assistant","content":${JSON.stringify(body)},"responseId":"discarded","responseId":"last"}}`;
    const db = await seedEvents([JSON.parse(raw)]);
    const payload = prepareTranscriptPayload(db, raw);
    expect(payload.event_zstd).not.toBeNull();
    createTranscriptPayloadUpdater(db, scope.sessionId)({ ...payload, seq: 1 });
    const before = transcriptSnapshot(db);
    await expectAssistant({ ...assistant, responseId: "last" });
    expect(transcriptSnapshot(db)).toEqual(before);
    await expectAssistant({ ...assistant, responseId: "first" });
    const events = await loadTranscriptEvents(scope);
    expect(events).toHaveLength(3);
    expect(events[1]).toEqual(JSON.parse(raw));
    expect(events[2]).toMatchObject({
      type: "message",
      parentId: "duplicate",
      message: { responseId: "first" },
    });
    expect(transcriptSnapshot(db).events[1]).toEqual(before.events[1]);
  });
});
