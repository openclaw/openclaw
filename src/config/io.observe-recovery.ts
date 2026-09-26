import type fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { replaceFileAtomic, replaceFileAtomicSync } from "@openclaw/fs-safe/atomic";
import { root } from "../infra/fs-safe.js";
import { appendConfigAuditRecord, appendConfigAuditRecordSync } from "./io.audit.js";
import {
  persistBoundedClobberedConfigSnapshot,
  persistBoundedClobberedConfigSnapshotSync,
} from "./io.clobber-snapshot.js";
import {
  captureConfigHealthStateStore,
  supersedeConfigHealthObservations,
  readConfigHealthStateFromStore,
  patchConfigHealthEntryToStore,
} from "./io.health-state.js";
import type { ConfigHealthFingerprint, ConfigHealthSnapshot } from "./io.health-state.types.js";
import {
  createConfigRecoveryStatEffect,
  createConfigBackupMissingEffect,
  createConfigBackupReadEffect,
  type ConfigRecoveryEffect,
} from "./io.observe-recovery-effects.js";
import {
  createConfigHealthFingerprint,
  createConfigObserveAuditAppendParams,
  extractRestoreErrorDetails,
  readConfigFingerprintForPath,
  readConfigFingerprintForPathSync,
  readConfigHealthEntry,
} from "./io.observe-state.js";
import { resolveConfigReadRecoveryContext } from "./io.observe-suspicious.js";
import { hashConfigRaw, resolveGatewayMode } from "./io.read-helpers.js";
import type { NormalizedConfigIoDeps } from "./io.read.types.js";
import type {
  ConfigRecoveryCandidate,
  ConfigRecoveryCandidatePreparation,
  PrepareConfigRecoveryCandidate,
} from "./io.types.js";
import { chmodConfigBestEffort, chmodConfigBestEffortSync } from "./io.write-safety.js";
import { formatConfigIssueSummary } from "./issue-format.js";
import { warnIfJSON5CommentsWillBeStripped } from "./json5-comments.js";
import { ConfigMutationConflictError } from "./mutation-conflict.js";
import { resolveIsConfigReadOnly } from "./paths.js";
import {
  collectPollutedSecretPlaceholders,
  isPluginLocalInvalidConfigSnapshot,
  shouldAttemptLastKnownGoodRecovery,
} from "./recovery-policy.js";
import type { ConfigFileSnapshot } from "./types.openclaw.js";

type ObserveRecoveryDeps = Pick<NormalizedConfigIoDeps, "fs" | "json5" | "env" | "homedir"> & {
  logger: Pick<typeof console, "warn">;
};

type ConfigReadRecoveryParams = {
  deps: ObserveRecoveryDeps;
  configPath: string;
  raw: string;
  parsed: unknown;
  prepareBackup: PrepareConfigRecoveryCandidate;
  prepareBackupAsync?: (
    candidate: ConfigRecoveryCandidate,
  ) => Promise<ConfigRecoveryCandidatePreparation>;
  assertCurrent?: () => void;
  allowBackupRecovery?: () => Promise<boolean>;
};

type ConfigReadRecoveryResult = Pick<ConfigRecoveryCandidate, "raw" | "parsed">;

async function commitRecoveryFileIfCurrent(params: {
  health: ReturnType<typeof captureConfigHealthStateStore>;
  beforeCommit?: () => void;
  write: (assertCurrent: () => void) => Promise<unknown>;
}): Promise<boolean> {
  let superseded: Error | undefined;
  try {
    await params.write(() => {
      params.beforeCommit?.();
      if (!params.health.isCurrent()) {
        superseded = new Error("Config recovery observation was superseded");
        throw superseded;
      }
    });
    return true;
  } catch (error) {
    if (superseded && error === superseded) {
      return false;
    }
    throw error;
  }
}

