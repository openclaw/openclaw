import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  clearConfigCache,
  createConfigIO,
  readConfigFileSnapshot,
  resolveConfigSnapshotHash,
  type ConfigWriteOptions,
  writeConfigFile,
} from "./io.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";

const DEFAULT_NUMBERED_BACKUP_COUNT = 6;
const SILENT_LOGGER = {
  warn: (_message: string) => {},
  error: (_message: string) => {},
};

type ConfigTransactionDeps = {
  fs?: typeof fs;
  env?: NodeJS.ProcessEnv;
  createConfigIO?: typeof createConfigIO;
  readConfigFileSnapshot?: typeof readConfigFileSnapshot;
  writeConfigFile?: typeof writeConfigFile;
  clearConfigCache?: typeof clearConfigCache;
};

function cloneProcessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env } as NodeJS.ProcessEnv;
}

function normalizeDeps(overrides: ConfigTransactionDeps = {}): Required<ConfigTransactionDeps> {
  return {
    fs: overrides.fs ?? fs,
    env: overrides.env ?? process.env,
    createConfigIO: overrides.createConfigIO ?? createConfigIO,
    readConfigFileSnapshot: overrides.readConfigFileSnapshot ?? readConfigFileSnapshot,
    writeConfigFile: overrides.writeConfigFile ?? writeConfigFile,
    clearConfigCache: overrides.clearConfigCache ?? clearConfigCache,
  };
}

function listBackupCandidates(configPath: string, numberedBackupCount: number): string[] {
  const candidates = [`${configPath}.bak`];
  for (let index = 1; index <= numberedBackupCount; index += 1) {
    candidates.push(`${configPath}.bak.${index}`);
  }
  return candidates;
}

function isRenameReplaceBlocked(code: string | undefined): boolean {
  return code === "EPERM" || code === "EEXIST";
}

async function replaceFileWithCopyFallback(
  ioFs: typeof fs,
  configPath: string,
  sourceTmpPath: string,
  suffix: string,
): Promise<void> {
  const dir = path.dirname(configPath);
  const replaceTmpPath = path.join(
    dir,
    `${path.basename(configPath)}.${process.pid}.${suffix}.replace.tmp`,
  );
  await ioFs.promises.copyFile(sourceTmpPath, replaceTmpPath);
  await ioFs.promises.chmod(replaceTmpPath, 0o600).catch(() => {
    // best-effort
  });
  try {
    await ioFs.promises.rename(replaceTmpPath, configPath);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!isRenameReplaceBlocked(code)) {
      throw err;
    }
    // Best-effort fallback for platforms where atomic replace-by-rename is blocked.
    await ioFs.promises.rm(configPath, { force: true });
    await ioFs.promises.rename(replaceTmpPath, configPath);
  } finally {
    await ioFs.promises.rm(replaceTmpPath, { force: true }).catch(() => {
      // best-effort
    });
  }
}

async function writeRawAtomically(
  ioFs: typeof fs,
  configPath: string,
  raw: string,
  suffix: string,
): Promise<void> {
  const dir = path.dirname(configPath);
  await ioFs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmpPath = path.join(dir, `${path.basename(configPath)}.${process.pid}.${suffix}.tmp`);
  await ioFs.promises.writeFile(tmpPath, raw, { encoding: "utf-8", mode: 0o600 });
  try {
    await ioFs.promises.rename(tmpPath, configPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (isRenameReplaceBlocked(code)) {
      await replaceFileWithCopyFallback(ioFs, configPath, tmpPath, suffix);
      return;
    }
    throw err;
  } finally {
    await ioFs.promises.rm(tmpPath, { force: true }).catch(() => {
      // best-effort
    });
  }
}

async function restorePreTransactionSnapshot(
  ioFs: typeof fs,
  snapshot: ConfigFileSnapshot,
  transactionId: string,
): Promise<void> {
  if (!snapshot.exists || typeof snapshot.raw !== "string") {
    await ioFs.promises.rm(snapshot.path, { force: true }).catch(() => {
      // best-effort
    });
    return;
  }
  await writeRawAtomically(ioFs, snapshot.path, snapshot.raw, `rollback-${transactionId}`);
}

async function cleanupStagingFiles(
  ioFs: typeof fs,
  stagingPath: string,
  numberedBackupCount: number,
): Promise<void> {
  const candidates = [stagingPath, ...listBackupCandidates(stagingPath, numberedBackupCount)];
  for (const candidate of candidates) {
    await ioFs.promises.rm(candidate, { force: true }).catch(() => {
      // best-effort
    });
  }
}

type IsolatedVerificationResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      error: string;
      issues: ConfigFileSnapshot["issues"];
    };

