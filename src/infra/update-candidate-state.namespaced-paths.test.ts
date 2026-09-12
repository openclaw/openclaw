import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runCommandBuffered } from "../process/exec.js";
import { readStateSchemaContentVersion } from "../state/openclaw-state-db-schema-version.js";
import {
  closeOpenClawStateDatabaseByPath,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { readSqliteUserVersion } from "./sqlite-user-version.js";
import {
  readUpdateStateSchemaVersions,
  type snapshotUpdateCandidateState,
  updateStateSchemaVersionsMatch,
  UpdateCandidateStateSnapshotSchema,
} from "./update-candidate-state.js";

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "candidate-state-paths-")));
});
afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await fs.rm(root, { recursive: true, force: true });
});

async function createDatabase(file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const db = openNodeSqliteDatabase(file);
  try {
    db.exec(
      "PRAGMA user_version = 3; CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES ('preserved');",
    );
  } finally {
    db.close();
  }
}

async function runSnapshotWorker(
  input: Omit<Parameters<typeof snapshotUpdateCandidateState>[0], "candidateRoot">,
) {
  // Backup/VACUUM cannot be cancelled in-process; use the canary's worker before fixture cleanup.
  const result = await runCommandBuffered(
    [
      process.execPath,
      ...resolveRuntimeWorkerArgv(
        resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.updateCandidateState),
      ),
    ],
    {
      input: JSON.stringify({
        ...input,
        candidateRoot: path.join(root, "candidate-host"),
        mode: "snapshot",
      }),
      timeoutMs: 30_000,
      killGraceMs: 500,
      maxOutputBytes: { stdout: 1024 * 1024, stderr: 20_000 },
    },
  );
  expect(result.code, result.stderr.toString("utf8")).toBe(0);
  return UpdateCandidateStateSnapshotSchema.parse(JSON.parse(result.stdout.toString("utf8")))
    .versions;
}

// Windows registries can carry extended-length \\?\ agent paths (issue #144581):
// projection must rebase them under the candidate root instead of embedding the
// namespace prefix mid-path and failing the snapshot mkdir.
it.skipIf(process.platform !== "win32")(
  "projects extended-length registered agent paths under the candidate state root",
  async () => {
    const source = path.join(root, "source");
    const target = path.join(root, "copy");
    const canonical = path.join(source, "agents", "main", "agent", "openclaw-agent.sqlite");
    await createDatabase(canonical);
    const namespaced = `\\\\?\\${canonical}`;
    const registry = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: source } }).db;
    registry
      .prepare(
        "INSERT INTO agent_databases (agent_id, path, schema_version, last_seen_at) VALUES (?, ?, 3, 0)",
      )
      .run("main", namespaced);
    closeOpenClawStateDatabaseByPath(path.join(source, "state", "openclaw.sqlite"));
    const versions = await runSnapshotWorker({
      stateDir: source,
      targetStateDir: target,
      config: {},
    });
    // The physical copy dedupes to one identity, but the published versions
    // keep every raw alias so released mixed-alias baselines still match.
    expect(versions.map((entry) => entry.path)).toContain(canonical);
    expect(versions.map((entry) => entry.path)).toContain(namespaced);
    const copied = openNodeSqliteDatabase(
      path.join(target, "agents", "main", "agent", "openclaw-agent.sqlite"),
    );
    expect(copied.prepare("SELECT value FROM evidence").get()).toMatchObject({
      value: "preserved",
    });
    copied.close();
    const copiedRegistry = openNodeSqliteDatabase(path.join(target, "state", "openclaw.sqlite"));
    const rebound = copiedRegistry
      .prepare("SELECT path FROM agent_databases WHERE agent_id = 'main'")
      .get() as { path: string };
    copiedRegistry.close();
    expect(path.isAbsolute(rebound.path)).toBe(false);
    expect(rebound.path.split(/[\\/]/)).toEqual([
      "agents",
      "main",
      "agent",
      "openclaw-agent.sqlite",
    ]);
  },
);

