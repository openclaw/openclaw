import type fs from "node:fs";
import { formatErrorMessage } from "../infra/errors.js";
import { isStateDatabaseReadAdmissionInvalidatedError } from "../state/openclaw-state-db-async-lifecycle.js";
import { appendConfigAuditRecord, appendConfigAuditRecordSync } from "./io.audit.js";
import {
  captureConfigHealthStateStore,
  supersedeConfigHealthObservations,
  readConfigHealthStateFromStore,
  patchConfigHealthEntryToStore,
} from "./io.health-state.js";
import type {
  ConfigHealthEntry,
  ConfigHealthFingerprint,
  ConfigHealthSnapshot,
  ConfigHealthState,
} from "./io.health-state.types.js";
import {
  createConfigHealthFingerprint,
  createConfigObserveAuditRecord,
  readConfigFingerprintForPath,
  readConfigFingerprintForPathSync,
  readConfigHealthEntry,
} from "./io.observe-state.js";
import { resolveConfigObserveSuspiciousReasons } from "./io.observe-suspicious.js";
import type { NormalizedConfigIoDeps } from "./io.types.js";
import type { ConfigFileSnapshot } from "./types.js";

function sameFingerprint(
  left: ConfigHealthFingerprint | undefined,
  right: ConfigHealthFingerprint,
): boolean {
  if (!left) {
    return false;
  }
  return (
    left.hash === right.hash &&
    left.bytes === right.bytes &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.hasMeta === right.hasMeta &&
    left.gatewayMode === right.gatewayMode
  );
}

function createObservedFingerprint(snapshot: ConfigFileSnapshot, stat: fs.Stats | null) {
  const raw = snapshot.raw as string;
  return createConfigHealthFingerprint({
    raw,
    parsed: snapshot.parsed,
    resolved: snapshot.resolved,
    stat,
  });
}

function resolveObservation(params: {
  snapshot: ConfigFileSnapshot;
  current: ConfigHealthFingerprint;
  healthState: ConfigHealthState;
  backupBaseline?: ConfigHealthFingerprint;
}) {
  const entry = readConfigHealthEntry(params.healthState, params.snapshot.path);
  const baseline = entry.lastKnownGood ?? params.backupBaseline;
  const suspicious = resolveConfigObserveSuspiciousReasons({
    bytes: params.current.bytes,
    hasMeta: params.current.hasMeta,
    gatewayMode: params.current.gatewayMode,
    parsed: params.snapshot.parsed,
    lastKnownGood: baseline,
  });
  return { entry, baseline, suspicious };
}

function resolveHealthyObservationChanges(params: {
  snapshot: ConfigFileSnapshot;
  current: ConfigHealthFingerprint;
  entry: ConfigHealthEntry;
}): Pick<ConfigHealthEntry, "lastKnownGood" | "lastObservedSuspiciousSignature"> | null {
  if (!params.snapshot.valid) {
    return null;
  }
  const changes = { lastKnownGood: params.current, lastObservedSuspiciousSignature: null };
  return !sameFingerprint(params.entry.lastKnownGood, params.current) ||
    params.entry.lastObservedSuspiciousSignature !== null
    ? changes
    : null;
}

export async function observeConfigSnapshot(
  deps: NormalizedConfigIoDeps,
  snapshot: ConfigFileSnapshot,
  assertCurrent?: () => void,
): Promise<void> {
  if (!snapshot.exists || typeof snapshot.raw !== "string") {
    return;
  }
  assertCurrent?.();
  try {
    using health = captureConfigHealthStateStore(deps, snapshot.path, assertCurrent);
    const stat = await deps.fs.promises.stat(snapshot.path).catch(() => null);
    if (!health.isCurrent()) {
      return;
    }
    const current = createObservedFingerprint(snapshot, stat);
    const healthSnapshot = await health.read();
    if (!healthSnapshot) {
      return;
    }
    const healthState = healthSnapshot.state;
    const backupPath = `${snapshot.path}.bak`;
    const initialEntry = readConfigHealthEntry(healthState, snapshot.path);
    const backupBaseline =
      initialEntry.lastKnownGood ??
      (await readConfigFingerprintForPath(deps, backupPath)) ??
      undefined;
    if (!health.isCurrent()) {
      return;
    }
    const { entry, baseline, suspicious } = resolveObservation({
      snapshot,
      current,
      healthState,
      backupBaseline,
    });
    if (suspicious.length === 0) {
      const changes = resolveHealthyObservationChanges({ snapshot, current, entry });
      if (changes) {
        await health.update(changes, healthSnapshot);
      }
      return;
    }
    const signature = `${current.hash}:${suspicious.join(",")}`;
    if (entry.lastObservedSuspiciousSignature === signature) {
      return;
    }
    const backup =
      (baseline?.hash ? baseline : null) ?? (await readConfigFingerprintForPath(deps, backupPath));
    if (!health.isCurrent()) {
      return;
    }
    deps.logger.warn(`Config observe anomaly: ${snapshot.path} (${suspicious.join(", ")})`);
    await appendConfigAuditRecord(
      {
        env: deps.env,
        homedir: deps.homedir,
        record: createConfigObserveAuditRecord({
          configPath: snapshot.path,
          valid: snapshot.valid,
          current,
          suspicious,
          lastKnownGood: entry.lastKnownGood,
          backup,
        }),
      },
      assertCurrent,
    );
    await health.update({ lastObservedSuspiciousSignature: signature }, healthSnapshot);
  } catch (error) {
    if (isStateDatabaseReadAdmissionInvalidatedError(error)) {
      return;
    }
    throw error;
  }
}

