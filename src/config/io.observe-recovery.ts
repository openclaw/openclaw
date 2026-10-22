import type fs from "node:fs";
import path from "node:path";
import { replaceFileAtomic, replaceFileAtomicSync } from "@openclaw/fs-safe/atomic";
import JSON5 from "json5";
import { root } from "../infra/fs-safe.js";
import { readExistingStateRootMode } from "../infra/private-dir-mode.js";
import {
  enqueueConfigAuditRecord,
  captureConfigAuditAppender,
  createConfigObserveAuditRecord,
} from "./io.audit.js";
import {
  persistBoundedClobberedConfigSnapshot,
  persistBoundedClobberedConfigSnapshotSync,
} from "./io.clobber-snapshot.js";
import {
  captureConfigHealthStateStore,
  readConfigHealthStateFromStore,
  patchConfigHealthEntryToStore,
} from "./io.health-state.js";
import type { ConfigHealthSnapshot } from "./io.health-state.types.js";
import {
  createConfigRecoveryStatEffect,
  createConfigBackupMissingEffect,
  createConfigBackupReadEffect,
  commitConfigRecoveryFile,
  createConfigRecoverySourceGuard,
  type ConfigRecoveryEffect,
} from "./io.observe-recovery-effects.js";
import {
  createConfigHealthFingerprint,
  extractRestoreErrorDetails,
  readConfigHealthEntry,
} from "./io.observe-state.js";
import { resolveConfigObserveSuspiciousReasons } from "./io.observe-suspicious.js";
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
import { resolveIsConfigReadOnly, resolveStateDir } from "./paths.js";
import {
  collectPollutedSecretPlaceholders,
  isPluginLocalInvalidConfigSnapshot,
  shouldAttemptLastKnownGoodRecovery,
} from "./recovery-policy.js";
import type { ConfigFileSnapshot } from "./types.openclaw.js";

