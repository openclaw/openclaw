import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  clearConfigCache,
  createConfigIO,
  readConfigFileSnapshot,
  resolveConfigSnapshotHash,
  type ConfigWriteOptions,
  writeConfigFile as writeConfigFileDirect,
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
  writeConfigFile?: typeof writeConfigFileDirect;
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
    writeConfigFile: overrides.writeConfigFile ?? writeConfigFileDirect,
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
    // Best effort only.
  });
  try {
    await ioFs.promises.rename(replaceTmpPath, configPath);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!isRenameReplaceBlocked(code)) {
      throw err;
    }
    await ioFs.promises.rm(configPath, { force: true });
    await ioFs.promises.rename(replaceTmpPath, configPath);
  } finally {
    await ioFs.promises.rm(replaceTmpPath, { force: true }).catch(() => {
      // Best effort only.
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
      // Best effort only.
    });
  }
}

async function restorePreTransactionSnapshot(
  ioFs: typeof fs,
  snapshot: ConfigFileSnapshot,
  transactionId: string,
): Promise<void> {
  if (!snapshot.exists) {
    await ioFs.promises.rm(snapshot.path, { force: true }).catch(() => {
      // Best effort only.
    });
    return;
  }
  if (typeof snapshot.raw !== "string") {
    throw new Error(
      "cannot rollback: pre-transaction config existed but its content was unreadable",
    );
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
      // Best effort only.
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
  const stagingIo = params.deps.createConfigIO({
    configPath: stagingPath,
    env: cloneProcessEnv(params.deps.env),
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
  expectedBaseHash?: string | null;
};

function normalizeExpectedBaseHash(expectedBaseHash: string | null | undefined): string | null {
  if (typeof expectedBaseHash !== "string") {
    return null;
  }
  const trimmed = expectedBaseHash.trim();
  return trimmed ? trimmed : null;
}

function buildExpectedBaseHashMismatchError(params: {
  expectedBaseHash: string;
  currentHash: string | null;
}): string {
  return `config base hash mismatch: expected ${params.expectedBaseHash}, current ${params.currentHash ?? "none"}`;
}

export async function runConfigWriteTransaction(
  params: RunConfigWriteTransactionParams,
  overrides: ConfigTransactionDeps = {},
): Promise<ConfigWriteTransactionResult> {
  const deps = normalizeDeps(overrides);
  const transactionId = crypto.randomUUID();
  const writeOptions = params.writeOptions ?? {};
  const expectedBaseHash = normalizeExpectedBaseHash(params.expectedBaseHash);
  const beforeSnapshot = await deps.readConfigFileSnapshot();
  const beforeHash = resolveConfigSnapshotHash(beforeSnapshot);

  if (expectedBaseHash && beforeHash !== expectedBaseHash) {
    return {
      ok: false,
      transactionId,
      stage: "prepare",
      rolledBack: false,
      beforeHash,
      afterHash: null,
      error: buildExpectedBaseHashMismatchError({
        expectedBaseHash,
        currentHash: beforeHash,
      }),
      issues: beforeSnapshot.issues,
    };
  }

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

  if (expectedBaseHash) {
    // Re-check right before commit to narrow the race window for concurrent writers.
    const latestSnapshot = await deps.readConfigFileSnapshot();
    const latestHash = resolveConfigSnapshotHash(latestSnapshot);
    if (latestHash !== expectedBaseHash) {
      return {
        ok: false,
        transactionId,
        stage: "prepare",
        rolledBack: false,
        beforeHash,
        afterHash: null,
        error: buildExpectedBaseHashMismatchError({
          expectedBaseHash,
          currentHash: latestHash,
        }),
        issues: latestSnapshot.issues,
      };
    }
  }

  try {
    await deps.writeConfigFile(params.config, writeOptions);
  } catch (err) {
    const postFailSnapshot = await deps.readConfigFileSnapshot().catch(() => null);
    const postFailHash = postFailSnapshot ? resolveConfigSnapshotHash(postFailSnapshot) : null;
    const fileChanged = postFailHash !== null && postFailHash !== beforeHash;
    if (fileChanged) {
      try {
        await restorePreTransactionSnapshot(deps.fs, beforeSnapshot, transactionId);
        deps.clearConfigCache();
        return {
          ok: false,
          transactionId,
          stage: "commit",
          rolledBack: true,
          beforeHash,
          afterHash: postFailHash,
          error: String(err),
        };
      } catch {
        // Preserve the original commit error and report rollback failure via rolledBack=false.
      }
    }
    return {
      ok: false,
      transactionId,
      stage: "commit",
      rolledBack: false,
      beforeHash,
      afterHash: fileChanged ? postFailHash : null,
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
  // Commit writes the production file before this verify step. If verification
  // fails, we restore the previous snapshot immediately, but file watchers may
  // still observe the short-lived bad commit.
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