/**
 * Compensation record published by {@link advanceConfigHealthBaselineForAcceptedWrite}
 * so a rolled-back write can restore the health baseline it replaced.
 */
export type ConfigHealthBaselineCompensation = {
  configPath: string;
  candidate: ConfigHealthFingerprint;
  previousLastKnownGood: ConfigHealthFingerprint;
  previousSuspiciousSignature: string | null;
};

/**
 * Pre-publication last-known-good facts the writer captures before publishing
 * the candidate file, so a rolled-back write can restore the baseline that
 * existed before the write even when an intervening observed read records the
 * published candidate as healthy first.
 */
export type ConfigHealthBaselineCapture = {
  configPath: string;
  previousLastKnownGood: ConfigHealthFingerprint;
  previousSuspiciousSignature: string | null;
};

/**
 * Bounded attempts for write-owned health transitions. An ordinary observed read
 * can supersede the scope a transition captured while it awaits the worker, and
 * a competing observation can win the conditional write the transition then
 * issues; the accepted write this bookkeeping belongs to has already succeeded,
 * so the transition re-captures a fresh scope and re-reads the persisted
 * snapshot instead of being discarded. The bound keeps a stream of competing
 * observations from spinning forever.
 */
const CONFIG_HEALTH_TRANSITION_ATTEMPTS = 4;

/**
 * Run a write-owned config-health transition until it settles. The callback
 * re-evaluates its guard against the freshly read snapshot and returns
 * `"retry"` whenever a supersession or a lost compare-and-set means the state
 * it observed is no longer authoritative.
 */
async function settleConfigHealthTransition(
  deps: NormalizedConfigIoDeps,
  configPath: string,
  transition: (
    store: ReturnType<typeof captureConfigHealthStateStore>,
    snapshot: ConfigHealthSnapshot,
  ) => Promise<"settled" | "retry">,
): Promise<boolean> {
  for (let attempt = 0; attempt < CONFIG_HEALTH_TRANSITION_ATTEMPTS; attempt += 1) {
    using store = captureConfigHealthStateStore(deps, configPath);
    const healthSnapshot = await store.read();
    if (!healthSnapshot) {
      // Superseded by a competing observation while awaiting the worker: the
      // write still stands, so capture a fresh scope and re-evaluate.
      continue;
    }
    if ((await transition(store, healthSnapshot)) === "settled") {
      return true;
    }
  }
  return false;
}

/**
 * Capture the pre-publication last-known-good baseline on the worker-backed
 * health owner. The writer calls this before publishing the candidate file;
 * {@link advanceConfigHealthBaselineForAcceptedWrite} settles the capture once
 * the write commits. Reading the baseline only after publication would let an
 * intervening observed read (which records the freshly published candidate as
 * healthy) replace the pre-write baseline the compensation must restore.
 * Best-effort: health metadata failures never fail the accepted write, and
 * returns null when no baseline exists yet (nothing to advance from).
 */
