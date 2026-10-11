import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveStateDir } from "../state-dir.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

const limits = { limit: 2, maxScannedEntries: 1000, maxMaterializedBytes: 16 * 1024 * 1024 };

function readLogicalState(pathname: string) {
  const database = new (requireNodeSqlite().DatabaseSync)(pathname, { readOnly: true });
  try {
    return {
      version: database.prepare("PRAGMA user_version").get(),
      schema: database.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all(),
      transcriptEvents: database
        .prepare(
          "SELECT session_id, seq, event_json, created_at FROM transcript_events ORDER BY session_id, seq",
        )
        .all(),
    };
  } finally {
    database.close();
  }
}

it("preserves logical state through the actual read-only worker", async () => {
  // Supersedes the strict absent-sidecar assertion: the logical read-only
  // contract (PR #153) allows SQLite coordination files while the store's
  // data, schema and idle-writer primary bytes must remain unchanged.
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const writer = openOpenClawAgentDatabase({ agentId: "main", env });
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:preservation",
      sessionId: "preservation",
      path: writer.path,
      env,
    };
    writeSessionEntry(writer, scope.sessionKey, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      lifecycleRevision: "original",
    });
    await replaceTranscriptEvents({ ...scope, storePath: scope.path }, [
      { type: "session", id: scope.sessionId, version: 3 },
    ]);
    await closeOpenClawAgentDatabaseByPathAsync(writer.path);
    const before = await fs.readdir(path.dirname(scope.path));
    expect(before).not.toContain(path.basename(scope.path) + "-wal");
    expect(before).not.toContain(path.basename(scope.path) + "-shm");
    const originalBytes = await fs.readFile(scope.path);
    const logicalBefore = readLogicalState(scope.path);
    const result = await withSessionHistoryWorkerDatabase(
      { agentId: "main", path: scope.path, env },
      (owner) =>
        owner.readTranscriptPage({
          request: { scope, expectedLifecycleRevision: "original", limits },
          expectedIdentity: readDatabasePathIdentitySync(scope.path),
        }),
    );
    expect(result.ok).toBe(true);
    expect(await fs.readFile(scope.path)).toEqual(originalBytes);
    expect(readLogicalState(scope.path)).toEqual(logicalBefore);
  });
});

it("releases the WAL read mark after each worker read", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const writer = openOpenClawAgentDatabase({ agentId: "main", env });
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:read-mark",
      sessionId: "read-mark",
      path: writer.path,
      env,
    };
    writeSessionEntry(writer, scope.sessionKey, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      lifecycleRevision: "original",
    });
    await replaceTranscriptEvents({ ...scope, storePath: scope.path }, [
      { type: "session", id: scope.sessionId, version: 3 },
      { type: "message", id: "one", message: { role: "user", content: "one" } },
    ]);
    const input = {
      request: { scope, expectedLifecycleRevision: "original", limits },
      expectedIdentity: readDatabasePathIdentitySync(scope.path),
    };
    await withSessionHistoryWorkerDatabase(
      { agentId: "main", path: scope.path, env },
      async (owner) => {
        const first = await owner.readTranscriptPage(input);
        expect(first.ok).toBe(true);
        // A held read snapshot would stall the owner's WAL reset (busy 1).
        const checkpoint = writer.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
        expect(checkpoint).toMatchObject({ busy: 0 });
        const second = await owner.readTranscriptPage(input);
        expect(second.ok).toBe(true);
      },
    );
    await closeOpenClawAgentDatabaseByPathAsync(writer.path);
  });
});

it("pages through the built read-only worker and retains the original frontier across an append", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const writer = openOpenClawAgentDatabase({ agentId: "main", env });
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:page-worker",
      sessionId: "worker-session",
      path: writer.path,
      env,
    };
    writeSessionEntry(writer, scope.sessionKey, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      lifecycleRevision: "original",
    });
    await replaceTranscriptEvents({ ...scope, storePath: scope.path }, [
      { type: "session", id: scope.sessionId, version: 3 },
      { type: "message", id: "one", message: { role: "user", content: "one" } },
      { type: "message", id: "two", message: { role: "assistant", content: "two" } },
    ]);
    await closeOpenClawAgentDatabaseByPathAsync(writer.path);
    const input = {
      request: { scope, expectedLifecycleRevision: "original", limits },
      expectedIdentity: readDatabasePathIdentitySync(scope.path),
    };
    await withSessionHistoryWorkerDatabase(
      { agentId: "main", path: scope.path, env },
      async (owner) => {
        const observed = observeHostDataSql();
        const first = await owner.readTranscriptPage(input).finally(() => observed.restore());
        expect(observed.queries).toEqual([]);
        expect(first.ok).toBe(true);
        if (!first.ok) {
          throw new Error(first.error);
        }
        expect(first.value.records.map((entry) => entry.storedEntryId)).toEqual([
          "worker-session",
          "one",
        ]);
        const peer = new (requireNodeSqlite().DatabaseSync)(scope.path);
        try {
          peer
            .prepare(
              "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, 3, ?, 1)",
            )
            .run(
              scope.sessionId,
              JSON.stringify({
                type: "message",
                id: "later",
                message: { role: "user", content: "later" },
              }),
            );
          const second = await owner.readTranscriptPage({
            ...input,
            request: { ...input.request, position: first.value.nextPosition },
          });
          expect(second.ok).toBe(true);
          if (!second.ok) {
            throw new Error(second.error);
          }
          expect(second.value.records.map((entry) => entry.storedEntryId)).toEqual(["two"]);
          expect(second.value.records[0].beforePosition).toEqual(
            first.value.records[1].afterPosition,
          );
          expect(second.value.nextPosition).toBeUndefined();
          const fresh = await owner.readTranscriptPage({
            ...input,
            request: { ...input.request, limits: { ...limits, limit: 50 } },
          });
          expect(fresh.ok && fresh.value.records.map((entry) => entry.storedEntryId)).toEqual([
            "worker-session",
            "one",
            "two",
            "later",
          ]);
          peer.exec("UPDATE transcript_rewrite_watermarks SET generation = 'rewritten'");
          await expect(
            owner.readTranscriptPage({
              ...input,
              request: { ...input.request, position: first.value.nextPosition },
            }),
          ).resolves.toMatchObject({ ok: false, error: "stale_session" });
        } finally {
          peer.close();
        }
      },
    );
  });
});

