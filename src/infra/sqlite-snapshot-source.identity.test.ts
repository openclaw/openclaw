import fs from "node:fs";
import path from "node:path";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withArtifactPreservingStateReads } from "../state/artifact-preserving-state-reads.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { admitOpenClawMaintenanceLiveAuthorityReads } from "../state/openclaw-state-maintenance-context.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { resolvePrivateSqliteSnapshotStagingRoot } from "./sqlite-private-directory.js";
import { cleanupSnapshotOperations } from "./sqlite-readonly-location-cleanup.js";
import type { RetainedSqliteSnapshotPreparation } from "./sqlite-readonly-location.types.js";
import {
  openSqliteReadOnlyDatabase,
  startSqliteReadOnlyLocationAsync,
} from "./sqlite-snapshot-source.js";
import { readDatabasePathIdentitySync } from "./sqlite-worker-identity.js";

let cleanupJoined = true;
const directories = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    vi.unstubAllEnvs();
    if (!cleanupJoined) {
      throw new Error(
        `Snapshot cleanup did not join; retained fixtures: ${[...directories.dirs].join(", ")}`,
      );
    }
    cleanup();
  });
});

function readValue(pathname: string) {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(pathname, { readOnly: true });
  try {
    return database.prepare("SELECT value FROM probe").get();
  } finally {
    database.close();
  }
}

it("keeps queued stale and current source admissions independent through the real copy child", async () => {
  const root = directories.make("sqlite-snapshot-source-identity-");
  const source = path.join(root, "source.sqlite");
  const successor = path.join(root, "successor.sqlite");
  const archived = path.join(root, "original.sqlite");
  const cache = path.join(root, "cache");
  fs.mkdirSync(cache);
  vi.stubEnv("XDG_CACHE_HOME", cache);
  const { DatabaseSync } = requireNodeSqlite();
  for (const fixture of [
    { pathname: source, value: "original" },
    { pathname: successor, value: "successor" },
  ]) {
    const database = new DatabaseSync(fixture.pathname);
    try {
      database.exec("PRAGMA journal_mode=DELETE; CREATE TABLE probe(value TEXT);");
      database.prepare("INSERT INTO probe VALUES (?)").run(fixture.value);
    } finally {
      database.close();
    }
  }
  const originalIdentity = readDatabasePathIdentitySync(source);
  const originalBytes = fs.readFileSync(source);
  const successorBytes = fs.readFileSync(successor);
  fs.renameSync(source, archived);
  fs.renameSync(successor, source);
  const currentIdentity = readDatabasePathIdentitySync(source);
  expect(currentIdentity.key).not.toBe(originalIdentity.key);
  const stagingRoot = resolvePrivateSqliteSnapshotStagingRoot();
  const stagingBefore = fs.readdirSync(stagingRoot).toSorted();
  cleanupJoined = false;
  const accepted: RetainedSqliteSnapshotPreparation[] = [];
  try {
    const stale = startSqliteReadOnlyLocationAsync(source, {
      preserveSourceArtifacts: true,
      expectedSourceIdentity: originalIdentity,
    });
    accepted.push(stale);
    const current = startSqliteReadOnlyLocationAsync(source, {
      preserveSourceArtifacts: true,
      expectedSourceIdentity: currentIdentity,
    });
    accepted.push(current);
    const [staleOutcome, currentOutcome] = await Promise.allSettled([stale.result, current.result]);
    expect(currentOutcome.status).toBe("fulfilled");
    if (currentOutcome.status !== "fulfilled") {
      throw currentOutcome.reason;
    }
    expect(readValue(currentOutcome.value.location)).toEqual({ value: "successor" });
    expect(staleOutcome.status).toBe("rejected");
    if (staleOutcome.status !== "rejected") {
      throw new Error("The stale admission copied the successor database");
    }
    expect(
      collectNestedErrorCandidates(staleOutcome.reason).some(
        (error) => error instanceof Error && error.message.includes("file identity changed"),
      ),
    ).toBe(true);
  } finally {
    const outcomes = await Promise.allSettled(accepted.map((request) => request.result));
    const prepared = outcomes.flatMap((outcome) =>
      outcome.status === "fulfilled" ? [outcome.value] : [],
    );
    const closed = await Promise.allSettled(accepted.map((request) => request.startClose().result));
    await cleanupSnapshotOperations();
    for (const closure of closed) {
      expect(closure).toMatchObject({ status: "fulfilled", value: undefined });
    }
    for (const location of prepared) {
      expect(fs.existsSync(location.cleanupRoot ?? path.dirname(location.location))).toBe(false);
    }
    expect(fs.readdirSync(stagingRoot).toSorted()).toEqual(stagingBefore);
    cleanupJoined = true;
  }
  expect(readValue(archived)).toEqual({ value: "original" });
  expect(readValue(source)).toEqual({ value: "successor" });
  expect(fs.readFileSync(archived)).toEqual(originalBytes);
  expect(fs.readFileSync(source)).toEqual(successorBytes);
  expect(readDatabasePathIdentitySync(source)).toEqual(currentIdentity);
});