async function runIsolatedVerification(params: {
  transactionId: string;
  config: OpenClawConfig;
  writeOptions: ConfigWriteOptions;
  deps: Required<ConfigTransactionDeps>;
}): Promise<IsolatedVerificationResult> {
  const baseline = await params.deps.readConfigFileSnapshot();
  const stagingPath = `${baseline.path}.tx-${params.transactionId}.staging.json`;
  const stagingEnv = cloneProcessEnv(params.deps.env);
  const stagingIo = params.deps.createConfigIO({
    configPath: stagingPath,
    env: stagingEnv,
    logger: SILENT_LOGGER,
  });
  try {
    await stagingIo.writeConfigFile(params.config, {
      unsetPaths: params.writeOptions.unsetPaths,
    });
    const stagingSnapshot = await stagingIo.readConfigFileSnapshot();
    if (stagingSnapshot.valid) {
      return { ok: true };
    }
    const firstIssue = stagingSnapshot.issues[0];
    const issueText = firstIssue
      ? `${firstIssue.path || "<root>"}: ${firstIssue.message}`
      : "unknown issue";
    return {
      ok: false,
      error: `isolated verification failed: ${issueText}`,
      issues: stagingSnapshot.issues,
    };
  } catch (err) {
    return {
      ok: false,
      error: `isolated verification failed: ${String(err)}`,
      issues: [],
    };
  } finally {
    await cleanupStagingFiles(params.deps.fs, stagingPath, DEFAULT_NUMBERED_BACKUP_COUNT);
  }
}

export type ConfigWriteTransactionStage = "prepare" | "commit" | "verify" | "rollback";

export type ConfigWriteTransactionResult = {
  ok: boolean;
  transactionId: string;
  stage: ConfigWriteTransactionStage | null;
  rolledBack: boolean;
  beforeHash: string | null;
  afterHash: string | null;
  error?: string;
  issues?: ConfigFileSnapshot["issues"];
};

export type RunConfigWriteTransactionParams = {
  config: OpenClawConfig;
  writeOptions?: ConfigWriteOptions;
  skipPrepareIsolation?: boolean;
  verifyCommittedSnapshot?: (snapshot: ConfigFileSnapshot) => boolean;
  verificationErrorMessage?: string;
};

export async function runConfigWriteTransaction(
  params: RunConfigWriteTransactionParams,
  overrides: ConfigTransactionDeps = {},
): Promise<ConfigWriteTransactionResult> {
  const deps = normalizeDeps(overrides);
  const transactionId = crypto.randomUUID();
  const writeOptions = params.writeOptions ?? {};
  const beforeSnapshot = await deps.readConfigFileSnapshot();
  const beforeHash = resolveConfigSnapshotHash(beforeSnapshot);

  if (params.skipPrepareIsolation !== true) {
    const prepareResult = await runIsolatedVerification({
      transactionId,
      config: params.config,
      writeOptions,
      deps,
    });
    if (!prepareResult.ok) {
      return {
        ok: false,
        transactionId,
        stage: "prepare",
        rolledBack: false,
        beforeHash,
        afterHash: null,
        error: prepareResult.error,
        issues: prepareResult.issues,
      };
    }
  }

  try {
    await deps.writeConfigFile(params.config, writeOptions);
  } catch (err) {
    return {
      ok: false,
      transactionId,
      stage: "commit",
      rolledBack: false,
      beforeHash,
      afterHash: null,
      error: String(err),
    };
  }

  const committedSnapshot = await deps.readConfigFileSnapshot();
  const afterHash = resolveConfigSnapshotHash(committedSnapshot);
  const verifyCommitted = params.verifyCommittedSnapshot
    ? params.verifyCommittedSnapshot(committedSnapshot)
    : committedSnapshot.valid;
  if (verifyCommitted) {
    return {
      ok: true,
      transactionId,
      stage: null,
      rolledBack: false,
      beforeHash,
      afterHash,
    };
  }

  const verificationError =
    params.verificationErrorMessage ?? "committed config failed verification";

  try {
    await restorePreTransactionSnapshot(deps.fs, beforeSnapshot, transactionId);
    deps.clearConfigCache();
    const restoredSnapshot = await deps.readConfigFileSnapshot();
    const restoredHash = resolveConfigSnapshotHash(restoredSnapshot);
    const rollbackMatches = (() => {
      if (!beforeSnapshot.exists) {
        return !restoredSnapshot.exists;
      }
      if (beforeHash) {
        return restoredHash === beforeHash;
      }
      return restoredSnapshot.exists;
    })();
    if (!rollbackMatches) {
      return {
        ok: false,
        transactionId,
        stage: "rollback",
        rolledBack: false,
        beforeHash,
        afterHash,
        error: `${verificationError}; rollback did not restore pre-transaction state`,
        issues: committedSnapshot.issues,
      };
    }
  } catch (err) {
    return {
      ok: false,
      transactionId,
      stage: "rollback",
      rolledBack: false,
      beforeHash,
      afterHash,
      error: `${verificationError}; rollback failed: ${String(err)}`,
      issues: committedSnapshot.issues,
    };
  }

  return {
    ok: false,
    transactionId,
    stage: "verify",
    rolledBack: true,
    beforeHash,
    afterHash,
    error: verificationError,
    issues: committedSnapshot.issues,
  };
}