it("refuses a newer schema through the worker without migrating it", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const writer = openOpenClawAgentDatabase({ agentId: "main", env });
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:newer-schema",
      sessionId: "newer-schema",
      path: writer.path,
      env,
    };
    writeSessionEntry(writer, scope.sessionKey, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      lifecycleRevision: "original",
    });
    await closeOpenClawAgentDatabaseByPathAsync(writer.path);
    const peer = new (requireNodeSqlite().DatabaseSync)(scope.path);
    try {
      const current = peer.prepare("PRAGMA user_version").get() as { user_version?: number };
      peer.exec(`PRAGMA user_version = ${(current.user_version ?? 0) + 1000}`);
    } finally {
      peer.close();
    }
    const originalBytes = await fs.readFile(scope.path);
    const result = await withSessionHistoryWorkerDatabase(
      { agentId: "main", path: scope.path, env },
      (owner) =>
        owner.readTranscriptPage({
          request: { scope, expectedLifecycleRevision: "original", limits },
          expectedIdentity: readDatabasePathIdentitySync(scope.path),
        }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("read_failed");
    }
    expect(await fs.readFile(scope.path)).toEqual(originalBytes);
    const verify = new (requireNodeSqlite().DatabaseSync)(scope.path, { readOnly: true });
    try {
      const version = verify.prepare("PRAGMA user_version").get();
      expect(version.user_version).toBeGreaterThan(0);
    } finally {
      verify.close();
    }
  });
});

it("refuses a store without the agent schema without adopting it", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const bare = path.join(resolveStateDir(env), "bare.sqlite");
    const create = new (requireNodeSqlite().DatabaseSync)(bare);
    try {
      create.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)");
    } finally {
      create.close();
    }
    const originalBytes = await fs.readFile(bare);
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:bare",
      sessionId: "bare",
      path: bare,
      env,
    };
    const result = await withSessionHistoryWorkerDatabase(
      { agentId: "main", path: bare, env },
      (owner) =>
        owner.readTranscriptPage({
          request: { scope, expectedLifecycleRevision: "original", limits },
          expectedIdentity: readDatabasePathIdentitySync(bare),
        }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Schema probes on a foreign store throw rather than return
      // schema-missing; both schema refusal forms map to read_failed.
      expect(result.error).toBe("read_failed");
    }
    expect(await fs.readFile(bare)).toEqual(originalBytes);
  });
});

it("maps an unwritable coordination directory to unsupported without creating state", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const writer = openOpenClawAgentDatabase({ agentId: "main", env });
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:locked-dir",
      sessionId: "locked-dir",
      path: writer.path,
      env,
    };
    writeSessionEntry(writer, scope.sessionKey, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      lifecycleRevision: "original",
    });
    await closeOpenClawAgentDatabaseByPathAsync(writer.path);
    const directory = path.dirname(scope.path);
    await fs.chmod(directory, 0o500);
    try {
      const result = await withSessionHistoryWorkerDatabase(
        { agentId: "main", path: scope.path, env },
        (owner) =>
          owner.readTranscriptPage({
            request: { scope, expectedLifecycleRevision: "original", limits },
            expectedIdentity: readDatabasePathIdentitySync(scope.path),
          }),
      );
      expect(result).toMatchObject({ ok: false, error: "unsupported" });
      const names = await fs.readdir(directory);
      expect(names).not.toContain(path.basename(scope.path) + "-wal");
      expect(names).not.toContain(path.basename(scope.path) + "-shm");
    } finally {
      await fs.chmod(directory, 0o700);
    }
  });
});
