import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { makeTempDir, cleanupTempDirs } from "../../../test/helpers/temp-dir.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import * as agentDb from "../../state/openclaw-agent-db.js";
import * as stateDb from "../../state/openclaw-state-db.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../io.js";
import { resolveSessionStorePathCore } from "./paths.js";
import {
  createSessionEntryWithTranscript as createSession,
  assignSessionOwner,
  listSessionEntriesCore as listEntries,
  loadSessionEntry,
  replaceSessionEntrySync as writeEntry,
} from "./session-accessor.js";
import { readSessionCreationSnapshotInDatabase as readSnapshot } from "./session-accessor.sqlite-creation-read.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { readTranscriptStorageRows } from "./session-accessor.sqlite-read.js";
import { replaceTranscriptEventsSync } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { markCanonicalSessionValidationPending } from "./session-canonical-key.js";
import { seedCanonicalSessionValidation } from "./session-canonical-validation.js";
import { readSessionEntriesFromStoreInWorker } from "./session-entry-read-runtime.js";
import { historyLane } from "./session-transcript-worker-resources.js";
import { promptReport } from "./system-prompt-report.test-support.js";
import { timedMessageEvent } from "./transcript-message.test-support.js";
import type { SessionEntry } from "./types.js";

const tempDirs: string[] = [];
function fixture(sessionKey = "agent:main:target") {
  const env = { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "creation-snapshot-") };
  setRuntimeConfigSnapshot({
    session: { store: resolveSessionStorePathCore(undefined, { agentId: "main", env }) },
  });
  const scope = { agentId: "main", env, sessionKey };
  const database = () => agentDb.openOpenClawAgentDatabase(scope);
  return {
    scope,
    database,
    put: (entry: SessionEntry, key = sessionKey) =>
      writeEntry({ ...scope, sessionKey: key }, entry),
    snapshot: (label?: string, key = sessionKey) => readSnapshot(database(), key, label),
  };
}
const savedEntry = (prompt: string): SessionEntry => ({
  sessionId: "target",
  updatedAt: 1,
  skillsSnapshot: { prompt, skills: [] },
});
const inspectOnly = () => ({ ok: false as const, error: "inspection complete" });
afterEach(async () => {
  vi.restoreAllMocks();
  await agentDb.closeOpenClawAgentDatabasesAsync();
  agentDb.closeOpenClawAgentDatabasesForTest();
  await stateDb.closeOpenClawStateDatabaseAsync();
  stateDb.closeOpenClawStateDatabaseForTest();
  clearRuntimeConfigSnapshot();
  cleanupTempDirs(tempDirs);
});

it.each([false, true])(
  "reuses retained creation facts after discovery (resident=%s)",
  async (resident) => {
    const { scope, put, database } = fixture();
    const target = {
      ...savedEntry("retained prompt"),
      systemPromptReport: promptReport(1, 1, 0),
    };
    if (resident) {
      put(target);
      assignSessionOwner(scope, {
        owner: { type: "human", id: "owner" },
        assignedBy: { type: "system", id: "fixture" },
        assignedAt: 1,
      });
      recordSessionParticipant(scope, { identity: { type: "agent", id: "peer" }, promptedAt: 1 });
    }
    const storePath = database().path;
    await readSessionEntriesFromStoreInWorker({
      ...scope,
      storePath,
      sessionKeys: [scope.sessionKey],
    });
    const requests = vi.spyOn(historyLane.pool, "run");
    await createSession({ ...scope, storePath }, ({ existingEntry, targetEntry, labelInUse }) => {
      if (resident) {
        const expected = {
          ...target,
          owner: { actor: { type: "human", id: "owner" } },
          participants: [{ identity: { type: "agent", id: "peer" } }],
          participantCount: 1,
        };
        expect(existingEntry).toMatchObject(expected);
        expect(targetEntry).toMatchObject(expected);
        expect(existingEntry).not.toBe(targetEntry);
      } else {
        expect(existingEntry).toBeUndefined();
        expect(targetEntry).toBeUndefined();
      }
      expect(labelInUse).toBe(false);
      return inspectOnly();
    });
    expect(requests).not.toHaveBeenCalled();

    const updated = { ...target, sessionId: "updated", updatedAt: 2 };
    put(updated);
    await createSession({ ...scope, storePath }, ({ existingEntry, targetEntry }) => {
      expect(existingEntry).toMatchObject(updated);
      expect(targetEntry).toMatchObject(updated);
      return inspectOnly();
    });
  },
);

