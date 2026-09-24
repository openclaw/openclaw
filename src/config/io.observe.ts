import type fs from "node:fs";
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
