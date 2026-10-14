import { randomUUID } from "node:crypto";
import path from "node:path";
import { normalizeProfileName } from "../cli/profile-utils.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { decodeUpdateRecovery, type UpdateRecoveryRecord } from "./update-run-recovery-schema.js";

/** Fixture construction only: writes synthetic retained bytes into a disposable test database.
 * No capture, claim, replay, native operation, or runtime publication implementation. */
export function storeRetainedUpdateRecovery(
  record: UpdateRecoveryRecord,
  options: OpenClawStateDatabaseOptions,
) {
  const parsed = decodeUpdateRecovery(JSON.stringify(record), record.runId);
  const raw = JSON.stringify(parsed);
  openOpenClawStateDatabase(options)
    .db.prepare(
      "INSERT INTO config_machine_state (state_key,value_json,updated_at_ms) VALUES (?,?,?) ON CONFLICT(state_key) DO UPDATE SET value_json=excluded.value_json,updated_at_ms=excluded.updated_at_ms",
    )
    .run("update.recovery." + record.runId, raw, record.updatedAtMs);
  return parsed;
}

export function createRetainedUpdateRecovery(
  input: Pick<UpdateRecoveryRecord, "runId" | "from" | "to">,
  options: OpenClawStateDatabaseOptions = {},
): UpdateRecoveryRecord {
  const env = options.env ?? process.env;
  const stateDir = resolveStateDir(env);
  const now = Date.now();
  return storeRetainedUpdateRecovery(
    {
      ...input,
      source: {
        stateDir,
        configPath: resolveConfigPath(env, stateDir),
        profile: normalizeProfileName(env.OPENCLAW_PROFILE),
      },
      transactionId: randomUUID(),
      revision: 0,
      claimId: randomUUID(),
      claimKind: "initial",
      handoff: null,
      createdAtMs: now,
      updatedAtMs: now,
      effects: [],
      restore: null,
      verification: null,
      primaryFailure: null,
    },
    options,
  );
}

/** A static historical receipt, deliberately not a proof producer. */
export function retainedReadinessRecord(
  record: UpdateRecoveryRecord,
  runtime: "candidate" | "previous" = "candidate",
): UpdateRecoveryRecord {
  const effectId = randomUUID();
  const identity = runtime === "candidate" ? record.to : record.from;
  return {
    ...record,
    revision: 3,
    effects: [
      {
        effectId,
        kind: "service-restart",
        resourceId: "gateway",
        runtime,
        state: "observed",
        observedIdentity: "retained-boot",
      },
    ],
    verification: {
      runtime,
      effectId,
      receipt: {
        kind: "readiness",
        runId: record.runId,
        transactionId: record.transactionId,
        claimId: record.claimId,
        revision: 2,
        effectId,
        runtime,
        gateway: { bootId: "retained-boot", version: identity.version, buildId: identity.buildId },
        checks: {
          serviceRunning: true,
          pluginsReady: true,
          channelsReady: true,
          settled: true,
          readyz: true,
        },
        verifiedAtMs: record.updatedAtMs,
      },
    },
  };
}

/** Exact old serialized package roles for inspection/refusal fixtures. Never a live owner. */
export function retainedTerminalRecord(
  record: UpdateRecoveryRecord,
  rollback = false,
): UpdateRecoveryRecord {
  const next = retainedReadinessRecord(record, rollback ? "previous" : "candidate");
  const pairId = rollback ? null : randomUUID();
  const descriptor = {
    version: 1 as const,
    transactionId: record.transactionId,
    packageName: "openclaw",
    liveRoot: path.join(record.source!.stateDir, "node_modules", "openclaw"),
    stageRoot: path.join(record.source!.stateDir, "stage"),
    backupRoot: path.join(record.source!.stateDir, "node_modules", ".openclaw.package-backup-test"),
    binDir: path.join(record.source!.stateDir, "bin"),
    shimBackupRoot: null,
    shimBackupIdentity: null,
    previous: { digest: "a".repeat(64), identity: "1:2", version: record.from.version },
    candidate: { digest: "b".repeat(64), identity: "1:3", version: record.to.version },
    launchers: [],
    interruptedLaunchers: [],
    retention: pairId
      ? { state: "selected" as const, pairId, ownerRevision: 4 }
      : { state: "unselected" as const, ownerRevision: 4 },
  };
  next.revision = 4;
  next.package = {
    descriptor,
    observed: {
      status: "verified",
      descriptor,
      observedIdentity: "c".repeat(64),
      observation: {
        previous: rollback ? "live" : "retained",
        candidate: rollback ? "displaced" : "live",
        launchers: "both",
        successorLive: false,
      },
    },
  };
  next.terminal = {
    status: rollback ? "rolled-back" : "succeeded",
    committedAtMs: next.updatedAtMs,
    commitRevision: 4,
    receipt: next.verification!.receipt,
    pairId,
  };
  if (pairId) {
    next.retainedPair = { pairId, state: "selected" };
  }
  return next;
}