it("preserves a competing creation committed while the initial entry is prepared", async () => {
  const { scope, put, database } = fixture();
  const competing = { sessionId: "competing", updatedAt: 1, label: "retained" };
  database();

  await expect(
    createSession(scope, ({ existingEntry }) => {
      expect(existingEntry).toBeUndefined();
      put(competing);
      return { ok: true, entry: { sessionId: "prepared", updatedAt: 2 } };
    }),
  ).rejects.toThrow("SQLite session entry changed before replacement");
  expect(loadSessionEntry(scope)).toMatchObject(competing);
});

it("preserves adopted history without selecting a new projection", async () => {
  const { scope: target, put, database } = fixture();
  const scope = { ...target, sessionId: "target" };
  const entry = { sessionId: "target", updatedAt: 1 };
  put(entry);
  let before: ReturnType<typeof readTranscriptStorageRows> = [];
  const result = await createSession(scope, async () => {
    await Promise.resolve();
    replaceTranscriptEventsSync(scope, [
      timedMessageEvent("user-1", null, "2026-07-15T21:23:03.698Z", {
        role: "user",
        content: "Retained text.\r\n  Keep spacing.",
      }),
    ]);
    before = readTranscriptStorageRows(database(), "target");
    return { ok: true, entry: { ...entry, label: "adopted" } };
  });
  expect(result).toMatchObject({ ok: true, entry: { ...entry, label: "adopted" } });
  expect(readTranscriptStorageRows(database(), "target")).toEqual(before);
});