function createRecoveryCommitEffect(params: {
  deps: ObserveRecoveryDeps;
  configPath: string;
  raw: string;
  beforeCommit?: () => void;
}): ConfigRecoveryEffect<boolean> {
  const options = {
    filePath: params.configPath,
    content: params.raw,
    dirMode: 0o700,
    mode: 0o600,
    tempPrefix: path.basename(params.configPath),
    fileSystem: params.deps.fs,
  };
  return {
    sync: () => {
      replaceFileAtomicSync(options);
      return true;
    },
    async: (health) =>
      commitRecoveryFileIfCurrent({
        health,
        beforeCommit: params.beforeCommit,
        write: (assertCurrent) =>
          replaceFileAtomic({
            ...options,
            // Every rename attempt must revalidate; copy fallback has no final guard.
            copyFallbackOnPermissionError: false,
            fileSystem: {
              promises: {
                ...params.deps.fs.promises,
                rename: (source: fs.PathLike, destination: fs.PathLike) => {
                  assertCurrent();
                  return params.deps.fs.promises.rename(source, destination);
                },
              },
            },
          }),
      }),
  };
}

function parseBackupConfigRaw(
  deps: ObserveRecoveryDeps,
  backupRaw: string,
): { parsed: unknown } | null {
  try {
    return { parsed: deps.json5.parse(backupRaw) };
  } catch {
    return null;
  }
}

export async function maybeRecoverSuspiciousConfigRead(
  params: ConfigReadRecoveryParams,
): Promise<ConfigReadRecoveryResult> {
  using health = captureConfigHealthStateStore(
    params.deps,
    params.configPath,
    params.assertCurrent,
  );
  return await runConfigRecoveryAsync(
    recoverSuspiciousConfigRead(params),
    health,
    params.assertCurrent,
  );
}

async function runConfigRecoveryAsync<T>(
  recovery: ConfigRecoveryOperation<T>,
  health: ReturnType<typeof captureConfigHealthStateStore>,
  assertCurrent?: () => void,
): Promise<T> {
  assertCurrent?.();
  let step = recovery.next();
  while (!step.done) {
    try {
      assertCurrent?.();
      const value = await step.value.async(health);
      assertCurrent?.();
      step = recovery.next(value);
    } catch (error) {
      assertCurrent?.();
      try {
        if (!health.isCurrent()) {
          throw error;
        }
      } catch {
        // An expired owner must not enter the recoverable file-I/O fallback.
        throw error;
      }
      step = recovery.throw(error);
    }
  }
  return step.value;
}

export function maybeRecoverSuspiciousConfigReadSync(
  params: ConfigReadRecoveryParams,
): ConfigReadRecoveryResult {
  supersedeConfigHealthObservations(params.deps, params.configPath);
  const recovery = recoverSuspiciousConfigRead(params);
  let step = recovery.next();
  while (!step.done) {
    try {
      step = recovery.next(step.value.sync());
    } catch (error) {
      step = recovery.throw(error);
    }
  }
  return step.value;
}

type ConfigRecoveryOperation<T> = Generator<ConfigRecoveryEffect<unknown>, T, unknown>;
type SuspiciousConfigRecoveryPlan = {
  candidate: ConfigReadRecoveryResult;
  assertUnchanged: () => void;
  apply: (
    beforeCommit?: () => void,
  ) => ConfigRecoveryOperation<{ restored: boolean; error: unknown; superseded?: boolean }>;
};