// A namespaced registration outside the state root must keep one projection
// identity: the copy and the rebound registry entry must name the same hashed
// candidate-external destination.
it.skipIf(process.platform !== "win32")(
  "keeps a namespaced external registered database on one hashed projection identity",
  async () => {
    const source = path.join(root, "source");
    const target = path.join(root, "copy");
    const external = path.join(root, "external", "openclaw-agent.sqlite");
    await createDatabase(external);
    const namespacedExternal = `\\\\?\\${external}`;
    const registry = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: source } }).db;
    registry
      .prepare(
        "INSERT INTO agent_databases (agent_id, path, schema_version, last_seen_at) VALUES (?, ?, 3, 0)",
      )
      .run("external", namespacedExternal);
    closeOpenClawStateDatabaseByPath(path.join(source, "state", "openclaw.sqlite"));
    await runSnapshotWorker({
      stateDir: source,
      targetStateDir: target,
      config: {},
    });
    const copiedRegistry = openNodeSqliteDatabase(path.join(target, "state", "openclaw.sqlite"));
    const rebound = copiedRegistry
      .prepare("SELECT path FROM agent_databases WHERE agent_id = 'external'")
      .get() as { path: string };
    copiedRegistry.close();
    expect(path.isAbsolute(rebound.path)).toBe(false);
    expect(rebound.path).toMatch(/^candidate-external/);
    // The rebound registry entry must name the database the snapshot copied.
    const copied = openNodeSqliteDatabase(path.join(target, rebound.path));
    expect(copied.prepare("SELECT value FROM evidence").get()).toMatchObject({
      value: "preserved",
    });
    copied.close();
  },
);

// A noncanonical in-root registration (dot segments) is not eligible for
// rebasing: the copy and the rebound registry entry must keep the raw
// locator's hashed candidate-external destination.
it.skipIf(process.platform !== "win32")(
  "keeps a noncanonical in-root registered database on its raw projection identity",
  async () => {
    const source = path.join(root, "source");
    const target = path.join(root, "copy");
    const canonical = path.join(source, "agents", "main", "agent", "openclaw-agent.sqlite");
    await createDatabase(canonical);
    const noncanonical =
      source + path.sep + ["agents", "main", ".", "agent", "openclaw-agent.sqlite"].join(path.sep);
    const registry = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: source } }).db;
    registry
      .prepare(
        "INSERT INTO agent_databases (agent_id, path, schema_version, last_seen_at) VALUES (?, ?, 3, 0)",
      )
      .run("main", noncanonical);
    closeOpenClawStateDatabaseByPath(path.join(source, "state", "openclaw.sqlite"));
    await runSnapshotWorker({
      stateDir: source,
      targetStateDir: target,
      config: {},
    });
    const copiedRegistry = openNodeSqliteDatabase(path.join(target, "state", "openclaw.sqlite"));
    const rebound = copiedRegistry
      .prepare("SELECT path FROM agent_databases WHERE agent_id = 'main'")
      .get() as { path: string };
    copiedRegistry.close();
    expect(path.isAbsolute(rebound.path)).toBe(false);
    expect(rebound.path).toMatch(/^candidate-external/);
    // The rebound registry entry must name the database the snapshot copied.
    const copied = openNodeSqliteDatabase(path.join(target, rebound.path));
    expect(copied.prepare("SELECT value FROM evidence").get()).toMatchObject({
      value: "preserved",
    });
    copied.close();
  },
);

