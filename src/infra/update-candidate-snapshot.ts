import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureAbsoluteDirectory } from "@openclaw/fs-safe/advanced";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { redactSupportString } from "../logging/diagnostic-support-redaction.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { formatDiskSpaceBytes, tryReadDiskSpace } from "./disk-space.js";
import { extractErrorCode } from "./errors.js";
import { hasNodeErrorCode } from "./path-guards.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { createPrivateSqliteTempDirectory } from "./sqlite-private-directory.js";
import { measureUpdateStateFiles, withUpdateCandidateIoBudget } from "./update-candidate-io.js";
import {
  readUpdateCandidatePluginCodeLinks,
  type UpdateCandidatePluginCodeLink,
} from "./update-candidate-plugin-code-links.js";
import type { UpdateCandidateBundledSource } from "./update-candidate-plugins.js";
import {
  createUpdateStateInspectionDiagnostics,
  formatUpdateStateInspectionProgress,
} from "./update-candidate-state.diagnostics.js";
import {
  collectStateDatabasePaths,
  UpdateCandidateSnapshotInventorySchema,
  UpdateCandidateStateSnapshotSchema,
} from "./update-candidate-state.js";
import { resolveUpdateCaptureRoot } from "./update-capture-paths.js";
import { UpdateCaptureSpaceError } from "./update-capture-space.js";
import { checkUpdateDatabaseBackupSpace } from "./update-database-backup-space.js";
import { UPDATE_RUN_DIAGNOSTIC_LIMIT, UPDATE_RUN_TEXT_LIMIT } from "./update-run-limits.js";
import type { UpdateRunStep } from "./update-run-record.js";
import {
  UpdateSnapshotCapacityError,
  type UpdateSnapshotCapacity,
} from "./update-snapshot-capacity.js";
import type { UpdateStepResult } from "./update-step-result.js";

type SnapshotSize = { bytes: number; largest: number; pluginBytes: number | null };

function requiredSnapshotBytes(size: SnapshotSize, legacyCandidate = false): number {
  // Current workers keep one generation and process families sequentially.
  // Recovery, transform journals and publication without hard links can each
  // need one extra family, but do not overlap. No VACUUM or Doctor backup is
  // part of this copy phase. Keep the old allowance for older candidate workers.
  const sqliteBytes = legacyCandidate
    ? size.bytes * 2 + size.largest * 3
    : size.bytes + size.largest;
  return sqliteBytes + (size.pluginBytes ?? 0) + 64 * 1024 * 1024;
}

function measureSnapshotCapacity(
  stateDir: string,
  size: SnapshotSize,
  env: NodeJS.ProcessEnv,
  previous?: UpdateSnapshotCapacity,
  legacyCandidate = false,
): UpdateSnapshotCapacity {
  const roots: Array<{
    kind: NonNullable<UpdateSnapshotCapacity["selection"]>["kind"];
    directory: string;
  }> = [];
  if (env.TMPDIR?.trim()) {
    roots.push({ kind: "explicit-tmpdir", directory: path.resolve(env.TMPDIR) });
  }
  const configuredTempDir = os.tmpdir();
  // POSIX os.tmpdir() includes TMPDIR; keep its remaining defaults as a separate fallback.
  const systemTempDir =
    process.platform !== "win32" &&
    env.TMPDIR?.trim() &&
    path.resolve(configuredTempDir) === path.resolve(env.TMPDIR)
      ? process.env.TMP || process.env.TEMP || "/tmp"
      : configuredTempDir;
  roots.push(
    {
      kind: "state-volume",
      directory: resolveUpdateCaptureRoot(resolvePathViaExistingAncestorSync(stateDir)),
    },
    { kind: "system-tmpdir", directory: path.resolve(systemTempDir) },
  );
  const candidates = roots
    .filter(
      (root, index) => roots.findIndex((other) => other.directory === root.directory) === index,
    )
    .map((root) => {
      const candidate: UpdateSnapshotCapacity["candidates"][number] = {
        kind: root.kind,
        directory: root.directory,
        availableBytes: tryReadDiskSpace(root.directory)?.availableBytes ?? null,
      };
      const allocationError = previous?.candidates.find(
        (entry) => entry.directory === root.directory,
      )?.allocationError;
      if (allocationError) {
        candidate.allocationError = allocationError;
      }
      return candidate;
    });
  const requiredBytes = requiredSnapshotBytes(size, legacyCandidate);
  return {
    reason: "snapshot-capacity-insufficient",
    sqliteBytes: size.bytes,
    pluginBytes: size.pluginBytes,
    requiredBytes,
    candidates,
    selection: null,
  };
}

