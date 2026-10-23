import fs from "node:fs/promises";
import path from "node:path";
import { isMissingPathError } from "../../infra/errors.js";
import { withContentGitSlot } from "../../infra/git-content-budget.js";
import { enqueueGitRefMutation, requireGitCommandOutput } from "../../infra/git-exec.js";
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
import { WorktreeGcProgress } from "./gc-progress.js";
import { listGitWorktrees, requireGit, resolveGitMetadataPath, runGit } from "./git.js";
import { readRegistryWorktrees } from "./registry-read.js";
import type { ManagedWorktreeGcResult } from "./types.js";

const log = createSubsystemLogger("agents/worktrees");
const operation: GitProcessOperation = "worktree.maintenance";
const WORKTREE_GIT_MAINTENANCE_TIMEOUT_MS = 30 * 60 * 1000;
const PACK_BATCH_BYTES = 512 * 1024 * 1024;
const PACK_BATCH_COUNT = 1024;
const PACK_BATCH_TIMEOUT_MS = 5 * 60 * 1000;
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
  params: Pick<MaintenanceParams, "signal" | "commitGuard">,
): Promise<void> {
  const started = performance.now();
  const options = () => {
    params.signal?.throwIfAborted();
    params.commitGuard?.();
    const remaining = OBJECT_REPAIR_TIMEOUT_MS - (performance.now() - started);
    if (remaining <= 0) {
      throw new Error("Worktree object repair exceeded its five-minute budget");
    }
    return {
      operation,
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
  const heads = [
    ...new Set(
      (await listGitWorktrees(repoRoot, options())).flatMap((worktree) =>
        worktree.head && !/^0+$/.test(worktree.head) ? [worktree.head] : [],
      ),
    ),
  ];
  const fetched = new Set<string>();
  for (;;) {
    // Git includes every linked index (including resolve-undo), while no-walk
    // visits only the live HEAD trees, not intentionally unhydrated history.
    const inventory = await requireGit(
      repoRoot,
      [
        "rev-list",
        "--objects",
        "--indexed-objects",
        "--no-walk=unsorted",
        "--missing=print",
        "--no-object-names",
        "--stdin",
      ],
      { ...options(), input: `${heads.join("\n")}\n` },
    );
    const missing = inventory
      .split("\n")
      .filter((line) => line.startsWith("?"))
      .map((line) => line.slice(1));
    if (missing.length === 0) {
      if (fetched.size > 0) {
        log.info(`Repaired ${fetched.size} missing live worktree objects in ${repoRoot}.`);
      }
      return;
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
  // Fetch must not replace the MIDX between batch publication and expiry.
  await enqueueGitRefMutation(
    repoRoot,
    commonDir,
    () =>
      withContentGitSlot(async () => {
        const packs = await readPacks();
        assertCurrent();
        const before = packs.filter((name) => name.endsWith(".pack")).length;
        await report(before);
        await cleanTemporaryPacks(packDirectory, packs, params.signal, assertCurrent);
        const after = await consolidatePacks(repoRoot, packDirectory, packs, options);
        await report(before, after);
      }, params.signal),
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
    packs.push({ name, size: stat.size, promisor: present.has(`${stem}.promisor`) });
  }
  packs.sort((a, b) => a.size - b.size || a.name.localeCompare(b.name));
  let objectFormat: string | undefined;
  for (const promisor of [true, false]) {
    const candidates = packs.filter((pack) => pack.promisor === promisor);
    const selected = [];
    let bytes = 0;
    for (const pack of candidates) {
      if (bytes + pack.size > PACK_BATCH_BYTES || selected.length >= PACK_BATCH_COUNT) {
        break;
      }
      selected.push(pack.name);
      bytes += pack.size;
    }
    if (selected.length < 2) {
      continue;
    }
    // Validate only the packs this pass may retire, without walking refs or
    // missing partial-clone objects. The streaming writer does not check source CRCs.
    objectFormat ??= await requireGit(repoRoot, ["rev-parse", "--show-object-format"], options);
    const verifyDeadline = performance.now() + PACK_BATCH_TIMEOUT_MS;
    for (let offset = 0; offset < selected.length; offset += 128) {
      const timeoutMs = Math.ceil(verifyDeadline - performance.now());
      if (timeoutMs <= 0) {
        throw new Error("Git pack verification exceeded its five-minute budget");
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
    let preferred = selected.at(-1)!;
    // The rewrite threshold applies to the inventory, not the byte-limited batch.
    if (candidates.length >= 16) {
      // A static Git alias streams between native children without buffering packs in the Gateway.
      // index-pack publishes the promisor marker before the index; geometric repack cannot do this on older Git.
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
      preferred = `pack-${hash}.pack`;
    }
    // Expire only this homogeneous batch: a full MIDX could retire an unrelated promisor pack.
    // Expiry rebuilds the full index after deleting packs, so do it only once per group.
    await requireGit(
      repoRoot,
      ["multi-pack-index", "write", "--stdin-packs", `--preferred-pack=${preferred}`],
      {
        ...options,
        input: `${[...new Set([...selected, preferred])].map((name) => name.replace(/\.pack$/, ".idx")).join("\n")}\n`,
      },
    );
    await requireGit(repoRoot, ["multi-pack-index", "expire"], options);
  }
  const remainingNames = await fs.readdir(directory);
  const remaining = remainingNames.filter((name) => /^pack-[a-f0-9]+\.idx$/.test(name));
  if (remaining.length > 0) {
    await requireGit(repoRoot, ["multi-pack-index", "write", "--stdin-packs"], {
      ...options,
      input: `${remaining.join("\n")}\n`,
    });
  }
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
      // Archive notifications also run cleanup; repository housekeeping stays hourly.
      nextRunAt.set(repoRoot, Date.now() + 60 * 60_000);
      let stage: "objects" | "packs" | "maintenance" = "packs";
      try {
        await report(stage);
        // Snapshot failures describe graph availability, not pack integrity.
        // Verify bounded pack inputs before expiry; never gate them on full fsck.
        await maintainWorktreePacks(repoRoot, params, async (before, after) => {
          if (after !== undefined) {
            progress.result.packsRemoved =
              (progress.result.packsRemoved ?? 0) + Math.max(0, before - after);
          }
          await report(stage, { packsBefore: before, packsAfter: after });
        });
        const options = {
          operation,
          signal: params.signal,
          beforeRun: assertCurrent,
          timeoutMs: WORKTREE_GIT_MAINTENANCE_TIMEOUT_MS,
          killProcessTree: true,
          lowerPriority: true,
          env: { GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" },
        };
        let remote: string | undefined;
        if (params.retryDeferred) {
          stage = "objects";
          await report(stage);
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
            () => repairWorktreeObjects(repoRoot, remote, params),
            params.signal,
          );
        }
        stage = "maintenance";
        if (failed.has(repoRoot)) {
          progress.record(
            "git-maintenance",
            "deferred",
            "Object or graph maintenance suspended; run worktrees gc --retry-deferred after repair",
            repoRoot,
          );
          await report("suspended");
          continue;
        }
        await report(stage);
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
      } catch (error) {
        assertCurrent();
        failed.set(repoRoot, stage);
        progress.error("git-maintenance", error, repoRoot);
        await report("suspended");
        const recovery =
          stage === "objects"
            ? "Check the promisor remote, then run openclaw worktrees gc --retry-deferred to resume object repair."
            : "Repair the repository, then run openclaw worktrees gc --retry-deferred or restart the Gateway to retry.";
        log.warn(
          `worktree Git maintenance suspended (${stage}) for ${repoRoot}: ${String(error)}\n${recovery}`,
        );
      }
    }
    await params.checkpoint?.(progress.result);
  };
}
