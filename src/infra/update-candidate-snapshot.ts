import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureAbsoluteDirectory } from "@openclaw/fs-safe/advanced";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { redactSupportString } from "../logging/diagnostic-support-redaction.js";
import { runCommandBuffered } from "../process/exec.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { tryReadDiskSpace } from "./disk-space.js";
import { hasNodeErrorCode } from "./path-guards.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { createPrivateSqliteTempDirectory } from "./sqlite-private-directory.js";
import { measureUpdateStateFiles, withUpdateCandidateIoBudget } from "./update-candidate-io.js";
import {
  collectStateDatabasePaths,
  UpdateCandidateSnapshotInventorySchema,
  UpdateCandidateStateSnapshotSchema,
} from "./update-candidate-state.js";
import { resolveUpdateCaptureRoot } from "./update-capture-paths.js";
import type { UpdateStepResult } from "./update-runner-types.js";
import {
  UpdateSnapshotCapacityError,
  type UpdateSnapshotCapacity,
} from "./update-snapshot-capacity.js";

type SnapshotSize = { bytes: number; largest: number; pluginBytes: number | null };

function requiredSnapshotBytes(size: SnapshotSize): number {
  // Keep the completed generation and Doctor backup, plus the largest raw,
  // compacting and publication copies. Metadata needs room on an empty state too.
  return size.bytes * 2 + size.largest * 3 + (size.pluginBytes ?? 0) + 64 * 1024 * 1024;
}

function measureSnapshotCapacity(
  stateDir: string,
  size: SnapshotSize,
  env: NodeJS.ProcessEnv,
  previous?: UpdateSnapshotCapacity,
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
  const requiredBytes = requiredSnapshotBytes(size);
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
};

/** Measure known SQLite families without allocating state or reading the candidate plugin inventory. */
async function measureInitialUpdateSnapshotState(params: InitialSnapshotParams) {
  const files = await collectStateDatabasePaths(params);
  const size = await measureUpdateStateFiles(
    [...files.values()].map(({ spellings }) => spellings[0]),
  );
  return {
    capacity: measureSnapshotCapacity(params.stateDir, { ...size, pluginBytes: null }, params.env),
    families: size.families,
  };
}

