import type fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { formatErrorMessage } from "../infra/errors.js";
import { isStateDatabaseReadAdmissionInvalidatedError } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  appendConfigAuditRecord,
  appendConfigAuditRecordSync,
  createConfigObserveAuditRecord,
} from "./io.audit.js";
import {
  captureConfigHealthStateStore,
  supersedeConfigHealthObservations,
  readConfigHealthStateFromStore,
  patchConfigHealthEntryToStore,
} from "./io.health-state.js";
import type {
  ConfigHealthEntry,
  ConfigHealthFingerprint,
  ConfigHealthState,
  ConfigHealthSnapshot,
  ConfigHealthUpdateResult,
} from "./io.health-state.types.js";
import {
  createConfigHealthFingerprint,
  readConfigFingerprintForPath,
  readConfigFingerprintForPathSync,
  readConfigHealthEntry,
} from "./io.observe-state.js";
import {
  createInheritedConfigAnomalySignature,
  resolveConfigObserveSuspiciousReasons,
} from "./io.observe-suspicious.js";
import { hashConfigRaw } from "./io.read-helpers.js";
import type { NormalizedConfigIoDeps } from "./io.read.types.js";
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
    hash: params.current.hash,
    lastObservedSuspiciousSignature: entry.lastObservedSuspiciousSignature,
    bytes: params.current.bytes,
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
  store: ReturnType<typeof captureConfigHealthStateStore>;
  configPath: string;
  candidate: ConfigHealthFingerprint;
  expectedLastKnownGood: ConfigHealthFingerprint;
  previousLastKnownGood: ConfigHealthFingerprint;
  previousLastPromotedGood?: ConfigHealthFingerprint;
  previousSuspiciousSignature: string | null;
};

/**
 * Pre-publication last-known-good facts the writer captures before publishing
 * the candidate file, so a rolled-back write can restore the baseline that
 * existed before the write even when an intervening observed read records the
 * published candidate as healthy first.
 */
export type ConfigHealthBaselineCapture = {
  store: ReturnType<typeof captureConfigHealthStateStore>;
  configPath: string;
  previousLastKnownGood: ConfigHealthFingerprint;
  previousLastPromotedGood?: ConfigHealthFingerprint;
  previousSuspiciousSignature: string | null;
};

// Retry definite CAS conflicts or pre-effect supersession, never unknown write outcomes.
const CONFIG_HEALTH_TRANSITION_ATTEMPTS = 4;

async function settleConfigHealthTransition(
  owner: ReturnType<typeof captureConfigHealthStateStore>,
  transition: (
    store: ReturnType<typeof captureConfigHealthStateStore>,
    snapshot: ConfigHealthSnapshot,
  ) => Promise<ConfigHealthUpdateResult>,
): Promise<boolean> {
  for (let attempt = 0; attempt < CONFIG_HEALTH_TRANSITION_ATTEMPTS; attempt += 1) {
    using store = owner.captureContinuation("replace");
    const healthSnapshot = await store.read();
    if (!healthSnapshot) {
      continue; // Supersession before a read has no write effect to replay.
    }
    if (healthSnapshot.basis === null) {
      return false;
    }
    const result = await transition(store, healthSnapshot);
    if (result.status !== "conflict" && result.status !== "superseded") {
      return result.status === "applied";
    }
  }
  return false;
}

// Capture before file publication: an intervening observer can record the candidate.
export async function captureConfigHealthBaselineForWrite(
  deps: NormalizedConfigIoDeps,
  configPath: string,
  assertCurrent?: () => void,
): Promise<ConfigHealthBaselineCapture | null> {
  try {
    assertCurrent?.();
    // Retain database admission, not the write lock that ends before runtime rollback.
    using owner = captureConfigHealthStateStore(deps, configPath);
    for (let attempt = 0; attempt < CONFIG_HEALTH_TRANSITION_ATTEMPTS; attempt += 1) {
      using store = owner.captureContinuation("replace");
      assertCurrent?.();
      const snapshot = await store.read();
      assertCurrent?.();
      if (!snapshot) {
        continue;
      }
      if (snapshot.basis === null) {
        return null;
      }
      const entry = readConfigHealthEntry(snapshot.state, configPath);
      return entry.lastKnownGood
        ? {
            store: owner,
            configPath,
            previousLastKnownGood: entry.lastKnownGood,
            previousLastPromotedGood: entry.lastPromotedGood,
            previousSuspiciousSignature: entry.lastObservedSuspiciousSignature ?? null,
          }
        : null;
    }
    return null;
  } catch (error) {
    deps.logger.warn(
      `Config last-known-good baseline capture failed: ${formatErrorMessage(error)}`,
    );
    return null;
  }
}