export async function captureConfigHealthBaselineForWrite(
  deps: NormalizedConfigIoDeps,
  configPath: string,
): Promise<ConfigHealthBaselineCapture | null> {
  try {
    let capture: ConfigHealthBaselineCapture | null = null;
    const settled = await settleConfigHealthTransition(
      deps,
      configPath,
      async (_store, healthSnapshot) => {
        const entry = readConfigHealthEntry(healthSnapshot.state, configPath);
        capture = entry.lastKnownGood
          ? {
              configPath,
              previousLastKnownGood: entry.lastKnownGood,
              previousSuspiciousSignature: entry.lastObservedSuspiciousSignature ?? null,
            }
          : null;
        return "settled";
      },
    );
    return settled ? capture : null;
  } catch (error) {
    deps.logger.warn(
      `Config last-known-good baseline capture failed: ${formatErrorMessage(error)}`,
    );
    return null;
  }
}

/**
 * Advance the last-known-good baseline after the config owner accepts a write.
 * Accepted writes include formatting normalization that shrinks raw bytes and
 * intentionally permitted size drops (`allowConfigSizeDrop`); the writer
 * validated and committed them, so their result becomes the new promotion
 * baseline. Stub-shaped results (missing meta, missing gateway mode,
 * update-channel-only root) keep the older baseline so external truncations
 * stay rejected by promotion and observation. The capture must come from
 * {@link captureConfigHealthBaselineForWrite} before the write published its
 * candidate. Persistence runs on the worker-backed health owner, so ordinary
 * live writes never execute SQLite on the Gateway thread. Best-effort: health
 * metadata failures never fail the accepted write, and the compensation is
 * still published when the update cannot land because the conditional restore
 * skips it unless the persisted baseline matches the candidate. Returns the
 * compensation record the writer uses to restore the baseline if the committed
 * write later rolls back. Absorbs ordinary observation supersession by
 * re-reading and re-applying its guard, so the accepted write's baseline is
 * never silently dropped, while a baseline that is neither the pre-write value
 * nor this candidate (a newer decision) stays preserved.
 */
export async function advanceConfigHealthBaselineForAcceptedWrite(
  deps: NormalizedConfigIoDeps,
  capture: ConfigHealthBaselineCapture | null,
  params: {
    raw: string;
    parsed: unknown;
    resolved?: unknown;
  },
): Promise<ConfigHealthBaselineCompensation | null> {
  if (!capture) {
    return null;
  }
  const baseline = capture;
  let compensation: ConfigHealthBaselineCompensation | null = null;
  try {
    const stat = await deps.fs.promises.stat(baseline.configPath).catch(() => null);
    const current = createConfigHealthFingerprint({
      raw: params.raw,
      parsed: params.parsed,
      resolved: params.resolved,
      stat,
    });
    const suspicious = resolveConfigObserveSuspiciousReasons({
      bytes: current.bytes,
      hasMeta: current.hasMeta,
      gatewayMode: current.gatewayMode,
      parsed: params.parsed,
      lastKnownGood: baseline.previousLastKnownGood,
    });
    if (suspicious.some((reason) => !reason.startsWith("size-drop-vs-last-good:"))) {
      return null;
    }
    compensation = {
      configPath: baseline.configPath,
      candidate: current,
      previousLastKnownGood: baseline.previousLastKnownGood,
      previousSuspiciousSignature: baseline.previousSuspiciousSignature,
    };
    const settled = await settleConfigHealthTransition(
      deps,
      baseline.configPath,
      async (store, healthSnapshot) => {
        const entry = readConfigHealthEntry(healthSnapshot.state, baseline.configPath);
        const persisted = entry.lastKnownGood;
        // A baseline that is neither the pre-write baseline nor this write's
        // candidate is a newer, valid decision: preserve it untouched.
        if (
          persisted &&
          persisted.hash !== baseline.previousLastKnownGood.hash &&
          persisted.hash !== current.hash
        ) {
          return "settled";
        }
        if (persisted?.hash === current.hash && entry.lastObservedSuspiciousSignature == null) {
          return "settled";
        }
        await store.updateAfterFileCommit(
          { lastKnownGood: current, lastObservedSuspiciousSignature: null },
          healthSnapshot,
        );
        // A competing observation can still supersede the scope at the worker
        // or win the conditional write; re-read and re-evaluate rather than
        // dropping the accepted write's baseline.
        const after = await store.read();
        if (!after) {
          return "retry";
        }
        const afterEntry = readConfigHealthEntry(after.state, baseline.configPath);
        return afterEntry.lastKnownGood?.hash === current.hash &&
          afterEntry.lastObservedSuspiciousSignature == null
          ? "settled"
          : "retry";
      },
    );
    if (!settled) {
      deps.logger.warn(
        `Config last-known-good baseline advance did not settle: ${baseline.configPath}`,
      );
    }
    return compensation;
  } catch (error) {
    deps.logger.warn(
      `Config last-known-good baseline advance failed: ${formatErrorMessage(error)}`,
    );
    return compensation;
  }
}

