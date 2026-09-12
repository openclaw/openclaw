import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ensureAbsoluteDirectory } from "@openclaw/fs-safe/advanced";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { z } from "zod";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { redactSupportString } from "../logging/diagnostic-support-redaction.js";
import { runCommandBuffered } from "../process/exec.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { formatDiskSpaceBytes, tryReadDiskSpace } from "./disk-space.js";
import { hasNodeErrorCode } from "./path-guards.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { createPrivateSqliteTempDirectory } from "./sqlite-private-directory.js";
import { SQLITE_INSPECTION_BYTES_PER_SECOND } from "./sqlite-readonly-worker.js";
import {
  collectStateDatabasePaths,
  UpdateCandidateStateInventorySchema,
  UpdateCandidateSnapshotInventorySchema,
  UpdateCandidateStateSnapshotSchema,
} from "./update-candidate-state.js";
import { resolveUpdateCaptureRoot } from "./update-capture-paths.js";
import {
  UpdateSnapshotCapacityError,
  type UpdateSnapshotCapacity,
} from "./update-snapshot-capacity.js";

type SnapshotSize = { bytes: number; largest: number; pluginBytes: number | null };

async function measureSnapshotFiles(
  files: z.infer<typeof UpdateCandidateStateInventorySchema>,
): Promise<SnapshotSize> {
  let bytes = 0;
  let largest = 0;
  for (const {
    spellings: [file],
  } of files.values()) {
    let family = 0;
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try {
        family += (await fs.stat(file + suffix)).size;
      } catch (error) {
        if (!hasNodeErrorCode(error, "ENOENT")) {
          throw error;
        }
      }
    }
    bytes += family;
    largest = Math.max(largest, family);
  }
  return { bytes, largest, pluginBytes: null };
}

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

async function snapshotProgress(directory: string): Promise<string> {
  const facts: string[] = [];
  async function visit(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const file = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) {
          await visit(file);
        } else if (entry.isFile()) {
          const stat = await fs.stat(file);
          facts.push(`${file}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`);
        }
      } catch (error) {
        // The worker retires intermediate copies as it progresses.
        if (!hasNodeErrorCode(error, "ENOENT")) {
          throw error;
        }
      }
    }
  }
  await visit(directory);
  return facts.toSorted().join("\n");
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
  const initialFiles = await collectStateDatabasePaths(params);
  let size = await measureSnapshotFiles(initialFiles);
  let capacity = measureSnapshotCapacity(params.stateDir, size, params.env);
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
    params.signal?.throwIfAborted();
    // This path copies, compares, scans, compacts and hashes the same bytes.
    // Budget every pass at the read-only owner's conservative throughput.
    const budget = Math.max(
      params.timeoutMs ?? 300_000,
      300_000 +
        Math.ceil(
          (12 * size.bytes + 2 * (size.pluginBytes ?? 0)) / SQLITE_INSPECTION_BYTES_PER_SECOND,
        ) *
          1000,
    );
    const stalled = new AbortController();
    const finished = new AbortController();
    let deadline = Date.now() + budget;
    let previous = "";
    const monitor = (async () => {
      try {
        while (!finished.signal.aborted) {
          await sleep(Math.min(1000, Math.max(10, budget / 10)), undefined, {
            signal: finished.signal,
          });
          const current = await snapshotProgress(directory);
          if (current !== previous) {
            previous = current;
            deadline = Date.now() + budget;
          } else if (Date.now() >= deadline) {
            stalled.abort(
              new Error(
                `Update state snapshot made no progress for ${budget / 1000} seconds (${formatDiskSpaceBytes(size.bytes + (size.pluginBytes ?? 0))} of state and plugin files). Check storage performance before retrying.`,
              ),
            );
            break;
          }
        }
      } catch (error) {
        if (!finished.signal.aborted) {
          stalled.abort(error);
        }
      }
    })();
    try {
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
          baseEnv: params.workerEnv(directory),
          signal: AbortSignal.any([stalled.signal, ...(params.signal ? [params.signal] : [])]),
          killGraceMs: 500,
          maxOutputBytes: { stdout: 1024 * 1024, stderr: 20_000 },
        },
      );
      params.signal?.throwIfAborted();
      stalled.signal.throwIfAborted();
      if (result.code !== 0) {
        throw new Error(
          `Update state snapshot failed (${result.termination}): ${redactSupportString(result.stderr.toString("utf8"), { env: params.env, stateDir: params.stateDir }, { maxLength: 20_000 })}`,
        );
      }
      return JSON.parse(result.stdout.toString("utf8")) as unknown;
    } finally {
      finished.abort();
      await monitor;
    }
  };
  try {
    const inventory = UpdateCandidateSnapshotInventorySchema.parse(
      await run({ mode: "inventory" }),
    );
    size = {
      ...(await measureSnapshotFiles(inventory.databases)),
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