export type RecoverConfigFromBackupsParams = {
  snapshot?: ConfigFileSnapshot;
  numberedBackupCount?: number;
};

export type ConfigBackupRecoveryResult = {
  recovered: boolean;
  configPath: string;
  sourceBackupPath: string | null;
  error?: string;
  issues?: ConfigFileSnapshot["issues"];
};

export async function recoverConfigFromBackups(
  params: RecoverConfigFromBackupsParams = {},
  overrides: ConfigTransactionDeps = {},
): Promise<ConfigBackupRecoveryResult> {
  const deps = normalizeDeps(overrides);
  const snapshot = params.snapshot ?? (await deps.readConfigFileSnapshot());
  if (snapshot.valid) {
    return {
      recovered: false,
      configPath: snapshot.path,
      sourceBackupPath: null,
    };
  }

  const numberedBackupCount = params.numberedBackupCount ?? DEFAULT_NUMBERED_BACKUP_COUNT;
  const candidates = listBackupCandidates(snapshot.path, numberedBackupCount);
  for (const candidatePath of candidates) {
    if (!deps.fs.existsSync(candidatePath)) {
      continue;
    }

    const backupIo = deps.createConfigIO({
      configPath: candidatePath,
      env: cloneProcessEnv(deps.env),
      logger: SILENT_LOGGER,
    });
    const backupSnapshot = await backupIo.readConfigFileSnapshot().catch(() => null);
    if (
      !backupSnapshot?.valid ||
      !backupSnapshot.exists ||
      typeof backupSnapshot.raw !== "string"
    ) {
      continue;
    }

    try {
      await writeRawAtomically(
        deps.fs,
        snapshot.path,
        backupSnapshot.raw,
        `recover-${crypto.randomUUID()}`,
      );
      deps.clearConfigCache();
      const restoredIo = deps.createConfigIO({
        configPath: snapshot.path,
        env: cloneProcessEnv(deps.env),
        logger: SILENT_LOGGER,
      });
      const restoredSnapshot = await restoredIo.readConfigFileSnapshot();
      if (!restoredSnapshot.valid) {
        return {
          recovered: false,
          configPath: snapshot.path,
          sourceBackupPath: candidatePath,
          issues: restoredSnapshot.issues,
        };
      }
      return {
        recovered: true,
        configPath: snapshot.path,
        sourceBackupPath: candidatePath,
      };
    } catch (err) {
      return {
        recovered: false,
        configPath: snapshot.path,
        sourceBackupPath: candidatePath,
        error: String(err),
        issues: snapshot.issues,
      };
    }
  }

  return {
    recovered: false,
    configPath: snapshot.path,
    sourceBackupPath: null,
    issues: snapshot.issues,
  };
}