it("prepares and adopts a complete target without decoding sibling entries", async () => {
  const { scope, put, snapshot } = fixture();
  const target = {
    ...savedEntry("target-saved-prompt"),
    systemPromptReport: promptReport(1, 1, 0),
  };
  put(target);
  put(
    {
      sessionId: "sibling",
      updatedAt: 1,
      displayName: "unrelated-entry-marker",
      skillsSnapshot: { prompt: "unrelated-saved-prompt".repeat(1024), skills: [] },
    },
    "agent:main:sibling",
  );
  assignSessionOwner(scope, {
    owner: { type: "human", id: "owner" },
    assignedBy: { type: "system", id: "fixture" },
    assignedAt: 1,
  });
  recordSessionParticipant(scope, { identity: { type: "agent", id: "peer" }, promptedAt: 1 });
  snapshot();
  const parse = vi.spyOn(JSON, "parse");
  const prepared = snapshot();
  const siblingPayloadReads = parse.mock.calls.filter(([json]) =>
    json.includes("unrelated-entry-marker"),
  ).length;
  parse.mockRestore();
  expect(prepared.existingEntry).toMatchObject(target);
  expect(siblingPayloadReads).toBe(0);
  const created = await createSession(scope, ({ existingEntry }) => {
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
  const key = "agent:main:matrix:group:!Room:example.org";
  const { scope, put, snapshot } = fixture(key);
  const sibling = "agent:main:matrix:group:!room:example.org";
  const entry = { ...savedEntry("preserved target"), label: "own" };
  put(entry);
  put({ sessionId: "sibling", updatedAt: 1, label: "taken" }, sibling);
  for (const [sessionKey, label, archivedAt] of [
    ["agent:main:archived", "archived", 1],
    ["agent:main:spaced", " padded ", undefined],
    ["agent:main:internal-session-effects:hidden", "hidden", undefined],
  ] as const) {
    put({ sessionId: sessionKey, updatedAt: 1, label, archivedAt }, sessionKey);
  }
  agentDb.closeOpenClawAgentDatabasesForTest();
  const result = await createSession(
    { ...scope, sessionKey: "AGENT:MAIN:MATRIX:GROUP:!Room:example.org" },
    (context) => {
      expect(context).toMatchObject({
        existingEntry: entry,
        targetEntry: entry,
        labelInUse: false,
      });
      return inspectOnly();
    },
    { label: "own" },
  );
  expect(result).toMatchObject({ ok: false, phase: "entry" });
  expect(loadSessionEntry({ ...scope, sessionKey: sibling })?.sessionId).toBe("sibling");
  for (const [label, expected] of [
    ["archived", true],
    [" padded ", true],
    ["padded", false],
    ["hidden", false],
    [undefined, false],
  ] as const) {
    expect(snapshot(label).labelInUse).toBe(expected);
  }
});

it.each(["mismatched-time", "nul"])(
  "preserves native warm listing but refuses corrupt worker input for a %s target",
  async (kind) => {
    const { scope, put, snapshot, database: open } = fixture();
    const entry = { ...savedEntry("saved target"), label: "target" };
    put(entry);
    put({ sessionId: "sibling", updatedAt: 1, label: "taken" }, "agent:main:sibling");
    listEntries(scope);
    const database = open();
    const { db } = database;
    runSqliteImmediateTransactionSync(db, () => seedCanonicalSessionValidation(database));
    const column = kind === "nul" ? "entry_json" : "updated_at";
    const value = kind === "nul" ? JSON.stringify(entry) + "\0trailing" : 2;
    db.prepare(`UPDATE session_nodes SET ${column} = ?, entry_valid = 0 WHERE session_key = ?`).run(
      value,
      scope.sessionKey,
    );
    const expected = listEntries(scope).find((row) => row.sessionKey === scope.sessionKey)?.entry;
    const context = snapshot("taken");
    expect(context.existingEntry).toEqual(expected);
    expect(context.targetEntry).toEqual(expected);
    expect(context.labelInUse).toBe(true);
    // Offline repair revokes the physical proof before another reader admits these rows.
    runSqliteImmediateTransactionSync(db, () =>
      markCanonicalSessionValidationPending(database, [scope.sessionKey]),
    );
    const rejectsCorrupt = () =>
      expect(createSession(scope, inspectOnly)).rejects.toThrow("openclaw doctor --fix");
    await rejectsCorrupt();
    await agentDb.closeOpenClawAgentDatabasesAsync();
    agentDb.closeOpenClawAgentDatabasesForTest();
    await rejectsCorrupt();
  },
);

it("keeps the target and sibling labels on one snapshot across an external commit and callback await", async () => {
  const { scope, put, snapshot, database } = fixture("agent:main:a-target");
  const entry = savedEntry("snapshot-target-marker");
  const sibling = { sessionId: "sibling", updatedAt: 1, label: "old label" };
  put(entry);
  put(sibling, "agent:main:z-sibling");
  listEntries(scope);
  const external = new DatabaseSync(database().path);
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
      external
        .prepare(
          "UPDATE session_entry_snapshots SET value_json = ? WHERE session_key = ? AND field = 'skillsSnapshot'",
        )
        .run(JSON.stringify({ prompt: "new target", skills: [] }), scope.sessionKey);
      update.run(JSON.stringify({ ...sibling, label: "new label" }), "agent:main:z-sibling");
      external.exec("COMMIT");
    }
    return result;
  });
  try {
    const context = snapshot("old label");
    await Promise.resolve();
    expect(changed).toBe(true);
    expect(context).toMatchObject({ targetEntry: entry, labelInUse: true });
    expect(snapshot("new label").labelInUse).toBe(true);
    expect(snapshot("old label").labelInUse).toBe(false);
  } finally {
    external.close();
  }
  expect(loadSessionEntry(scope)?.skillsSnapshot?.prompt).toBe("new target");
});