export async function assessInitialUpdateSnapshotCapacity(
  params: InitialSnapshotParams,
): Promise<UpdateStepResult> {
  const started = Date.now();
  const warnings = [
    "Snapshot capacity estimate incomplete: plugin copies and registered external databases are measured after staging.",
  ];
  const step = {
    name: "snapshot-space-preflight",
    command: "snapshot-space-preflight",
    cwd: params.stateDir,
  };
  try {
    const { capacity, families } = await measureInitialUpdateSnapshotState(params);
    // Refuse only at the existing allocator's data-at-risk boundary: every
    // eligible destination is known to be too small for the private state copy.
    const refused =
      capacity.candidates.length > 0 &&
      capacity.candidates.every(
        (candidate) =>
          candidate.availableBytes !== null && candidate.availableBytes < capacity.requiredBytes,
      );
    const diagnostics = [
      `Initial snapshot needs ${capacity.requiredBytes} bytes for ${capacity.sqliteBytes} known SQLite-family bytes and the existing snapshot scratch allowance.`,
      ...capacity.candidates.map(
        (candidate) =>
          `${candidate.kind} ${candidate.directory}: ${capacity.requiredBytes} bytes needed; ${candidate.availableBytes === null ? "free space unknown" : `${candidate.availableBytes} bytes free`}.`,
      ),
      ...families.map(
        (family) =>
          `SQLite family ${family.path}: ${family.bytes} bytes (database, WAL, SHM, and journal).`,
      ),
    ];
    warnings.push(...diagnostics);
    if (refused) {
      return {
        ...step,
        durationMs: Date.now() - started,
        exitCode: 1,
        stderrTail: [
          "snapshot-capacity-insufficient: no eligible directory has enough free space for the required state snapshot.",
          ...warnings,
          "Free space on a reported filesystem or set TMPDIR to a writable directory with enough space, then retry the update.",
        ].join("\n"),
        warnings,
        snapshotCapacity: capacity,
      };
    }
    return {
      ...step,
      durationMs: Date.now() - started,
      exitCode: 0,
      stdoutTail:
        "Continuing with the initial snapshot estimate; the complete inventory is checked after staging.",
      warnings,
    };
  } catch {
    warnings.push(
      "Initial snapshot capacity could not be measured; continuing to the update snapshot check.",
    );
    return {
      ...step,
      durationMs: Date.now() - started,
      exitCode: 0,
      warnings,
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
  stateDir: string;
  env: NodeJS.ProcessEnv;
  workerEnv: (directory: string) => NodeJS.ProcessEnv;
  nodeRunner?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{
  stateDir: string;
  pluginPaths: Record<string, string>;
  snapshotCapacity: UpdateSnapshotCapacity;
  cleanupDirectories: string[];
}> {
  let { capacity } = await measureInitialUpdateSnapshotState(params);
  let directory = await allocateSnapshotRoot(capacity);
  let selectedRoot = capacity.selection!;
  const inventoryDirectory = directory;
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
    return await withUpdateCandidateIoBudget(
      {
        directory,
        bytes: capacity.sqliteBytes + (capacity.pluginBytes ?? 0),
        timeoutMs: params.timeoutMs,
        signal: params.signal,
        operation: "snapshot",
        nodeRunner: params.nodeRunner,
        env: workerEnv,
      },
      async (signal) => {
        const result = await runCommandBuffered(
          [
            params.nodeRunner ?? process.execPath,
            ...resolveRuntimeWorkerArgv(
              resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.updateCandidateState),
              params.nodeRunner,
            ),
          ],
          {
            input: JSON.stringify({
              ...request,
              stateDir: params.stateDir,
              config: params.config,
              targetStateDir: directory,
              candidateRoot: params.candidateRoot,
              env: {
                HOME: params.env.HOME,
                OPENCLAW_HOME: params.env.OPENCLAW_HOME,
                USERPROFILE: params.env.USERPROFILE,
                OPENCLAW_AGENT_DIR: params.env.OPENCLAW_AGENT_DIR,
                PI_CODING_AGENT_DIR: params.env.PI_CODING_AGENT_DIR,
                OPENCLAW_BUNDLED_PLUGINS_DIR: params.env.OPENCLAW_BUNDLED_PLUGINS_DIR,
                OPENCLAW_DISABLE_BUNDLED_PLUGINS: params.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS,
              },
            }),
            baseEnv: workerEnv,
            signal,
            killGraceMs: 500,
            maxOutputBytes: { stdout: 1024 * 1024, stderr: 20_000 },
          },
        );
        signal.throwIfAborted();
        if (result.code !== 0) {
          throw new Error(
            `Update state snapshot failed (${result.termination}): ${redactSupportString(result.stderr.toString("utf8"), { env: params.env, stateDir: params.stateDir }, { maxLength: 20_000 })}`,
          );
        }
        return JSON.parse(result.stdout.toString("utf8")) as unknown;
      },
    );
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
    capacity = measureSnapshotCapacity(params.stateDir, size, params.env, capacity);
    directory = await allocateSnapshotRoot(capacity, { root: selectedRoot.directory, directory });
    selectedRoot = capacity.selection!;
    const { pluginPaths } = UpdateCandidateStateSnapshotSchema.parse(
      await run({
        mode: "snapshot",
        pluginPlanPath: path.join(inventoryDirectory, inventory.pluginPlan),
        databaseInventory: [...inventory.databases.keys()],
      }),
    );
    return {
      stateDir: directory,
      pluginPaths,
      snapshotCapacity: { ...capacity, selection: { ...selectedRoot, directory } },
      cleanupDirectories: cleanupDirectories(),
    };
  } catch (error) {
    for (const ownedDirectory of cleanupDirectories()) {
      await fs.rm(ownedDirectory, { recursive: true, force: true });
    }
    throw error;
  }
}