/** Prepare the existing recovery without observing or writing the selected config. */
export async function prepareSuspiciousConfigRead(params: ConfigReadRecoveryParams): Promise<{
  candidate: ConfigReadRecoveryResult;
  apply: (beforeCommit?: () => void) => Promise<void>;
} | null> {
  using health = captureConfigHealthStateStore(
    params.deps,
    params.configPath,
    params.assertCurrent,
  );
  const plan = await runConfigRecoveryAsync(planSuspiciousConfigRead(params), health);
  const captureApplyHealth = () => health.captureContinuation();
  return (
    plan && {
      candidate: plan.candidate,
      apply: async (beforeCommit) => {
        using applyHealth = captureApplyHealth();
        const assertAllowed = () => {
          if (!applyHealth.isCurrent()) {
            throw new ConfigMutationConflictError("config recovery observation was superseded", {
              retryable: false,
            });
          }
          beforeCommit?.();
          plan.assertUnchanged();
        };
        assertAllowed();
        const currentPlan = await runConfigRecoveryAsync(
          planSuspiciousConfigRead(params),
          applyHealth,
        );
        if (!currentPlan || !isDeepStrictEqual(currentPlan.candidate, plan.candidate)) {
          throw new ConfigMutationConflictError(
            "config recovery candidate changed since preparation",
            {
              retryable: false,
            },
          );
        }
        const assertCurrentPlan = () => {
          assertAllowed();
          currentPlan.assertUnchanged();
        };
        assertCurrentPlan();
        const result = await runConfigRecoveryAsync(
          currentPlan.apply(assertCurrentPlan),
          applyHealth,
        );
        if (result.superseded) {
          throw new ConfigMutationConflictError("config recovery observation was superseded", {
            retryable: false,
          });
        }
        if (!result.restored) {
          throw result.error;
        }
      },
    }
  );
}

function* recoverSuspiciousConfigRead(
  params: ConfigReadRecoveryParams,
): ConfigRecoveryOperation<ConfigReadRecoveryResult> {
  const { raw, parsed } = params;
  const plan = yield* planSuspiciousConfigRead(params);
  if (!plan) {
    return { raw, parsed };
  }
  if (params.allowBackupRecovery) {
    const allowed = (yield {
      sync: () => true,
      async: () => params.allowBackupRecovery?.() ?? true,
    }) as boolean;
    if (!allowed) {
      return { raw, parsed };
    }
  }
  const applied = yield* plan.apply();
  return applied.superseded ? { raw, parsed } : plan.candidate;
}