function inspectionFixture() {
  const root = directories.make("sqlite-custodied-inspection-");
  const source = path.join(root, "source.sqlite");
  const cache = path.join(root, "cache");
  fs.mkdirSync(cache);
  vi.stubEnv("XDG_CACHE_HOME", cache);
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(source);
  db.exec(
    "PRAGMA journal_mode=DELETE; CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES ('preserved')",
  );
  db.close();
  return { root, source, DatabaseSync };
}

it.each(["no custody", "live authority", "WAL", "journal"])(
  "keeps a private inspection snapshot with %s",
  async (condition) => {
    const { source, DatabaseSync } = inspectionFixture();
    const writer = condition === "WAL" ? new DatabaseSync(source) : undefined;
    writer?.exec("PRAGMA journal_mode=WAL; UPDATE probe SET value = 'committed in WAL'");
    if (condition === "journal") {
      fs.writeFileSync(source + "-journal", "");
    }
    const scope = createOpenClawDatabaseMaintenanceScope({
      schemaMaintenance: true,
      assertOwnerCurrent() {},
      assertDatabaseAccess(databasePath) {
        expect(databasePath).toBe(source);
      },
    });
    let location: string | null = null;
    const inspect = () =>
      withArtifactPreservingStateReads(
        () => {
          const db = openSqliteReadOnlyDatabase(source);
          try {
            location = db.location();
            expect(location).not.toBe(source);
            expect(db.prepare("SELECT value FROM probe").get()).toEqual({
              value: condition === "WAL" ? "committed in WAL" : "preserved",
            });
          } finally {
            db.close();
          }
        },
        { agentDatabases: true },
      );
    try {
      if (condition === "no custody") {
        inspect();
      } else {
        scope.run(() => {
          if (condition === "live authority") {
            admitOpenClawMaintenanceLiveAuthorityReads(source);
          }
          inspect();
        });
      }
      expect(location).not.toBeNull();
      expect(fs.existsSync(location!)).toBe(false);
    } finally {
      writer?.close();
      await scope.close();
    }
  },
);

it.each(["inode", "size", "mtime", "WAL", "journal", "custody"])(
  "rejects a changed %s when the in-place inspection closes",
  async (changed) => {
    const { source, root } = inspectionFixture();
    const scope = createOpenClawDatabaseMaintenanceScope({
      schemaMaintenance: true,
      assertOwnerCurrent() {},
      assertDatabaseAccess(databasePath) {
        expect(databasePath).toBe(source);
      },
    });
    try {
      expect(() =>
        scope.run(() =>
          withArtifactPreservingStateReads(
            () => {
              const db = openSqliteReadOnlyDatabase(source);
              expect(db.prepare("SELECT value FROM probe").get()).toEqual({ value: "preserved" });
              if (changed === "inode") {
                const successor = path.join(root, "successor.sqlite");
                fs.copyFileSync(source, successor);
                fs.renameSync(source, path.join(root, "original.sqlite"));
                fs.renameSync(successor, source);
              } else if (changed === "size") {
                fs.appendFileSync(source, "changed");
              } else if (changed === "mtime") {
                const changedTime = new Date(Date.now() + 60_000);
                fs.utimesSync(source, changedTime, changedTime);
              } else if (changed === "custody") {
                admitOpenClawMaintenanceLiveAuthorityReads(source);
              } else {
                fs.writeFileSync(source + (changed === "WAL" ? "-wal" : "-journal"), "changed");
              }
              db.close();
            },
            { agentDatabases: true },
          ),
        ),
      ).toThrow(/source changed during in-place inspection/);
    } finally {
      await scope.close();
    }
  },
);
