import fs from "node:fs/promises";
import path from "node:path";
import { isMissingPathError } from "../../infra/errors.js";
import { withContentGitSlot } from "../../infra/git-content-budget.js";
import { enqueueGitRefMutation, requireGitCommandOutput } from "../../infra/git-exec.js";
import { lstatIfExists } from "../../infra/path-existence.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runCommandBuffersWithTimeout } from "../../process/exec-runner.js";
import {
  withChildProcessOperation,
  type GitProcessOperation,
} from "../../process/spawn-diagnostics.js";
import {
  ProjectCheckoutBusyError,
  withProjectCheckoutLifecycle,
} from "../../projects/project-checkout.js";
import {
  readConfigMachineStateAsync,
  writeConfigMachineStateAsync,
} from "../../state/config-machine-state-async.js";
import { WorktreeGcProgress } from "./gc-progress.js";
import { listGitWorktrees, requireGit, resolveGitMetadataPath, runGit } from "./git.js";
import { readRegistryWorktrees } from "./registry-read.js";
import type { ManagedWorktreeGcResult } from "./types.js";

const log = createSubsystemLogger("agents/worktrees");
const operation: GitProcessOperation = "worktree.maintenance";
const WORKTREE_GIT_MAINTENANCE_TIMEOUT_MS = 30 * 60 * 1000;
const PACK_BATCH_BYTES = 16 * 1024 * 1024 * 1024;
// Index size bounds object metadata even when many tiny blobs compress well.
const PACK_BATCH_INDEX_BYTES = 128 * 1024 * 1024;
const PACK_BATCH_COUNT = 1024;
const PACK_BATCH_TIMEOUT_MS = WORKTREE_GIT_MAINTENANCE_TIMEOUT_MS;
const TEMP_PACK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const OBJECT_REPAIR_TIMEOUT_MS = 5 * 60 * 1000;
const OBJECT_REPAIR_BATCH_SIZE = 256;
const OBJECT_REPAIR_MAX_OBJECTS = 4096;

type MaintenanceParams = {
  signal?: AbortSignal;
  commitGuard?: () => void;
  retryDeferred?: boolean;
  progress?: WorktreeGcProgress;
  checkpoint?: (progress: ManagedWorktreeGcResult) => Promise<void>;
};