function* planSuspiciousConfigRead(
  params: ConfigReadRecoveryParams,
): ConfigRecoveryOperation<SuspiciousConfigRecoveryPlan | null> {
  const { deps, configPath, raw, parsed } = params;
  // External owners also own recovery; do not substitute backup bytes or create sidecars.
  if (resolveIsConfigReadOnly(deps.env)) {
    return null;
  }
  const backupPath = `${configPath}.bak`;
  // Missing backups cannot recover config; avoid opening the health worker just to confirm that.
  if (yield createConfigBackupMissingEffect(deps, backupPath)) {
    return null;
  }
  const stat = (yield createConfigRecoveryStatEffect(deps, configPath)) as fs.Stats | null;
  const now = new Date().toISOString();
  const current = createConfigHealthFingerprint({
    raw,
    parsed,
    stat,
    observedAt: now,
  });
  const healthSnapshot = (yield {
    sync: () => ({ state: readConfigHealthStateFromStore(deps), basis: null }),
    async: (health) => health.read(),
  }) as ConfigHealthSnapshot | null; // SAFETY: Both effect runners return the typed health-owner snapshot.
  if (!healthSnapshot) {
    return null;
  }
  const healthState = healthSnapshot.state;
  const entry = readConfigHealthEntry(healthState, configPath);
  const backupBaseline =
    entry.lastKnownGood ??
    ((yield {
      sync: () => readConfigFingerprintForPathSync(deps, backupPath),
      async: () => readConfigFingerprintForPath(deps, backupPath),
    }) as ConfigHealthFingerprint | null) ??
    undefined;
  const recoveryContext = resolveConfigReadRecoveryContext({
    current,
    parsed,
    entry,
    backupBaseline,
  });
  if (!recoveryContext) {
    return null;
  }
  const { suspicious, suspiciousSignature } = recoveryContext;
  const backupRaw = (yield createConfigBackupReadEffect(deps, backupPath)) as string | null;
  if (!backupRaw) {
    return null;
  }
  const backupParse = parseBackupConfigRaw(deps, backupRaw);
  // Reject ineligible backup bytes before migration and validation; a stale healthy
  // fingerprint cannot make them recoverable.
  if (!backupParse || !resolveGatewayMode(backupParse.parsed)) {
    return null;
  }
  const backupCandidate = { raw: backupRaw, parsed: backupParse.parsed };
  const prepared = (yield {
    sync: () => params.prepareBackup(backupCandidate),
    async: () =>
      params.prepareBackupAsync?.(backupCandidate) ?? params.prepareBackup(backupCandidate),
  }) as ConfigRecoveryCandidatePreparation;
  if (!prepared.ok) {
    return null;
  }
  const preparedCandidate = prepared.candidate;
  const backupStat = (yield createConfigRecoveryStatEffect(deps, backupPath)) as fs.Stats | null;
  const backup = createConfigHealthFingerprint({
    raw: backupRaw,
    parsed: backupParse.parsed,
    stat: backupStat,
  });
  const currentObservation: ConfigRecoveryEffect<boolean> = {
    sync: () => true,
    async: (health) => health.isCurrent(),
  };
  if (!(yield currentObservation)) {
    return null;
  }
  return {
    candidate: preparedCandidate,
    assertUnchanged: () => {
      for (const [pathname, expectedRaw, expectedStat] of [
        [configPath, raw, stat],
        [backupPath, backupRaw, backupStat],
      ] as const) {
        const actualRaw = createConfigBackupReadEffect(deps, pathname).sync();
        const actualStat = createConfigRecoveryStatEffect(deps, pathname).sync();
        if (
          actualRaw !== expectedRaw ||
          !actualStat ||
          !expectedStat ||
          actualStat.dev !== expectedStat.dev ||
          actualStat.ino !== expectedStat.ino ||
          actualStat.mtimeMs !== expectedStat.mtimeMs ||
          actualStat.size !== expectedStat.size
        ) {
          throw new ConfigMutationConflictError(
            "config recovery source changed since preparation",
            {
              retryable: false,
            },
          );
        }
      }
    },
    *apply(beforeCommit) {
      if (!(yield currentObservation)) {
        return { restored: false, error: undefined, superseded: true };
      }
      const snapshotParams = {
        deps,
        configPath,
        raw,
        observedAt: now,
      };
      const clobberedPath = (yield {
        sync: () => persistBoundedClobberedConfigSnapshotSync(snapshotParams),
        async: () => persistBoundedClobberedConfigSnapshot(snapshotParams),
      }) as string | null;
      if (!(yield currentObservation)) {
        return { restored: false, error: undefined, superseded: true };
      }
      let restoredFromBackup = false;
      let restoreError: unknown;
      try {
        if (preparedCandidate.raw !== backupRaw) {
          warnIfJSON5CommentsWillBeStripped({
            raw: backupRaw,
            filePath: configPath,
            warn: (message) => deps.logger.warn(message),
          });
        }
        const committed = (yield createRecoveryCommitEffect({
          deps,
          configPath,
          raw: preparedCandidate.raw,
          beforeCommit,
        })) as boolean; // SAFETY: Both commit effect runners return whether the file was committed.
        if (!committed) {
          return { restored: false, error: undefined, superseded: true };
        }
        const chmodParams = { deps, configPath, context: "backup restore" };
        yield {
          sync: () => chmodConfigBestEffortSync(chmodParams),
          async: () => chmodConfigBestEffort(chmodParams),
        };
        restoredFromBackup = true;
      } catch (error) {
        restoreError = error;
      }
      const restoreErrorDetails = restoredFromBackup
        ? { code: null, message: null }
        : extractRestoreErrorDetails(restoreError);
      const result = restoredFromBackup
        ? "auto-restored from backup"
        : "auto-restore from backup failed";
      const detail =
        !restoredFromBackup && restoreErrorDetails.message
          ? `; ${restoreErrorDetails.message}`
          : "";
      deps.logger.warn(`Config ${result}: ${configPath} (${suspicious.join(", ")}${detail})`);
      const audit = createConfigObserveAuditAppendParams(deps, {
        configPath,
        valid: restoredFromBackup,
        current,
        suspicious,
        lastKnownGood: entry.lastKnownGood,
        backup,
        clobberedPath,
        restoredFromBackup,
        restoredBackupPath: backupPath,
        restoreErrorCode: restoreErrorDetails.code,
        restoreErrorMessage: restoreErrorDetails.message,
      });
      yield {
        sync: () => appendConfigAuditRecordSync(audit),
        async: () => appendConfigAuditRecord(audit, params.assertCurrent),
      };
      if (restoredFromBackup) {
        yield {
          sync: () =>
            patchConfigHealthEntryToStore(deps, configPath, {
              lastObservedSuspiciousSignature: suspiciousSignature,
            }),
          async: (health) =>
            health.updateAfterFileCommit(
              {
                lastObservedSuspiciousSignature: suspiciousSignature,
              },
              healthSnapshot,
            ),
        };
      }
      return { restored: restoredFromBackup, error: restoreError };
    },
  };
}