type InitialSnapshotParams = {
  config: OpenClawConfig;
  stateDir: string;
  env: NodeJS.ProcessEnv;
  /** Volume holding activation-time database backups, independent of candidate scratch. */
  backupDirectory?: string;
};

/** Measure known SQLite families without allocating state or reading the candidate plugin inventory. */
async function measureInitialUpdateSnapshotState(params: InitialSnapshotParams) {
  const files = await collectStateDatabasePaths(params);
  const size = await measureUpdateStateFiles(
    [...files.values()].map(({ spellings }) => spellings[0]),
  );
  return {
    capacity: measureSnapshotCapacity(params.stateDir, { ...size, pluginBytes: null }, params.env),
    size,
  };
}

export async function assessInitialUpdateSnapshotCapacity(
  params: InitialSnapshotParams,
): Promise<UpdateStepResult> {
  const started = Date.now();
  const step = {
    name: "snapshot-space-preflight",
    command: "snapshot-space-preflight",
    cwd: params.stateDir,
  };
  try {
    const { capacity, size } = await measureInitialUpdateSnapshotState(params);
    // Refuse only at the existing allocator's data-at-risk boundary: every
    // eligible destination is known to be too small for the private state copy.
    const refused =
      capacity.candidates.length > 0 &&
      capacity.candidates.every(
        (candidate) =>
          candidate.availableBytes !== null && candidate.availableBytes < capacity.requiredBytes,
      );
    const diagnostics = [
      "Snapshot size estimate: plugin copies and registered external databases are measured after staging.",
      `Initial snapshot needs ${formatDiskSpaceBytes(capacity.requiredBytes)} for ${formatDiskSpaceBytes(capacity.sqliteBytes)} of known SQLite files and temporary working space.`,
      ...capacity.candidates.map(
        (candidate) =>
          `${candidate.kind} ${candidate.directory}: ${formatDiskSpaceBytes(capacity.requiredBytes)} needed; ${candidate.availableBytes === null ? "free space unknown" : `${formatDiskSpaceBytes(candidate.availableBytes)} free`}.`,
      ),
      ...size.families
        .toSorted((left, right) => right.bytes - left.bytes)
        .map(
          (family) =>
            `SQLite family ${family.path}: ${formatDiskSpaceBytes(family.bytes)} (database and supporting files).`,
        ),
    ];
    if (refused) {
      return {
        ...step,
        durationMs: Date.now() - started,
        exitCode: 1,
        stderrTail: [
          "snapshot-capacity-insufficient: no eligible directory has enough free space for the required state snapshot.",
          ...diagnostics,
          "Free space on a reported filesystem or set TMPDIR to a writable directory with enough space, then retry the update.",
        ].join("\n"),
        snapshotCapacity: capacity,
      };
    }
    let warnings: string[] = [];
    if (params.backupDirectory) {
      try {
        const backup = await checkUpdateDatabaseBackupSpace(params.backupDirectory, size, params);
        diagnostics.push(...backup.diagnostics);
        warnings = backup.warnings;
      } catch (error) {
        if (!(error instanceof UpdateCaptureSpaceError)) {
          throw error;
        }
        return {
          ...step,
          durationMs: Date.now() - started,
          exitCode: 1,
          stderrTail: [
            "snapshot-capacity-insufficient: activation database backup or rollback cannot fit before validation.",
            error.message,
            ...diagnostics,
          ].join("\n"),
        };
      }
    }
    return {
      ...step,
      durationMs: Date.now() - started,
      exitCode: 0,
      diagnostics,
      ...(warnings.length ? { warnings } : {}),
    };
  } catch {
    return {
      ...step,
      durationMs: Date.now() - started,
      exitCode: 0,
      warnings: [
        "Initial snapshot capacity could not be measured; continuing to the update snapshot check.",
      ],
    };
  }
}

