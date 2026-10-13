import fs from "node:fs";
import path from "node:path";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { resolvePrivateSqliteSnapshotStagingRoot } from "./sqlite-private-directory.js";
import { cleanupSnapshotOperations } from "./sqlite-readonly-location-cleanup.js";
import type { RetainedSqliteSnapshotPreparation } from "./sqlite-readonly-location.types.js";
import { startSqliteReadOnlyLocationAsync } from "./sqlite-snapshot-source.js";
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