/** True reports committed file work; health metadata remains best-effort. */
export async function promoteConfigSnapshotToLastKnownGoodCore(params: {
  deps: ObserveRecoveryDeps;
  snapshot: ConfigFileSnapshot;
  logger?: Pick<typeof console, "warn">;
}): Promise<boolean> {
  const { deps, snapshot } = params;
  if (resolveIsConfigReadOnly(deps.env)) {
    return false;
  }
  if (!snapshot.exists || !snapshot.valid || typeof snapshot.raw !== "string") {
    return false;
  }
  const polluted = collectPollutedSecretPlaceholders(snapshot.parsed);
  if (polluted.length > 0) {
    params.logger?.warn(
      `Config last-known-good promotion skipped: redacted secret placeholder at ${polluted[0]}`,
    );
    return false;
  }
  using health = captureConfigHealthStateStore(deps, snapshot.path);
  const healthSnapshot = await health.read();
  if (!healthSnapshot) {
    return false;
  }
  const stat = await deps.fs.promises.stat(snapshot.path).catch(() => null);
  const now = new Date().toISOString();
  const current = createConfigHealthFingerprint({
    raw: snapshot.raw,
    parsed: snapshot.parsed,
    resolved: snapshot.resolved,
    stat,
    observedAt: now,
  });
  const lastGoodPath = `${snapshot.path}.last-good`;
  if (!health.isCurrent()) {
    return false;
  }
  const raw = snapshot.raw;
  if (
    !(await commitRecoveryFileIfCurrent({
      health,
      write: async (assertCurrent) => {
        const directory = await root(path.dirname(lastGoodPath));
        await directory.write(path.basename(lastGoodPath), raw, {
          mkdir: false,
          mode: 0o600,
          durable: false,
          encoding: "utf8",
          overwrite: true,
          assertBeforeMutation: assertCurrent,
        });
      },
    }))
  ) {
    return false;
  }
  await chmodConfigBestEffort({
    deps,
    configPath: lastGoodPath,
    context: "last-known-good promotion",
  });
  await health.updateAfterFileCommit(
    {
      lastKnownGood: current,
      lastPromotedGood: current,
      lastObservedSuspiciousSignature: null,
    },
    healthSnapshot,
  );
  return true;
}