// Accepted formatting/size reductions may advance the baseline, but stub shapes may not.
// Health bookkeeping is worker-backed and best-effort; retain compensation for rollback.
export async function advanceConfigHealthBaselineForAcceptedWrite(
  deps: NormalizedConfigIoDeps,
  capture: ConfigHealthBaselineCapture | null,
  params: {
    sourceSnapshot: ConfigFileSnapshot;
    raw: string;
    parsed: unknown;
    resolved?: unknown;
    assertCurrent?: () => void;
  },
): Promise<ConfigHealthBaselineCompensation | null> {
  if (!capture) {
    return null;
  }
  const baseline = capture;
  try {
    params.assertCurrent?.();
    const stat = await deps.fs.promises.stat(baseline.configPath).catch(() => null);
    const current = createConfigHealthFingerprint({
      raw: params.raw,
      parsed: params.parsed,
      resolved: params.resolved,
      stat,
    });
    const assertCandidateCurrent = () => {
      params.assertCurrent?.();
      if (hashConfigRaw(deps.fs.readFileSync(baseline.configPath, "utf-8")) !== current.hash) {
        throw new Error("Config changed before accepted-write health publication");
      }
    };
    const suspicious = resolveConfigObserveSuspiciousReasons({
      bytes: current.bytes,
      gatewayMode: current.gatewayMode,
      parsed: params.parsed,
      lastKnownGood: baseline.previousLastKnownGood,
    });
    if (suspicious.some((reason) => !reason.startsWith("size-drop-vs-last-good:"))) {
      return null;
    }
    // Inspect input even when stamping repaired its shape. Bind inherited loss
    // to the output hash so rereads/promotion cannot silently bless those bytes.
    const source = params.sourceSnapshot;
    const before =
      typeof source.raw === "string"
        ? createConfigHealthFingerprint({
            raw: source.raw,
            parsed: source.parsed,
            resolved: source.resolved,
            stat: null,
          })
        : null;
    const preserveBaseline =
      !before ||
      resolveConfigObserveSuspiciousReasons({
        ...before,
        parsed: source.parsed,
        lastKnownGood: baseline.previousLastKnownGood,
        lastObservedSuspiciousSignature: baseline.previousSuspiciousSignature,
      }).length > 0;
    const nextBaseline = preserveBaseline ? baseline.previousLastKnownGood : current;
    const nextSignature = preserveBaseline
      ? createInheritedConfigAnomalySignature(current.hash)
      : null;
    const compensation: ConfigHealthBaselineCompensation = {
      store: baseline.store,
      configPath: baseline.configPath,
      candidate: current,
      expectedLastKnownGood: nextBaseline,
      previousLastKnownGood: baseline.previousLastKnownGood,
      previousLastPromotedGood: baseline.previousLastPromotedGood,
      previousSuspiciousSignature: baseline.previousSuspiciousSignature,
    };

    const settled = await settleConfigHealthTransition(
      baseline.store,
      async (store, healthSnapshot) => {
        assertCandidateCurrent();
        const entry = readConfigHealthEntry(healthSnapshot.state, baseline.configPath);
        const persisted = entry.lastKnownGood;
        // A baseline that is neither the pre-write baseline nor this write's
        // candidate is a newer, valid decision: preserve it untouched.
        if (
          persisted &&
          persisted.hash !== baseline.previousLastKnownGood.hash &&
          persisted.hash !== current.hash
        ) {
          return { status: "applied" };
        }
        if (
          persisted?.hash === nextBaseline.hash &&
          (entry.lastObservedSuspiciousSignature ?? null) === nextSignature
        ) {
          // An observer may have recorded these bytes before the writer settled.
          // Compensate that exact decision, not a newly constructed timestamp;
          // observations after this decision must still win during rollback.
          compensation.expectedLastKnownGood = persisted;
          return { status: "applied" };
        }
        return store.updateAfterFileCommit(
          { lastKnownGood: nextBaseline, lastObservedSuspiciousSignature: nextSignature },
          healthSnapshot,
          assertCandidateCurrent,
        );
      },
    );
    if (!settled) {
      deps.logger.warn(
        `Config last-known-good baseline advance did not settle: ${baseline.configPath}`,
      );
    }
    return settled ? compensation : null;
  } catch (error) {
    deps.logger.warn(
      `Config last-known-good baseline advance failed: ${formatErrorMessage(error)}`,
    );
    return null;
  }
}

// Only compensate this candidate; preserve a newer observation or anomaly marker.
export async function restoreConfigHealthBaselineForRolledBackWrite(
  deps: NormalizedConfigIoDeps,
  compensation: ConfigHealthBaselineCompensation | null,
  assertCurrent?: () => void,
): Promise<void> {
  if (!compensation) {
    return;
  }
  const record = compensation;
  try {
    const settled = await settleConfigHealthTransition(
      record.store,
      async (store, healthSnapshot) => {
        assertCurrent?.();
        const entry = readConfigHealthEntry(healthSnapshot.state, record.configPath);
        // Newer observations win, and this also covers an already-restored
        // baseline: only the candidate this writer published is compensable.
        const inheritedMarker =
          entry.lastObservedSuspiciousSignature ===
          createInheritedConfigAnomalySignature(record.candidate.hash);
        if (
          !sameFingerprint(entry.lastKnownGood, record.expectedLastKnownGood) ||
          entry.lastKnownGood?.observedAt !== record.expectedLastKnownGood.observedAt ||
          !isDeepStrictEqual(entry.lastPromotedGood, record.previousLastPromotedGood)
        ) {
          return { status: "applied" };
        }
        const restoreMarker = entry.lastObservedSuspiciousSignature == null || inheritedMarker;
        return store.updateAfterFileCommit(
          {
            lastKnownGood: record.previousLastKnownGood,
            // Only rewind the anomaly marker when nothing newer recorded one.
            ...(restoreMarker
              ? { lastObservedSuspiciousSignature: record.previousSuspiciousSignature }
              : {}),
          },
          healthSnapshot,
          assertCurrent,
        );
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
