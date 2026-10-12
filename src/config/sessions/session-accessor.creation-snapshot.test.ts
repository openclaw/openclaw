import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempDir, cleanupTempDirs } from "../../../test/helpers/temp-dir.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import {
  createSessionEntryWithTranscript,
  assignSessionOwner,
  listSessionEntriesCore,
  loadSessionEntry,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import { readSessionCreationSnapshotInDatabase } from "./session-accessor.sqlite-creation-read.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { readTranscriptStorageRows } from "./session-accessor.sqlite-read.js";
import { replaceTranscriptEventsSync } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { markCanonicalSessionValidationPending } from "./session-canonical-key.js";
import { seedCanonicalSessionValidation } from "./session-canonical-validation.js";

const tempDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

describe("session creation snapshot", () => {
  it("preserves a competing creation committed while the initial entry is prepared", async () => {
    const env = { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "creation-conflict-") };
    const scope = { agentId: "main", env, sessionKey: "agent:main:target" };
    const competing = { sessionId: "competing", updatedAt: 1, label: "retained" };
    openOpenClawAgentDatabase(scope);

    await expect(
      createSessionEntryWithTranscript(scope, ({ existingEntry }) => {
        expect(existingEntry).toBeUndefined();
        replaceSessionEntrySync(scope, competing);
        return { ok: true, entry: { sessionId: "prepared", updatedAt: 2 } };
      }),
    ).rejects.toThrow("SQLite session entry changed before replacement");
    expect(loadSessionEntry(scope)).toMatchObject(competing);
  });

  it("preserves adopted history without selecting a new projection", async () => {
    const env = { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "creation-history-") };
    const scope = { agentId: "main", env, sessionKey: "agent:main:target", sessionId: "target" };
    const entry = { sessionId: "target", updatedAt: 1 };
    replaceSessionEntrySync(scope, entry);
    const database = openOpenClawAgentDatabase(scope);
    let before: ReturnType<typeof readTranscriptStorageRows> = [];
    const result = await createSessionEntryWithTranscript(scope, async () => {
      await Promise.resolve();
      replaceTranscriptEventsSync(scope, [
        {
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp: "2026-07-15T21:23:03.698Z",
          message: { role: "user", content: "Retained text.\r\n  Keep spacing." },
        },
      ]);
      before = readTranscriptStorageRows(database, "target");
      return { ok: true, entry: { ...entry, label: "adopted" } };
    });
    expect(result).toMatchObject({ ok: true, entry: { ...entry, label: "adopted" } });
    expect(readTranscriptStorageRows(database, "target")).toEqual(before);
  });

  it("prepares and adopts a complete target without decoding sibling entries", async () => {
    const env = { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "creation-snapshot-") };
    const scope = { agentId: "main", env, sessionKey: "agent:main:target" };
    const target = {
      sessionId: "target",
      updatedAt: 1,
      skillsSnapshot: { prompt: "target-saved-prompt", skills: [] },
      systemPromptReport: {
        source: "run" as const,
        generatedAt: 1,
        systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
        injectedWorkspaceFiles: [],
        skills: { promptChars: 0, entries: [] },
        tools: { listChars: 0, schemaChars: 0, entries: [] },
      },
    };
    replaceSessionEntrySync(scope, target);
    for (let index = 0; index < 3; index++) {
      replaceSessionEntrySync(
        { ...scope, sessionKey: `agent:main:sibling-${index}` },
        {
          sessionId: `sibling-${index}`,
          updatedAt: 1,
          displayName: "unrelated-entry-marker",
          skillsSnapshot: { prompt: "unrelated-saved-prompt".repeat(1024), skills: [] },
        },
      );
    }
    assignSessionOwner(scope, {
      owner: { type: "human", id: "owner" },
      assignedBy: { type: "system", id: "fixture" },
      assignedAt: 1,
    });
    recordSessionParticipant(scope, { identity: { type: "agent", id: "peer" }, promptedAt: 1 });
    const database = openOpenClawAgentDatabase(scope);
    readSessionCreationSnapshotInDatabase(database, scope.sessionKey);
    const parse = vi.spyOn(JSON, "parse");
    const prepared = readSessionCreationSnapshotInDatabase(
      openOpenClawAgentDatabase(scope),
      scope.sessionKey,
    );
    const siblingPayloadReads = parse.mock.calls.filter(([json]) =>
      json.includes("unrelated-entry-marker"),
    ).length;
    parse.mockRestore();
    expect(prepared.existingEntry).toMatchObject(target);
    expect(siblingPayloadReads).toBe(0);
    const created = await createSessionEntryWithTranscript(scope, ({ existingEntry }) => {
      expect(existingEntry).toMatchObject(target);
      return { ok: true, entry: { ...existingEntry!, label: "adopted" } };
    });
    expect(created).toMatchObject({ ok: true, entry: { ...target, label: "adopted" } });
    expect(loadSessionEntry(scope)).toMatchObject({
      ...target,
      label: "adopted",
      owner: { actor: { type: "human", id: "owner" } },
      participants: [{ identity: { type: "agent", id: "peer" } }],
      participantCount: 1,
    });
  });
  it("preserves normalized and opaque target identities after reopening", async () => {
    const env = { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "creation-identities-") };
    const scope = { agentId: "main", env };
    const key = "agent:main:matrix:group:!Room:example.org";
    const sibling = "agent:main:matrix:group:!room:example.org";
    const entry = {
      sessionId: "target",
      updatedAt: 1,
      label: "own",
      skillsSnapshot: { prompt: "preserved target", skills: [] },
    };
    replaceSessionEntrySync({ ...scope, sessionKey: key }, entry);
    replaceSessionEntrySync(
      { ...scope, sessionKey: sibling },
      { sessionId: "sibling", updatedAt: 1, label: "taken" },
    );
    for (const [sessionKey, label, archivedAt] of [
      ["agent:main:archived", "archived", 1],
      ["agent:main:spaced", " padded ", undefined],
      ["agent:main:internal-session-effects:hidden", "hidden", undefined],
    ] as const) {
      replaceSessionEntrySync(
        { ...scope, sessionKey },
        { sessionId: sessionKey, updatedAt: 1, label, archivedAt },
      );
    }
    closeOpenClawAgentDatabasesForTest();
    const result = await createSessionEntryWithTranscript(
      { ...scope, sessionKey: "AGENT:MAIN:MATRIX:GROUP:!Room:example.org" },
      (context) => {
        expect(context.existingEntry).toMatchObject(entry);
        expect(context.targetEntry).toMatchObject(entry);
        expect(context.labelInUse).toBe(false);
        return { ok: false, error: "inspection complete" };
      },
      { label: "own" },
    );
    expect(result).toMatchObject({ ok: false, phase: "entry" });
    expect(loadSessionEntry({ ...scope, sessionKey: sibling })?.sessionId).toBe("sibling");
    const database = openOpenClawAgentDatabase(scope);
    for (const [label, expected] of [
      ["archived", true],
      [" padded ", true],
      ["padded", false],
      ["hidden", false],
      [undefined, false],
    ] as const) {
      expect(readSessionCreationSnapshotInDatabase(database, key, label).labelInUse).toBe(expected);
    }
  });

  it.each(["mismatched-time", "nul"])(
    "preserves native warm listing but refuses corrupt worker input for a %s target",
    async (kind) => {
      const env = { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "creation-warm-rows-") };
      const scope = { agentId: "main", env, sessionKey: "agent:main:target" };
      const entry = {
        sessionId: "target",
        updatedAt: 1,
        label: "target",
        skillsSnapshot: { prompt: "saved target", skills: [] },
      };
      replaceSessionEntrySync(scope, entry);
      replaceSessionEntrySync(
        { ...scope, sessionKey: "agent:main:sibling" },
        { sessionId: "sibling", updatedAt: 1, label: "taken" },
      );
      listSessionEntriesCore(scope);
      const database = openOpenClawAgentDatabase(scope);
      const { db } = database;
      runSqliteImmediateTransactionSync(db, () => seedCanonicalSessionValidation(database));
      if (kind === "nul") {
        db.prepare(
          "UPDATE session_nodes SET entry_json = ?, entry_valid = 0 WHERE session_key = ?",
        ).run(JSON.stringify(entry) + "\0trailing", scope.sessionKey);
      } else {
        db.prepare(
          "UPDATE session_nodes SET updated_at = ?, entry_valid = 0 WHERE session_key = ?",
        ).run(2, scope.sessionKey);
      }
      const expected = listSessionEntriesCore(scope).find(
        (row) => row.sessionKey === scope.sessionKey,
      )?.entry;
      const context = readSessionCreationSnapshotInDatabase(
        openOpenClawAgentDatabase(scope),
        scope.sessionKey,
        "taken",
      );
      expect(context.existingEntry).toEqual(expected);
      expect(context.targetEntry).toEqual(expected);
      expect(context.labelInUse).toBe(true);
      // Offline repair revokes the physical proof before another reader admits these rows.
      runSqliteImmediateTransactionSync(db, () =>
        markCanonicalSessionValidationPending(database, [scope.sessionKey]),
      );
      await expect(
        createSessionEntryWithTranscript(scope, () => ({ ok: false, error: "unreachable" })),
      ).rejects.toThrow("openclaw doctor --fix");
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();
      await expect(
        createSessionEntryWithTranscript(scope, () => ({ ok: false, error: "unreachable" })),
      ).rejects.toThrow("openclaw doctor --fix");
    },
  );

  it("keeps the target and sibling labels on one snapshot across an external commit and callback await", async () => {
    const env = { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "creation-concurrent-snapshot-") };
    const scope = { agentId: "main", env, sessionKey: "agent:main:a-target" };
    const entry = {
      sessionId: "target",
      updatedAt: 1,
      skillsSnapshot: { prompt: "snapshot-target-marker", skills: [] },
    };
    const sibling = { sessionId: "sibling", updatedAt: 1, label: "old label" };
    replaceSessionEntrySync(scope, entry);
    replaceSessionEntrySync({ ...scope, sessionKey: "agent:main:z-sibling" }, sibling);
    listSessionEntriesCore(scope);
    const external = new DatabaseSync(openOpenClawAgentDatabase(scope).path);
    const parse = JSON.parse;
    let changed = false;
    vi.spyOn(JSON, "parse").mockImplementation((value, ...rest) => {
      const result = parse(value, ...rest);
      if (!changed && value.includes("snapshot-target-marker")) {
        changed = true;
        const update = external.prepare(
          "UPDATE session_nodes SET entry_json = ?, entry_valid = 0 WHERE session_key = ?",
        );
        external.exec("BEGIN");
        seedCanonicalSessionValidation({ agentId: "main", db: external });
        expect(
          external
            .prepare(
              "UPDATE session_entry_snapshots SET value_json = ? WHERE session_key = ? AND field = 'skillsSnapshot'",
            )
            .run(JSON.stringify({ prompt: "new target", skills: [] }), scope.sessionKey).changes,
        ).toBe(1);
        update.run(JSON.stringify({ ...sibling, label: "new label" }), "agent:main:z-sibling");
        external.exec("COMMIT");
      }
      return result;
    });
    try {
      const context = readSessionCreationSnapshotInDatabase(
        openOpenClawAgentDatabase(scope),
        scope.sessionKey,
        "old label",
      );
      await Promise.resolve();
      expect(changed).toBe(true);
      expect(context.targetEntry).toMatchObject(entry);
      expect(context.labelInUse).toBe(true);
      expect(
        readSessionCreationSnapshotInDatabase(
          openOpenClawAgentDatabase(scope),
          scope.sessionKey,
          "new label",
        ).labelInUse,
      ).toBe(true);
      expect(
        readSessionCreationSnapshotInDatabase(
          openOpenClawAgentDatabase(scope),
          scope.sessionKey,
          "old label",
        ).labelInUse,
      ).toBe(false);
    } finally {
      external.close();
    }
    expect(loadSessionEntry(scope)?.skillsSnapshot?.prompt).toBe("new target");
  });
});