/** True lets recovery callers reread the changed file even if newer health facts win. */
export async function recoverConfigFromLastKnownGoodCore(params: {
  deps: ObserveRecoveryDeps;
  snapshot: ConfigFileSnapshot;
  reason: string;
  prepareCandidate: PrepareConfigRecoveryCandidate;
}): Promise<boolean> {
  const { deps, snapshot } = params;
  if (resolveIsConfigReadOnly(deps.env)) {
    return false;
  }
  if (!snapshot.exists || typeof snapshot.raw !== "string") {
    return false;
  }
  if (!shouldAttemptLastKnownGoodRecovery(snapshot)) {
    if (isPluginLocalInvalidConfigSnapshot(snapshot)) {
      deps.logger.warn(
        `Config last-known-good recovery skipped: invalidity is scoped to stale plugin config (${params.reason})`,
      );
    }
    return false;
  }
  using health = captureConfigHealthStateStore(deps, snapshot.path);
  const healthSnapshot = await health.read();
  if (!healthSnapshot) {
    return false;
  }
  const entry = readConfigHealthEntry(healthSnapshot.state, snapshot.path);
  const promoted = entry.lastPromotedGood;
  if (!promoted?.hash) {
    return false;
  }
  const lastGoodPath = `${snapshot.path}.last-good`;
  const backupRaw = await deps.fs.promises.readFile(lastGoodPath, "utf-8").catch(() => null);
  if (!backupRaw || hashConfigRaw(backupRaw) !== promoted.hash) {
    return false;
  }
  const backupParse = parseBackupConfigRaw(deps, backupRaw);
  if (!backupParse) {
    return false;
  }
  // Historical bytes become live config only after their owner has migrated and validated them.
  // This prevents Doctor recovery from exposing a schema-invalid intermediate file.
  const originalCandidate = { raw: backupRaw, parsed: backupParse.parsed };
  const prepared = params.prepareCandidate(originalCandidate);
  if (!prepared.ok) {
    deps.logger.warn(
      `Config last-known-good recovery skipped: ${prepared.reason} (${params.reason})`,
    );
    return false;
  }
  const recoveryCandidate = prepared.candidate;
  const polluted = collectPollutedSecretPlaceholders(recoveryCandidate.parsed);
  if (polluted.length > 0) {
    deps.logger.warn(
      `Config last-known-good recovery skipped: redacted secret placeholder at ${polluted[0]}`,
    );
    return false;
  }
  const now = new Date().toISOString();
  const stat = await deps.fs.promises.stat(snapshot.path).catch(() => null);
  const current = createConfigHealthFingerprint({
    raw: snapshot.raw,
    parsed: snapshot.parsed,
    resolved: snapshot.resolved,
    stat,
    observedAt: now,
  });
  if (!health.isCurrent()) {
    return false;
  }
  const clobberedPath = await persistBoundedClobberedConfigSnapshot({
    deps,
    configPath: snapshot.path,
    raw: snapshot.raw,
    observedAt: now,
  });
  if (!health.isCurrent()) {
    return false;
  }
  if (recoveryCandidate.raw !== backupRaw) {
    warnIfJSON5CommentsWillBeStripped({
      raw: backupRaw,
      filePath: snapshot.path,
      warn: (message) => deps.logger.warn(message),
    });
  }
  if (
    !(await createRecoveryCommitEffect({
      deps,
      configPath: snapshot.path,
      raw: recoveryCandidate.raw,
    }).async(health))
  ) {
    return false;
  }
  await chmodConfigBestEffort({
    deps,
    configPath: snapshot.path,
    context: "last-known-good recovery",
  });
  const issueSummary = formatConfigIssueSummary([...snapshot.issues, ...snapshot.legacyIssues]);
  deps.logger.warn(
    `Config auto-restored from last-known-good: ${snapshot.path} (${params.reason})${issueSummary ? `; Rejected validation details: ${issueSummary}.` : ""}`,
  );
  await appendConfigAuditRecord(
    createConfigObserveAuditAppendParams(deps, {
      configPath: snapshot.path,
      valid: snapshot.valid,
      current,
      suspicious: [params.reason],
      lastKnownGood: promoted,
      backup: promoted,
      clobberedPath,
      restoredFromBackup: true,
      restoredBackupPath: lastGoodPath,
    }),
  );
  await health.updateAfterFileCommit(
    {
      lastKnownGood: promoted,
      lastPromotedGood: promoted,
      lastObservedSuspiciousSignature: null,
    },
    healthSnapshot,
  );
  return true;
}
