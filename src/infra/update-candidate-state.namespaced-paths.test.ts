import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runCommandBuffered } from "../process/exec.js";
import {
  closeOpenClawStateDatabaseByPath,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import {
  type snapshotUpdateCandidateState,
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
    // The namespaced registration dedupes to the database's plain spelling.
    expect(versions.map((entry) => entry.path)).toContain(canonical);
    expect(versions.map((entry) => entry.path)).not.toContain(namespaced);
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