// With an extended-length state root, directory discovery queues the
// namespaced spelling while a relative registration resolves to the same
// database; both must dedupe to one copy at one projection identity.
it.skipIf(process.platform !== "win32")(
  "dedupes a relative registration under a namespaced state root",
  async () => {
    const plainState = path.join(root, "source");
    const namespacedState = `\\\\?\\${plainState}`;
    const target = path.join(root, "copy");
    const canonical = path.join(plainState, "agents", "main", "agent", "openclaw-agent.sqlite");
    await createDatabase(canonical);
    const registry = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: plainState } }).db;
    registry
      .prepare(
        "INSERT INTO agent_databases (agent_id, path, schema_version, last_seen_at) VALUES (?, ?, 3, 0)",
      )
      .run("main", path.join("agents", "main", "agent", "openclaw-agent.sqlite"));
    closeOpenClawStateDatabaseByPath(path.join(plainState, "state", "openclaw.sqlite"));
    const inspected = await readUpdateStateSchemaVersions({
      stateDir: namespacedState,
      config: {},
    });
    // Older updaters captured rollback baselines with the namespaced spelling;
    // versions-mode responses must keep that path identity.
    const namespacedDb =
      namespacedState +
      path.sep +
      ["agents", "main", "agent", "openclaw-agent.sqlite"].join(path.sep);
    expect(inspected.map((entry) => entry.path)).toContain(namespacedDb);
    expect(inspected.map((entry) => entry.path)).not.toContain(canonical);
    const versions = await runSnapshotWorker({
      stateDir: namespacedState,
      targetStateDir: target,
      config: {},
    });
    // Snapshot mode reports the same legacy identities for the deduped copy.
    expect(versions).toEqual(inspected);
    const copiedRegistry = openNodeSqliteDatabase(path.join(target, "state", "openclaw.sqlite"));
    const rebound = copiedRegistry
      .prepare("SELECT path FROM agent_databases WHERE agent_id = 'main'")
      .get() as { path: string };
    copiedRegistry.close();
    expect(path.isAbsolute(rebound.path)).toBe(false);
    // The rebound registry entry must name exactly the one copied database.
    const copied = openNodeSqliteDatabase(path.join(target, rebound.path));
    expect(copied.prepare("SELECT value FROM evidence").get()).toMatchObject({
      value: "preserved",
    });
    copied.close();
  },
);

// Released 2026.9.3/2026.9.4 workers reported every discovered spelling, so a
// host whose registry carries both a relative row and a \\?\-prefixed row for
// one database produced a mixed-alias versions baseline. The released Doctor
// update path compares those exact paths against the candidate's response:
// the candidate must publish every raw alias while still deduping the physical
// snapshot copies, or the schema comparison fails on exactly the Windows
// installs this fix targets.
it.skipIf(process.platform !== "win32")(
  "keeps every raw alias in the versions response for a released mixed-alias baseline",
  async () => {
    const source = path.join(root, "source");
    const target = path.join(root, "copy");
    const canonical = path.join(source, "agents", "main", "agent", "openclaw-agent.sqlite");
    await createDatabase(canonical);
    const namespaced = `\\\\?\\${canonical}`;
    const shared = path.join(source, "state", "openclaw.sqlite");
    const registry = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: source } }).db;
    const insert = registry.prepare(
      "INSERT INTO agent_databases (agent_id, path, schema_version, last_seen_at) VALUES (?, ?, 3, 0)",
    );
    insert.run("main", path.join("agents", "main", "agent", "openclaw-agent.sqlite"));
    insert.run("main", namespaced);
    closeOpenClawStateDatabaseByPath(shared);
    // Hand-built to mirror a released worker's response: every discovered
    // spelling, with versions read straight from the physical databases rather
    // than from a patched worker's response.
    const sharedDb = openNodeSqliteDatabase(shared, { readOnly: true });
    const releasedBaseline = [
      {
        path: shared,
        userVersion: readSqliteUserVersion(sharedDb),
        contentVersion: readStateSchemaContentVersion(sharedDb),
      },
      { path: canonical, userVersion: 3 },
      { path: namespaced, userVersion: 3 },
    ];
    sharedDb.close();
    const inspected = await readUpdateStateSchemaVersions({
      stateDir: source,
      config: {},
    });
    expect(inspected.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([shared, canonical, namespaced]),
    );
    expect(inspected).toHaveLength(3);
    expect(
      updateStateSchemaVersionsMatch(releasedBaseline, inspected, { sharedPath: shared }),
    ).toBe(true);
    const versions = await runSnapshotWorker({
      stateDir: source,
      targetStateDir: target,
      config: {},
    });
    // Snapshot mode publishes the same aliases but copies each database once.
    expect(versions).toEqual(inspected);
    const copied = openNodeSqliteDatabase(
      path.join(target, "agents", "main", "agent", "openclaw-agent.sqlite"),
    );
    expect(copied.prepare("SELECT value FROM evidence").get()).toMatchObject({
      value: "preserved",
    });
    copied.close();
  },
);