async function allocateSnapshotRoot(
  capacity: UpdateSnapshotCapacity,
  current?: { root: string; directory: string },
): Promise<string> {
  const fits = (candidate: UpdateSnapshotCapacity["candidates"][number]) =>
    candidate.availableBytes !== null && candidate.availableBytes >= capacity.requiredBytes;
  for (const candidate of capacity.candidates.filter(fits)) {
    if (candidate.allocationError) {
      continue;
    }
    try {
      let directory = current?.root === candidate.directory ? current.directory : undefined;
      if (!directory) {
        const root =
          candidate.kind === "state-volume"
            ? candidate.directory
            : resolvePathViaExistingAncestorSync(candidate.directory);
        const ensured = await ensureAbsoluteDirectory(root, {
          mode: 0o700,
          scopeLabel: "update snapshot",
        });
        if (!ensured.ok) {
          throw ensured.error;
        }
        directory = await fs.realpath(
          await createPrivateSqliteTempDirectory(root, "openclaw-update-canary-"),
        );
      }
      capacity.reason = candidate.kind;
      capacity.selection = { kind: candidate.kind, directory: candidate.directory };
      return directory;
    } catch (error) {
      if (
        !(error instanceof FsSafeError) &&
        !["EACCES", "EPERM", "EROFS", "ENOTDIR", "ENOENT", "EEXIST", "ELOOP", "ENOSPC"].some(
          (code) => hasNodeErrorCode(error, code),
        )
      ) {
        throw error;
      }
      candidate.allocationError = error instanceof Error ? error.message : String(error);
    }
  }
  capacity.reason = capacity.candidates.some(fits)
    ? "snapshot-location-unavailable"
    : "snapshot-capacity-insufficient";
  throw new UpdateSnapshotCapacityError(capacity);
}

