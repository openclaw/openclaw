import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withDaemonRuntimePinStore } from "../daemon/runtime-pin-store.js";
import { runCommandBuffered } from "../process/exec.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { UpdateCandidateStateSnapshotSchema } from "./update-candidate-state.js";
import { inventoryUpdateCandidateStateWorker } from "./update-candidate-state.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

async function runWorker(input: Record<string, unknown>): Promise<unknown> {
  const result = await runCommandBuffered(
    [
      process.execPath,
      ...resolveRuntimeWorkerArgv(
        resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.updateCandidateState),
      ),
    ],
    { input: JSON.stringify(input), timeoutMs: 30_000, killGraceMs: 500 },
  );
  expect(result.code, result.stderr.toString("utf8")).toBe(0);
  return JSON.parse(result.stdout.toString("utf8"));
}

it.each(["legacy", "local-aware"] as const)(
  "%s worker replies preserve local capture independently of schema visibility",
  async (caller) => {
    const root = await fs.realpath(dirs.make("update-local-schemas-"));
    const stateDir = path.join(root, "source");
    const targetStateDir = path.join(root, "snapshot");
    const shared = path.join(stateDir, "state", "openclaw.sqlite");
    const agent = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    const local = path.join(stateDir, "control", "services.sqlite");
    for (const [file, version] of [
      [shared, 7],
      [agent, 3],
    ] as const) {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      using db = openNodeSqliteDatabase(file);
      db.exec(`PRAGMA user_version = ${version}; CREATE TABLE evidence(value TEXT);`);
    }
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const intent = {
      state_key: "daemon-runtime-pin:raw",
      value_json: "{ malformed",
      updated_at_ms: 123,
    };
    withDaemonRuntimePinStore(env, true, (db) => {
      db.prepare("INSERT INTO daemon_runtime_pins VALUES (?, ?, ?)").run(
        intent.state_key,
        intent.value_json,
        intent.updated_at_ms,
      );
    });
    const input = {
      stateDir,
      targetStateDir,
      candidateRoot: root,
      config: {},
      env,
      ...(caller === "local-aware" ? { includeLocalStoreVersions: true } : {}),
    };
    const admitted = await inventoryUpdateCandidateStateWorker(input);
    expect(admitted.databaseInventory).toContain(local);
    const versions = UpdateCandidateStateSnapshotSchema.shape.versions.parse(
      await runWorker({ ...input, mode: "versions" }),
    );
    const snapshot = UpdateCandidateStateSnapshotSchema.parse(
      await runWorker({ ...input, ...admitted, mode: "snapshot" }),
    );
    const expected = [
      { path: agent, userVersion: 3 },
      ...(caller === "local-aware" ? [{ path: local, userVersion: 1 }] : []),
      { path: shared, userVersion: 7, contentVersion: 7 },
    ];
    expect(versions).toEqual(expected);
    expect(snapshot.versions).toEqual(expected);
    using copied = openNodeSqliteDatabase(path.join(targetStateDir, "control", "services.sqlite"), {
      readOnly: true,
    });
    expect(copied.prepare("SELECT * FROM daemon_runtime_pins").all()).toEqual([intent]);
  },
);