async function repairWorktreeObjects(
  repoRoot: string,
  remote: string,
  env: NodeJS.ProcessEnv,
  params: Pick<MaintenanceParams, "signal" | "commitGuard">,
): Promise<void> {
  const started = performance.now();
  const fetched = new Set<string>();
  const options = () => {
    params.signal?.throwIfAborted();
    params.commitGuard?.();
    const remaining = OBJECT_REPAIR_TIMEOUT_MS - (performance.now() - started);
    if (remaining <= 0) {
      throw new Error(
        `Worktree object repair exceeded its five-minute budget (${fetched.size} objects fetched); retry to continue from the next worktree`,
      );
    }
    return {
      operation,
      executionIntent: "agent-tool" as const,
      signal: params.signal,
      beforeRun: () => {
        params.signal?.throwIfAborted();
        params.commitGuard?.();
      },
      timeoutMs: Math.ceil(remaining),
      maxOutputBytes: 32 * 1024 * 1024,
      killProcessTree: true,
      lowerPriority: true,
      env: { GIT_NO_LAZY_FETCH: "1" },
    };
  };
  const worktrees = (await listGitWorktrees(repoRoot, options())).toSorted((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const cursorKey = `worktrees.objectRepair:${repoRoot}`;
  const cursor = await readConfigMachineStateAsync<string | null>(cursorKey, { env });
  const start = Math.max(0, cursor ? worktrees.findIndex((tree) => tree.path > cursor) : 0);
  for (const worktree of [...worktrees.slice(start), ...worktrees.slice(0, start)]) {
    options();
    // This is a scheduling position, never a healthy-object receipt. Record the
    // attempt first so an interrupted or unreadable checkout cannot starve siblings.
    await writeConfigMachineStateAsync(cursorKey, worktree.path, { env });
    for (;;) {
      // Include this index's resolve-undo objects, but not every linked index.
      // Quiet suppresses healthy OIDs while preserving Git's missing-object output.
      const inventory = await requireGit(
        worktree.path,
        [
          "rev-list",
          "--objects",
          "--single-worktree",
          "--indexed-objects",
          "--no-walk=unsorted",
          "--missing=print",
          "--quiet",
          "--stdin",
        ],
        {
          ...options(),
          input: worktree.head && !/^0+$/.test(worktree.head) ? `${worktree.head}\n` : "",
        },
      );
      const missing = inventory
        .split("\n")
        .filter((line) => line.startsWith("?"))
        .map((line) => line.slice(1));
      if (missing.length === 0) {
        break;
      }
      if (missing.some((oid) => fetched.has(oid))) {
        throw new Error("Worktree object repair incomplete; inspect the promisor remote and retry");
      }
      if (fetched.size >= OBJECT_REPAIR_MAX_OBJECTS) {
        throw new Error(
          `Worktree object repair reached its ${OBJECT_REPAIR_MAX_OBJECTS}-object limit; retry to recover the remaining objects`,
        );
      }
      for (
        let offset = 0;
        offset < missing.length && fetched.size < OBJECT_REPAIR_MAX_OBJECTS;
        offset += OBJECT_REPAIR_BATCH_SIZE
      ) {
        const batch = missing.slice(
          offset,
          offset + Math.min(OBJECT_REPAIR_BATCH_SIZE, OBJECT_REPAIR_MAX_OBJECTS - fetched.size),
        );
        try {
          await requireGit(
            repoRoot,
            [
              "fetch",
              "--refetch",
              "--no-auto-maintenance",
              "--no-tags",
              "--no-prune",
              "--no-write-fetch-head",
              "--recurse-submodules=no",
              "--stdin",
              "--",
              remote,
            ],
            {
              ...options(),
              input: `${batch.join("\n")}\n`,
            },
          );
        } catch {
          options();
          // Remote diagnostics may include credentials; report the recovery action.
          throw new Error(
            `Could not fetch ${batch.length} missing worktree objects; check promisor remote access and retry`,
          );
        }
        for (const oid of batch) {
          fetched.add(oid);
        }
      }
    }
  }
  options();
  await writeConfigMachineStateAsync(cursorKey, null, { env });
  if (fetched.size > 0) {
    log.info(`Repaired ${fetched.size} missing live worktree objects in ${repoRoot}.`);
  }
}

async function maintainWorktreePacks(
  repoRoot: string,
  params: Pick<MaintenanceParams, "signal" | "commitGuard">,
  report: (before: number, after?: number) => Promise<void>,
): Promise<void> {
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    params.commitGuard?.();
  };
  const options = {
    operation,
    executionIntent: "agent-tool" as const,
    signal: params.signal,
    beforeRun: assertCurrent,
    timeoutMs: WORKTREE_GIT_MAINTENANCE_TIMEOUT_MS,
    killProcessTree: true,
    lowerPriority: true,
    env: { GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" },
  };
  const packDirectory = await withContentGitSlot(
    () => resolveGitMetadataPath(repoRoot, "objects/pack", options),
    params.signal,
  );
  // Git rejects an empty pack directory; inspect only this shallow metadata directory.
  const readPacks = () =>
    fs.readdir(packDirectory).catch((error: unknown) => {
      if (isMissingPathError(error)) {
        return [];
      }
      throw error;
    });
  if ((await readPacks()).length === 0) {
    // Packs arriving after this inventory can wait until the next maintenance pass.
    assertCurrent();
    await report(0, 0);
    return;
  }
  const commonDir = await requireGit(repoRoot, ["rev-parse", "--git-common-dir"], options);
  // Content writers acquire their slot before publishing refs; keep that order
  // so maintenance cannot hold the ref queue while waiting for those writers.
  await withContentGitSlot(
    () =>
      enqueueGitRefMutation(
        repoRoot,
        commonDir,
        async () => {
          const packs = await readPacks();
          assertCurrent();
          const before = packs.filter((name) => name.endsWith(".pack")).length;
          await report(before);
          await cleanTemporaryPacks(packDirectory, packs, params.signal, assertCurrent);
          const after = await consolidatePacks(repoRoot, packDirectory, packs, options);
          await report(before, after);
        },
        params.signal,
      ),
    params.signal,
  );
}

async function cleanTemporaryPacks(
  directory: string,
  names: string[],
  signal: AbortSignal | undefined,
  assertCurrent: () => void,
) {
  const files = names
    .filter((name) => /^tmp_pack_[a-zA-Z0-9_-]+$/.test(name))
    .map((name) => path.join(directory, name));
  if (process.platform !== "linux" || files.length === 0) {
    return;
  }
  assertCurrent();
  const result = await withChildProcessOperation("worktree.maintenance", () =>
    runCommandBuffersWithTimeout(
      [
        process.execPath,
        ...resolveRuntimeWorkerArgv(
          resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.gitPackCleanup),
        ),
      ],
      {
        input: JSON.stringify({ files, olderThan: Date.now() - TEMP_PACK_MAX_AGE_MS }),
        beforeInput: assertCurrent,
        executionIntent: "agent-tool",
        signal,
        timeoutMs: 30_000,
        killProcessTree: true,
        requireProcessTreeExtinction: true,
        maxOutputBytes: 4096,
      },
    ),
  );
  assertCurrent();
  if (result.termination !== "exit" || result.code !== 0) {
    log.warn(`Temporary Git pack cleanup deferred in ${directory}: ${result.termination}`);
    return;
  }
  // SAFETY: The private native helper returns only its completed cleanup counts.
  const counts = JSON.parse(result.stdout.toString("utf8")) as {
    removed: number;
    retained: number;
  };
  if (counts.retained > 0) {
    log.warn(
      `Retained ${counts.retained} temporary Git packs in ${directory}: active, changed, or unavailable file lease.`,
    );
  }
  if (counts.removed > 0) {
    log.info(`Removed ${counts.removed} stale temporary Git packs from ${directory}.`);
  }
}

async function consolidatePacks(
  repoRoot: string,
  directory: string,
  names: string[],
  options: NonNullable<Parameters<typeof requireGit>[2]>,
) {
  // MIDX is optional lookup metadata. Invalidate both entry points, including
  // stale indexes, without enumerating every object to rebuild the whole repo.
  for (const name of ["multi-pack-index", "multi-pack-index.d/multi-pack-index-chain"]) {
    options.beforeRun?.();
    await fs.rm(path.join(directory, name), { force: true });
  }
  const present = new Set(names);
  const packs = [];
  for (const name of names) {
    if (!/^pack-[a-f0-9]+\.pack$/.test(name)) {
      continue;
    }
    const stem = name.slice(0, -5);
    if (
      !present.has(`${stem}.idx`) ||
      present.has(`${stem}.keep`) ||
      present.has(`${stem}.mtimes`)
    ) {
      continue;
    }
    options.beforeRun?.();
    const stat = await fs.stat(path.join(directory, name));
    const index = await fs.stat(path.join(directory, `${stem}.idx`));
    packs.push({
      name,
      size: stat.size,
      indexBytes: index.size,
      promisor: present.has(`${stem}.promisor`),
    });
  }
  packs.sort((a, b) => a.size - b.size || a.name.localeCompare(b.name));
  let objectFormat: string | undefined;
  for (const promisor of [true, false]) {
    const candidates = packs.filter((pack) => pack.promisor === promisor);
    const batch = [];
    let bytes = 0;
    let indexBytes = 0;
    for (const pack of candidates) {
      if (pack.indexBytes > PACK_BATCH_INDEX_BYTES) {
        continue;
      }
      if (
        bytes + pack.size > PACK_BATCH_BYTES ||
        indexBytes + pack.indexBytes > PACK_BATCH_INDEX_BYTES ||
        batch.length >= PACK_BATCH_COUNT
      ) {
        break;
      }
      batch.push(pack);
      bytes += pack.size;
      indexBytes += pack.indexBytes;
    }
    // Leave a dominant pack alone until the smaller inputs together reach its
    // size; bounded batches can still make progress below a fixed pack count.
    while (batch.length > 1 && bytes < 2 * batch.at(-1)!.size) {
      bytes -= batch.pop()!.size;
    }
    if (batch.length < 2) {
      continue;
    }
    const selected = batch.map((pack) => pack.name);
    // Validate only the packs this pass may retire, without walking refs or
    // missing partial-clone objects. The streaming writer does not check source CRCs.
    objectFormat ??= await requireGit(repoRoot, ["rev-parse", "--show-object-format"], options);
    const verifyDeadline = performance.now() + PACK_BATCH_TIMEOUT_MS;
    for (let offset = 0; offset < selected.length; offset += 128) {
      const timeoutMs = Math.ceil(verifyDeadline - performance.now());
      if (timeoutMs <= 0) {
        throw new Error("Git pack verification exceeded its thirty-minute budget");
      }
      // Relative names and bounded argv also fit Windows' command-line limit.
      await requireGit(
        directory,
        [
          "-c",
          "pack.threads=1",
          "verify-pack",
          `--object-format=${objectFormat}`,
          ...selected.slice(offset, offset + 128),
        ],
        {
          ...options,
          timeoutMs,
          // Standalone verification checks this pack/index, without rediscovering
          // the entire partial clone for every index-pack child. Git ignores a ceiling at cwd.
          env: { ...options.env, GIT_CEILING_DIRECTORIES: path.dirname(directory) },
        },
      );
    }
    // index-pack publishes the promisor marker and verified index before returning
    // the hash. Plain --stdin-packs copies every object, including unreachable ones.
    const alias =
      "!if command -v ionice >/dev/null 2>&1; then ionice -c 3 -p $$ >/dev/null 2>&1; fi; git pack-objects --stdin-packs --stdout --window=0 --threads=1 | git index-pack --stdin --threads=1" +
      (promisor ? " --promisor" : "");
    const result = await requireGit(
      repoRoot,
      ["-c", `alias.openclaw-consolidate=${alias}`, "openclaw-consolidate"],
      {
        ...options,
        timeoutMs: PACK_BATCH_TIMEOUT_MS,
        input: `${selected.join("\n")}\n`,
      },
    );
    const hash = /^pack\s+([a-f0-9]{40}|[a-f0-9]{64})$/.exec(result)?.[1];
    if (!hash) {
      throw new Error("Git pack consolidation returned an invalid pack identity");
    }
    for (const name of selected) {
      const stem = path.join(directory, name.slice(0, -5));
      // The union can already be one of the inputs. Never retire the output or
      // a pack another Git writer has since pinned or marked as cruft.
      if (
        name === `pack-${hash}.pack` ||
        (await lstatIfExists(`${stem}.keep`)) ||
        (await lstatIfExists(`${stem}.mtimes`))
      ) {
        continue;
      }
      for (const extension of ["idx", "pack", "rev", "bitmap", "promisor"]) {
        options.beforeRun?.();
        await fs.rm(`${stem}.${extension}`, { force: true });
      }
    }
  }
  const remainingNames = await fs.readdir(directory);
  return remainingNames.filter((name) => name.endsWith(".pack")).length;
}

export function createWorktreeGitMaintenance(env: NodeJS.ProcessEnv) {
  // Suspend failed tasks without letting graph failures stop bounded pack convergence.
  const failed = new Map<string, "objects" | "packs" | "maintenance">();
  const nextRunAt = new Map<string, number>();
  return async (params: MaintenanceParams): Promise<void> => {
    const progress = params.progress ?? new WorktreeGcProgress();
    const assertCurrent = () => {
      params.signal?.throwIfAborted();
      params.commitGuard?.();
    };
    assertCurrent();
    if (params.retryDeferred) {
      failed.clear();
    }
    const records = await readRegistryWorktrees(env).catch((error: unknown) => {
      assertCurrent();
      progress.error("git-maintenance", error);
      log.warn(`worktree Git maintenance inventory failed: ${String(error)}`);
      return [];
    });
    for (const repoRoot of new Set(records.map((record) => record.repoRoot))) {
      assertCurrent();
      const report = async (
        stage: NonNullable<ManagedWorktreeGcResult["gitMaintenance"]>["stage"],
        counts?: { packsBefore: number; packsAfter?: number },
      ) => {
        progress.result.gitMaintenance = {
          ...progress.result.gitMaintenance,
          ...counts,
          repoRoot,
          stage,
        };
        await params.checkpoint?.(progress.result);
        assertCurrent();
      };
      progress.result.gitMaintenance = { repoRoot, stage: "packs" };
      if (failed.get(repoRoot) === "packs") {
        progress.record(
          "git-maintenance",
          "deferred",
          "Pack maintenance suspended; run worktrees gc --retry-deferred after repair",
          repoRoot,
        );
        await report("suspended");
        continue;
      }
      if (!params.retryDeferred && Date.now() < (nextRunAt.get(repoRoot) ?? 0)) {
        await report("throttled");
        continue;
      }
      const state: { stage: "objects" | "packs" | "maintenance" } = { stage: "packs" };
      try {
        await withProjectCheckoutLifecycle(
          repoRoot,
          { env, signal: params.signal, waitMs: 0 },
          async (lease) => {
            const ownedParams = {
              ...params,
              signal: lease.signal,
              commitGuard: () => {
                assertCurrent();
                lease.assertCurrent();
              },
            };
            // A busy checkout leaves its hourly slot available for the next sweep.
            nextRunAt.set(repoRoot, Date.now() + 60 * 60_000);
            await report(state.stage);
            // Snapshot failures describe graph availability, not pack integrity.
            // Verify bounded pack inputs before expiry; never gate them on full fsck.
            await maintainWorktreePacks(repoRoot, ownedParams, async (before, after) => {
              if (after !== undefined) {
                progress.result.packsRemoved =
                  (progress.result.packsRemoved ?? 0) + Math.max(0, before - after);
              }
              await report(state.stage, { packsBefore: before, packsAfter: after });
            });
            const options = {
              operation,
              executionIntent: "agent-tool" as const,
              signal: lease.signal,
              beforeRun: ownedParams.commitGuard,
              timeoutMs: WORKTREE_GIT_MAINTENANCE_TIMEOUT_MS,
              killProcessTree: true,
              lowerPriority: true,
              env: { GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" },
            };
            let remote: string | undefined;
            if (params.retryDeferred) {
              state.stage = "objects";
              await report(state.stage);
              const config = await runGit(
                repoRoot,
                ["config", "--bool", "--get-regexp", "^remote\\..*\\.promisor$"],
                options,
              );
              if (!(config.termination === "exit" && config.code === 1)) {
                remote = /^remote\.(.+)\.promisor true$/m.exec(
                  requireGitCommandOutput("git config promisor", config),
                )?.[1];
              }
            }
            // Only an explicit repair pass may fetch. Pack progress is already published.
            if (params.retryDeferred && remote) {
              await withContentGitSlot(
                () => repairWorktreeObjects(repoRoot, remote, env, ownedParams),
                params.signal,
              );
            }
            state.stage = "maintenance";
            if (failed.has(repoRoot)) {
              progress.record(
                "git-maintenance",
                "deferred",
                "Object or graph maintenance suspended; run worktrees gc --retry-deferred after repair",
                repoRoot,
              );
              await report("suspended");
              return;
            }
            await report(state.stage);
            await withContentGitSlot(
              () =>
                requireGit(
                  repoRoot,
                  ["maintenance", "run", "--auto", "--task=commit-graph", "--task=loose-objects"],
                  options,
                ),
              params.signal,
            );
            await report("completed");
          },
        );
      } catch (error) {
        assertCurrent();
        if (error instanceof ProjectCheckoutBusyError) {
          progress.record(
            "git-maintenance",
            "deferred",
            "Project checkout is busy; retry on the next cleanup pass",
            repoRoot,
          );
          await report("throttled");
          continue;
        }
        failed.set(repoRoot, state.stage);
        progress.error("git-maintenance", error, repoRoot);
        await report("suspended");
        const recovery =
          state.stage === "objects"
            ? "Check the promisor remote, then run openclaw worktrees gc --retry-deferred to resume object repair."
            : "Repair the repository, then run openclaw worktrees gc --retry-deferred or restart the Gateway to retry.";
        log.warn(
          `worktree Git maintenance suspended (${state.stage}) for ${repoRoot}: ${String(error)}\n${recovery}`,
        );
      }
    }
    await params.checkpoint?.(progress.result);
  };
}