/** The parent owns both the child and its scratch root, including a killed SQLite operation. */
export async function prepareUpdateCandidateStateSnapshot(params: {
  config: OpenClawConfig;
  candidateRoot: string;
  sourceBundledPlugins?: UpdateCandidateBundledSource;
  stateDir: string;
  env: NodeJS.ProcessEnv;
  workerEnv: (directory: string) => NodeJS.ProcessEnv;
  nodeRunner?: string;
  fullIntegrityCheck?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  onProgress?: (step: UpdateRunStep) => void | Promise<void>;
}): Promise<{
  stateDir: string;
  pluginPaths: Record<string, string>;
  pluginCodeLinks: UpdateCandidatePluginCodeLink[];
  snapshotCapacity: UpdateSnapshotCapacity;
  snapshotDiagnostics: string[];
  snapshotWarnings: string[];
  cleanupDirectories: string[];
}> {
  let { capacity } = await measureInitialUpdateSnapshotState(params);
  params.signal?.throwIfAborted();
  params.assertCurrent?.();
  let directory = await allocateSnapshotRoot(capacity);
  let selectedRoot = capacity.selection!;
  const inventoryDirectory = directory;
  const snapshotDiagnostics: string[] = [];
  const startedAtMs = Date.now();
  const cleanupDirectories = () => [...new Set([directory, inventoryDirectory])];
  const run = async (
    request:
      | { mode: "inventory" }
      | {
          mode: "snapshot";
          pluginPlanPath: string;
          databaseInventory: string[];
        },
  ) => {
    const workerEnv = params.workerEnv(directory);
    const outputController = new AbortController();
    let progressPending = Promise.resolve();
    let progressWriting = false;
    let nextProgress: UpdateRunStep | undefined;
    let progressFailure: { error: unknown } | undefined;
    const failProgress = (error: unknown) => {
      progressFailure = { error };
      outputController.abort(error);
    };
    let stderrOutputExceeded = false;
    const diagnostics = createUpdateStateInspectionDiagnostics({
      operation: "State snapshot",
      phase: request.mode,
      paths: [params.stateDir],
      stderrLimit: {
        bytes: 20_000,
        onExceeded: () => {
          stderrOutputExceeded = true;
          outputController.abort(new Error("Update snapshot diagnostic output exceeded its limit"));
        },
      },
      onProgress: (progress) => {
        const detail = redactSupportString(
          formatUpdateStateInspectionProgress(progress),
          { env: params.env, stateDir: params.stateDir },
          { maxLength: UPDATE_RUN_TEXT_LIMIT },
        );
        nextProgress = {
          step: "candidate-state-snapshot",
          status: "in_progress",
          startedAtMs,
          detail,
        };
        if (!progressWriting && !progressFailure) {
          progressWriting = true;
          progressPending = (async () => {
            try {
              // Keep one write in flight and only the latest advisory observation behind it.
              while (nextProgress) {
                const step = nextProgress;
                nextProgress = undefined;
                await params.onProgress?.(step);
              }
            } catch (error) {
              failProgress(error);
            } finally {
              progressWriting = false;
            }
          })();
        }
        if (
          progress.snapshot?.status === "completed" &&
          snapshotDiagnostics.length < UPDATE_RUN_DIAGNOSTIC_LIMIT
        ) {
          snapshotDiagnostics.push(detail);
        }
      },
    });
    params.signal?.throwIfAborted();
    params.assertCurrent?.();
    const sourceSelectors =
      params.env.OPENCLAW_STATE_DIR?.trim() || params.env.OPENCLAW_CONFIG_PATH?.trim()
        ? {
            OPENCLAW_STATE_DIR: params.env.OPENCLAW_STATE_DIR,
            OPENCLAW_CONFIG_PATH: params.env.OPENCLAW_CONFIG_PATH,
          }
        : { OPENCLAW_STATE_DIR: params.stateDir };
    let workerTermination = "exit";
    let budgetSignal: AbortSignal | undefined;
    const outcome = await withUpdateCandidateIoBudget(
      {
        directory,
        bytes: capacity.sqliteBytes + (capacity.pluginBytes ?? 0),
        timeoutMs: params.timeoutMs,
        signal: params.signal,
        operation: "snapshot",
      },
      async (signal) => {
        budgetSignal = signal;
        signal.throwIfAborted();
        params.assertCurrent?.();
        const result = await runUtf8CommandWithTimeout(
          [
            params.nodeRunner ?? process.execPath,
            ...resolveRuntimeWorkerArgv(
              resolveRuntimeWorkerUrl({
                ...runtimeProcessEntrypoints.updateCandidateState,
                root: params.candidateRoot,
              }),
              params.nodeRunner,
            ),
          ],
          {
            input: JSON.stringify({
              ...request,
              includeLocalStoreVersions: true,
              includeClientCredentialStoreVersion: true,
              streamProgress: true,
              stateDir: params.stateDir,
              config: params.config,
              targetStateDir: directory,
              candidateRoot: params.candidateRoot,
              sourceBundledPlugins: params.sourceBundledPlugins,
              fullIntegrityCheck: params.fullIntegrityCheck,
              env: {
                HOME: params.env.HOME,
                OPENCLAW_HOME: params.env.OPENCLAW_HOME,
                USERPROFILE: params.env.USERPROFILE,
                ...sourceSelectors,
                OPENCLAW_AGENT_DIR: params.env.OPENCLAW_AGENT_DIR,
                PI_CODING_AGENT_DIR: params.env.PI_CODING_AGENT_DIR,
                OPENCLAW_BUNDLED_PLUGINS_DIR: params.env.OPENCLAW_BUNDLED_PLUGINS_DIR,
                OPENCLAW_DISABLE_BUNDLED_PLUGINS: params.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS,
              },
            }),
            baseEnv: workerEnv,
            signal: AbortSignal.any([signal, outputController.signal]),
            killGraceMs: 500,
            killProcessTree: true,
            requireProcessTreeExtinction: true,
            maxOutputBytes: { stdout: 1024 * 1024, stderr: 20_000 },
            outputCapture: { stdout: "head", stderr: "discard" },
            terminateOnOutputLimit: { stdout: true },
            onOutputChunk: diagnostics.onOutputChunk,
          },
        );
        if (result.cleanup === "uncertain") {
          throw Object.assign(new Error("Update snapshot worker settlement is uncertain"), {
            cleanup: result.cleanup,
          });
        }
        workerTermination =
          result.outputLimitExceeded || stderrOutputExceeded ? "output-limit" : result.termination;
        signal.throwIfAborted();
        if (progressFailure) {
          throw progressFailure.error;
        }
        if (
          result.code !== 0 ||
          result.termination !== "exit" ||
          result.outputLimitExceeded ||
          stderrOutputExceeded
        ) {
          throw new Error(diagnostics.stderr() || result.stderr);
        }
        return JSON.parse(result.stdout) as unknown;
      },
    ).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await progressPending;
    if (progressFailure && hasCommandProcessCleanupError(progressFailure.error)) {
      if ("error" in outcome && outcome.error !== progressFailure.error) {
        throw new AggregateError(
          [outcome.error, progressFailure.error],
          "Update snapshot and progress recording failed",
          { cause: outcome.error },
        );
      }
      throw progressFailure.error;
    }
    if ("error" in outcome || params.signal?.aborted) {
      const error = "error" in outcome ? outcome.error : params.signal?.reason;
      if (
        hasCommandProcessCleanupError(error) ||
        (isRecord(error) && error.cleanup === "uncertain") ||
        (progressFailure && error === progressFailure.error)
      ) {
        throw error;
      }
      const termination = params.signal?.aborted
        ? "cancelled"
        : budgetSignal?.aborted
          ? "timeout"
          : workerTermination;
      const failure = diagnostics.failure(error, termination);
      throw Object.assign(
        new Error(
          `Update state snapshot failed (${termination}): ${redactSupportString(
            failure.message,
            { env: params.env, stateDir: params.stateDir },
            { maxLength: 20_000 },
          )}`,
          { cause: error },
        ),
        { code: extractErrorCode(failure) },
      );
    }
    params.assertCurrent?.();
    if (progressFailure) {
      throw progressFailure.error;
    }
    return outcome.value;
  };
  try {
    const inventory = UpdateCandidateSnapshotInventorySchema.parse(
      await run({ mode: "inventory" }),
    );
    const size: SnapshotSize = {
      ...(await measureUpdateStateFiles(
        [...inventory.databases.values()].map(({ spellings }) => spellings[0]),
      )),
      pluginBytes: inventory.pluginBytes,
    };
    capacity = measureSnapshotCapacity(
      params.stateDir,
      size,
      params.env,
      capacity,
      inventory.snapshotSpace !== "single-generation",
    );
    params.signal?.throwIfAborted();
    params.assertCurrent?.();
    directory = await allocateSnapshotRoot(capacity, { root: selectedRoot.directory, directory });
    selectedRoot = capacity.selection!;
    const pluginPlanPath = path.join(inventoryDirectory, inventory.pluginPlan);
    const { pluginPaths, pluginCodeLinks } = UpdateCandidateStateSnapshotSchema.parse(
      await run({
        mode: "snapshot",
        pluginPlanPath,
        databaseInventory: [...inventory.databases.keys()],
      }),
    );
    return {
      stateDir: directory,
      pluginPaths,
      pluginCodeLinks: pluginCodeLinks
        ? await readUpdateCandidatePluginCodeLinks(pluginPlanPath, pluginCodeLinks)
        : [],
      snapshotCapacity: { ...capacity, selection: { ...selectedRoot, directory } },
      snapshotDiagnostics,
      snapshotWarnings: inventory.warnings.map((warning) =>
        redactSupportString(
          warning,
          { env: params.env, stateDir: params.stateDir },
          { maxLength: UPDATE_RUN_TEXT_LIMIT },
        ),
      ),
      cleanupDirectories: cleanupDirectories(),
    };
  } catch (error) {
    if (
      hasCommandProcessCleanupError(error) ||
      (isRecord(error) && error.cleanup === "uncertain")
    ) {
      throw Object.assign(
        new Error(
          `Update snapshot cleanup could not be confirmed; retained scratch: ${cleanupDirectories().join(", ")}`,
          { cause: error },
        ),
        { cleanup: "uncertain" },
      );
    }
    for (const ownedDirectory of cleanupDirectories()) {
      await fs.rm(ownedDirectory, { recursive: true, force: true });
    }
    throw error;
  }
}
