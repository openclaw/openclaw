import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  createRetainedUpdateRecovery,
  storeRetainedUpdateRecovery,
} from "./update-retained-recovery.test-support.js";
import { createUpdateRun } from "./update-run-ledger.js";
import type { UpdateRecoveryRecord } from "./update-run-recovery.js";

/** Synthetic retained bytes, not a new capture/replay producer. Tests exercise
 * refusal of an existing journal even when its artifacts cannot be replayed. */
export function retainedCheckpointBinding(record: UpdateRecoveryRecord) {
  const checkpointId = randomUUID();
  return {
    ref: {
      checkpointId,
      manifestPath: path.join(record.source!.stateDir, "artifacts", checkpointId, "manifest.json"),
      manifestSha256: (record.preimages ? "b" : "a").repeat(64),
    },
    binding: {
      runId: record.runId,
      stateDir: record.source!.stateDir,
      configPath: record.source!.configPath,
      fromRuntime: {
        root: record.from.root,
        nodePath: record.from.nodePath,
        version: record.from.version,
      },
    },
    ...(record.preimages ? { preimageRef: record.preimages.ref } : {}),
  };
}

export function createRetainedCheckpointFixture(root: string, sealed = true) {
  const env = { HOME: root, OPENCLAW_STATE_DIR: root };
  const options = { env };
  const configPath = path.join(root, "openclaw.json");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(configPath, '{"gateway":{"port":18789}}\n');
  const run = { runId: createUpdateRun({ trigger: "cli" }, options).runId, env };
  const runtime = { root, nodePath: process.execPath, version: "1.0.0", buildId: null };
  const fence = { assertCurrent() {} };
  const record = createRetainedUpdateRecovery(
    { runId: run.runId, from: runtime, to: runtime },
    options,
  );
  record.checkpoint = retainedCheckpointBinding(record);
  record.primaryFailure = { code: "candidate-failed", effectId: null };
  record.effects = [
    {
      effectId: randomUUID(),
      kind: "checkpoint-restore",
      runtime: "previous",
      resourceId: record.checkpoint.ref.checkpointId,
      state: "intent",
      observedIdentity: null,
    },
  ];
  const restoreId = randomUUID();
  const artifactRoot = path.dirname(record.checkpoint!.ref.manifestPath);
  fs.mkdirSync(artifactRoot, { recursive: true });
  fs.writeFileSync(record.checkpoint!.ref.manifestPath, "retained unsupported manifest\n");
  record.restore = {
    restoreId,
    checkpointId: record.checkpoint!.ref.checkpointId,
    planPath: path.join(artifactRoot, "plan.json"),
    planSha256: sealed ? "b".repeat(64) : null,
    resourceCursor: 0,
    phase: sealed ? "intent" : "preparing",
  };
  fs.writeFileSync(record.restore.planPath, "retained unsupported plan\n");
  storeRetainedUpdateRecovery(record, options);
  const database = openOpenClawStateDatabase(options);
  const file = database.path;
  closeOpenClawStateDatabaseForTest();
  const displaced = path.join(path.dirname(file), `.openclaw-restore-${restoreId}-0`, "displaced");
  return {
    root,
    env,
    options,
    configPath,
    run,
    runtime,
    fence,
    record,
    file,
    displaced,
    displace() {
      closeOpenClawStateDatabaseForTest();
      fs.mkdirSync(path.dirname(displaced), { recursive: true });
      fs.renameSync(file, displaced);
    },
  };
}