type ObserveRecoveryDeps = Pick<NormalizedConfigIoDeps, "fs" | "env" | "homedir"> & {
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

function createRecoveryCommitEffect(params: {
  deps: ObserveRecoveryDeps;
  configPath: string;
  raw: string;
  beforeCommit?: () => void;
}): ConfigRecoveryEffect<void> {
  const options = {
    filePath: params.configPath,
    content: params.raw,
    dirMode:
      readExistingStateRootMode(
        path.dirname(params.configPath),
        resolveStateDir(params.deps.env, params.deps.homedir),
        params.deps.fs,
      ) ?? 0o700,
    mode: 0o600,
    tempPrefix: path.basename(params.configPath),
    fileSystem: params.deps.fs,
  };
  return {
    sync: () => {
      params.beforeCommit?.();
      replaceFileAtomicSync(options);
    },
    async: (health) =>
      commitConfigRecoveryFile({
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

function parseBackupConfigRaw(backupRaw: string): { parsed: unknown } | null {
  try {
    return { parsed: JSON5.parse(backupRaw) };
  } catch {
    return null;
  }
}

export async function maybeRecoverSuspiciousConfigRead(
  params: ConfigReadRecoveryParams,
): Promise<ConfigReadRecoveryResult> {
  const health = captureConfigHealthStateStore(
    params.deps,
    params.configPath,
    params.assertCurrent,
  );
  return await runConfigRecoveryAsync(
    recoverSuspiciousConfigRead(params),
    health,
    captureConfigAuditAppender(params.deps, params.assertCurrent),
    params.assertCurrent,
  );
}

async function runConfigRecoveryAsync<T>(
  recovery: ConfigRecoveryOperation<T>,
  health: ReturnType<typeof captureConfigHealthStateStore>,
  appendAudit: ReturnType<typeof captureConfigAuditAppender>,
  assertCurrent?: () => void,
): Promise<T> {
  assertCurrent?.();
  let step = recovery.next();
  while (!step.done) {
    try {
      assertCurrent?.();
      const value = await step.value.async(health, appendAudit);
      assertCurrent?.();
      step = recovery.next(value);
    } catch (error) {
      assertCurrent?.();
      try {
        health.assertCurrent();
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
  apply: (
    beforeCommit?: () => void,
  ) => ConfigRecoveryOperation<{ restored: boolean; error: unknown }>;
};

/** Prepare the existing recovery without observing or writing the selected config. */
export async function prepareSuspiciousConfigRead(params: ConfigReadRecoveryParams): Promise<{
  candidate: ConfigReadRecoveryResult;
  apply: (beforeCommit?: () => void) => Promise<void>;
} | null> {
  const health = captureConfigHealthStateStore(
    params.deps,
    params.configPath,
    params.assertCurrent,
  );
  const appendAudit = captureConfigAuditAppender(params.deps, params.assertCurrent);
  const plan = await runConfigRecoveryAsync(
    planSuspiciousConfigRead(params, true),
    health,
    appendAudit,
  );
  return (
    plan && {
      candidate: plan.candidate,
      apply: async (beforeCommit) => {
        const result = await runConfigRecoveryAsync(plan.apply(beforeCommit), health, appendAudit);
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
  return applied.error instanceof ConfigMutationConflictError ? { raw, parsed } : plan.candidate;
}

function* planSuspiciousConfigRead(
  params: ConfigReadRecoveryParams,
  requireIdentity = false,
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
  // Explicit preparation requires identity; ordinary recovery keeps stat best-effort.
  const stat = (yield createConfigRecoveryStatEffect(
    deps,
    configPath,
    requireIdentity,
  )) as fs.Stats | null;
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
  }) as ConfigHealthSnapshot; // SAFETY: Both effect runners return the typed health-owner snapshot.
  const entry = readConfigHealthEntry(healthSnapshot.state, configPath);
  let backupRaw: string | null = null;
  if (!entry.lastKnownGood) {
    backupRaw = (yield createConfigBackupReadEffect(deps, backupPath)) as string | null;
  }
  const backupBaseline =
    entry.lastKnownGood ??
    (backupRaw
      ? createConfigHealthFingerprint({
          raw: backupRaw,
          parsed: parseBackupConfigRaw(backupRaw)?.parsed ?? {},
          stat: null,
        })
      : undefined);
  const suspicious = resolveConfigObserveSuspiciousReasons({
    ...current,
    parsed,
    lastKnownGood: backupBaseline,
  });
  const suspiciousSignature = `${current.hash}:${suspicious.join(",")}`;
  if (suspicious.length === 0 || entry.lastObservedSuspiciousSignature === suspiciousSignature) {
    return null;
  }
  backupRaw ??= (yield createConfigBackupReadEffect(deps, backupPath)) as string | null;
  if (!backupRaw) {
    return null;
  }
  const backupParse = parseBackupConfigRaw(backupRaw);
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
  const backupStat = (yield createConfigRecoveryStatEffect(
    deps,
    backupPath,
    requireIdentity,
  )) as fs.Stats | null;
  const backup = createConfigHealthFingerprint({
    raw: backupRaw,
    parsed: backupParse.parsed,
    stat: backupStat,
  });
  const assertUnchanged = createConfigRecoverySourceGuard(
    deps,
    [
      [configPath, raw, stat],
      [backupPath, backupRaw, backupStat],
    ],
    requireIdentity,
  );
  return {
    candidate: preparedCandidate,
    *apply(beforeCommit) {
      const snapshotParams = {
        deps,
        configPath,
        raw,
        observedAt: now,
      };
      const clobberedPath = (yield {
        sync: () => {
          beforeCommit?.();
          assertUnchanged();
          return persistBoundedClobberedConfigSnapshotSync(snapshotParams);
        },
        async: (health) => {
          beforeCommit?.();
          assertUnchanged();
          health.assertCurrent();
          return persistBoundedClobberedConfigSnapshot(snapshotParams);
        },
      }) as string | null;
      if (clobberedPath === null) {
        const error = new Error(
          `Config backup recovery deferred: ${configPath}; original config snapshot could not be saved. Retry recovery.`,
        );
        deps.logger.warn(error.message);
        return { restored: false, error };
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
        yield createRecoveryCommitEffect({
          deps,
          configPath,
          raw: preparedCandidate.raw,
          beforeCommit: () => {
            beforeCommit?.();
            assertUnchanged();
          },
        });
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
      const audit = {
        env: deps.env,
        homedir: deps.homedir,
        record: createConfigObserveAuditRecord({
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
        }),
      };
      yield {
        sync: () => enqueueConfigAuditRecord(audit),
        async: (_health, appendAudit) => appendAudit(audit.record),
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
  const health = captureConfigHealthStateStore(deps, snapshot.path);
  const healthSnapshot = await health.read();
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
  health.assertCurrent();
  const raw = snapshot.raw;
  const assertUnchanged = createConfigRecoverySourceGuard(deps, [[snapshot.path, raw, stat]]);
  await commitConfigRecoveryFile({
    health,
    beforeCommit: assertUnchanged,
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
  });
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
  const health = captureConfigHealthStateStore(deps, snapshot.path);
  const appendAudit = captureConfigAuditAppender(deps);
  const healthSnapshot = await health.read();
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
  const backupStat = await deps.fs.promises.stat(lastGoodPath).catch(() => null);
  const backupParse = parseBackupConfigRaw(backupRaw);
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
  const assertUnchanged = createConfigRecoverySourceGuard(deps, [
    [snapshot.path, snapshot.raw, stat],
    [lastGoodPath, backupRaw, backupStat],
  ]);
  assertUnchanged();
  health.assertCurrent();
  const clobberedPath = await persistBoundedClobberedConfigSnapshot({
    deps,
    configPath: snapshot.path,
    raw: snapshot.raw,
    observedAt: now,
  });
  health.assertCurrent();
  if (clobberedPath === null) {
    deps.logger.warn(
      `Config last-known-good recovery deferred: ${snapshot.path}; original config snapshot could not be saved. Retry recovery.`,
    );
    return false;
  }
  if (recoveryCandidate.raw !== backupRaw) {
    warnIfJSON5CommentsWillBeStripped({
      raw: backupRaw,
      filePath: snapshot.path,
      warn: (message) => deps.logger.warn(message),
    });
  }
  await createRecoveryCommitEffect({
    deps,
    configPath: snapshot.path,
    raw: recoveryCandidate.raw,
    beforeCommit: assertUnchanged,
  }).async(health, appendAudit);
  await chmodConfigBestEffort({
    deps,
    configPath: snapshot.path,
    context: "last-known-good recovery",
  });
  const issueSummary = formatConfigIssueSummary([...snapshot.issues, ...snapshot.legacyIssues]);
  deps.logger.warn(
    `Config auto-restored from last-known-good: ${snapshot.path} (${params.reason})${issueSummary ? `; Rejected validation details: ${issueSummary}.` : ""}`,
  );
  await appendAudit(
    createConfigObserveAuditRecord({
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