/**
 * Restore the last-known-good baseline captured before an accepted write when
 * that write's runtime activation fails and the committed file rolls back.
 * The rolled-back bytes are the pre-write config, so keeping the candidate
 * baseline would make the next promotion reject the valid restored file as a
 * size drop. Newer observations win: the restore is skipped when the persisted
 * baseline no longer matches the candidate this writer published (a candidate
 * recorded by an intervening observed read matches by raw hash and is still
 * restored). Best-effort: health metadata failures never fail the rollback.
 * Absorbs ordinary observation supersession the same way as the accepted-write
 * advance, so a superseded rollback compensation still lands while newer
 * baselines stay preserved.
 */
export async function restoreConfigHealthBaselineForRolledBackWrite(
  deps: NormalizedConfigIoDeps,
  compensation: ConfigHealthBaselineCompensation | null,
): Promise<void> {
  if (!compensation) {
    return;
  }
  const record = compensation;
  try {
    const settled = await settleConfigHealthTransition(
      deps,
      record.configPath,
      async (store, healthSnapshot) => {
        const entry = readConfigHealthEntry(healthSnapshot.state, record.configPath);
        // Newer observations win, and this also covers an already-restored
        // baseline: only the candidate this writer published is compensable.
        if (entry.lastKnownGood?.hash !== record.candidate.hash) {
          return "settled";
        }
        await store.updateAfterFileCommit(
          {
            lastKnownGood: record.previousLastKnownGood,
            // Only rewind the anomaly marker when nothing newer recorded one.
            ...(entry.lastObservedSuspiciousSignature == null
              ? { lastObservedSuspiciousSignature: record.previousSuspiciousSignature }
              : {}),
          },
          healthSnapshot,
        );
        const after = await store.read();
        if (!after) {
          return "retry";
        }
        return readConfigHealthEntry(after.state, record.configPath).lastKnownGood?.hash ===
          record.previousLastKnownGood.hash
          ? "settled"
          : "retry";
      },
    );
    if (!settled) {
      deps.logger.warn(
        `Config last-known-good baseline restore did not settle: ${record.configPath}`,
      );
    }
  } catch (error) {
    deps.logger.warn(
      `Config last-known-good baseline restore failed: ${formatErrorMessage(error)}`,
    );
  }
}

export function observeConfigSnapshotSync(
  deps: NormalizedConfigIoDeps,
  snapshot: ConfigFileSnapshot,
): void {
  if (!snapshot.exists || typeof snapshot.raw !== "string") {
    return;
  }
  supersedeConfigHealthObservations(deps, snapshot.path);
  const stat = deps.fs.statSync(snapshot.path, { throwIfNoEntry: false }) ?? null;
  const current = createObservedFingerprint(snapshot, stat);
  const healthState = readConfigHealthStateFromStore(deps);
  const backupPath = `${snapshot.path}.bak`;
  const initialEntry = readConfigHealthEntry(healthState, snapshot.path);
  const backupBaseline =
    initialEntry.lastKnownGood ?? readConfigFingerprintForPathSync(deps, backupPath) ?? undefined;
  const { entry, baseline, suspicious } = resolveObservation({
    snapshot,
    current,
    healthState,
    backupBaseline,
  });
  if (suspicious.length === 0) {
    const changes = resolveHealthyObservationChanges({ snapshot, current, entry });
    if (changes) {
      patchConfigHealthEntryToStore(deps, snapshot.path, changes);
    }
    return;
  }
  const signature = `${current.hash}:${suspicious.join(",")}`;
  if (entry.lastObservedSuspiciousSignature === signature) {
    return;
  }
  const backup =
    (baseline?.hash ? baseline : null) ?? readConfigFingerprintForPathSync(deps, backupPath);
  deps.logger.warn(`Config observe anomaly: ${snapshot.path} (${suspicious.join(", ")})`);
  appendConfigAuditRecordSync({
    env: deps.env,
    homedir: deps.homedir,
    record: createConfigObserveAuditRecord({
      configPath: snapshot.path,
      valid: snapshot.valid,
      current,
      suspicious,
      lastKnownGood: entry.lastKnownGood,
      backup,
    }),
  });
  patchConfigHealthEntryToStore(deps, snapshot.path, {
    lastObservedSuspiciousSignature: signature,
  });
}
