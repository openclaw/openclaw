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
import { listGitWorktrees, requireGit, resolveGitMetadataPath, runGit } from "./git.js";
import { readRegistryWorktrees } from "./registry-read.js";

const log = createSubsystemLogger("agents/worktrees");
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
  shouldDeferRepository?: (repoRoot: string) => string | undefined;
};

async function repairWorktreeObjects(
  repoRoot: string,
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
  const config = await runGit(
    repoRoot,
    ["config", "--bool", "--get-regexp", "^remote\\..*\\.promisor$"],
    options(),
  );
  if (config.termination === "exit" && config.code === 1) {
    return;
  }
  const remote = /^remote\.(.+)\.promisor true$/m.exec(
    requireGitCommandOutput("git config promisor", config),
  )?.[1];
  if (!remote) {
    return;
  }
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
): Promise<void> {
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    params.commitGuard?.();
  };
  const options = {
    signal: params.signal,
    beforeRun: assertCurrent,
    killProcessTree: true,
    lowerPriority: true,
    env: { GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" },
  };
  const commonDir = await requireGit(repoRoot, ["rev-parse", "--git-common-dir"], options);
  // Fetch must not replace the MIDX between batch publication and expiry.
  await enqueueGitRefMutation(
    repoRoot,
    commonDir,
    () =>
      withContentGitSlot(async () => {
        const packDirectory = await resolveGitMetadataPath(repoRoot, "objects/pack", options);
        // Git rejects an empty pack directory; inspect only this shallow metadata directory.
        const packs = await fs.readdir(packDirectory).catch((error: unknown) => {
          if (isMissingPathError(error)) {
            return [];
          }
          throw error;
        });
        assertCurrent();
        const indexes = packs.filter((name) => /^pack-[a-f0-9]+\.idx$/.test(name));
        if (indexes.length > 0) {
          // Reusing a stale MIDX fails before discovery when it names a removed pack.
          await requireGit(repoRoot, ["multi-pack-index", "write", "--stdin-packs"], {
            ...options,
            input: `${indexes.join("\n")}\n`,
          });
        }
        await cleanTemporaryPacks(packDirectory, packs, params.signal, assertCurrent);
        await consolidatePacks(repoRoot, packDirectory, packs, options);
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
  const result = await runCommandBuffersWithTimeout(
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
  if (names.filter((name) => /^pack-[a-f0-9]+\.pack$/.test(name)).length < 16) {
    return;
  }
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
  let consolidated = false;
  for (const promisor of [true, false]) {
    const candidates = packs.filter((pack) => pack.promisor === promisor);
    if (candidates.length < 16) {
      continue;
    }
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
    const replacement = `pack-${hash}.pack`;
    // Expire only this homogeneous batch: a full MIDX could retire an unrelated promisor pack.
    await requireGit(
      repoRoot,
      ["multi-pack-index", "write", "--stdin-packs", `--preferred-pack=${replacement}`],
      {
        ...options,
        input: `${[...new Set([...selected, replacement])].map((name) => name.replace(/\.pack$/, ".idx")).join("\n")}\n`,
      },
    );
    await requireGit(repoRoot, ["multi-pack-index", "expire"], options);
    consolidated = true;
  }
  if (!consolidated) {
    return;
  }
  const remaining = (await fs.readdir(directory)).filter((name) =>
    /^pack-[a-f0-9]+\.idx$/.test(name),
  );
  if (remaining.length > 0) {
    await requireGit(repoRoot, ["multi-pack-index", "write", "--stdin-packs"], {
      ...options,
      input: `${remaining.join("\n")}\n`,
    });
  }
}

export function createWorktreeGitMaintenance(env: NodeJS.ProcessEnv) {
  // Suspend failed tasks without letting graph failures stop bounded pack convergence.
  const failed = new Map<string, "objects" | "packs" | "maintenance">();
  return async (params: MaintenanceParams): Promise<void> => {
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
      log.warn(`worktree Git maintenance inventory failed: ${String(error)}`);
      return [];
    });
    for (const repoRoot of new Set(records.map((record) => record.repoRoot))) {
      assertCurrent();
      if (failed.get(repoRoot) === "packs" || params.shouldDeferRepository?.(repoRoot)) {
        continue;
      }
      let stage: "objects" | "packs" | "maintenance" = "packs";
      try {
        // Repair lookup before traversing objects: interrupted writers can leave
        // the MIDX referring to pack files that no longer exist.
        await maintainWorktreePacks(repoRoot, params);
        stage = "objects";
        // Only an explicit repair pass may fetch. Successful batches remain in
        // Git if interrupted; the next retry inventories only what is missing.
        if (params.retryDeferred) {
          await withContentGitSlot(() => repairWorktreeObjects(repoRoot, params), params.signal);
        }
        stage = "maintenance";
        if (failed.has(repoRoot)) {
          continue;
        }
        await withContentGitSlot(
          () =>
            requireGit(
              repoRoot,
              ["maintenance", "run", "--auto", "--task=commit-graph", "--task=loose-objects"],
              {
                killProcessTree: true,
                lowerPriority: true,
                signal: params.signal,
                beforeRun: assertCurrent,
                timeoutMs: WORKTREE_GIT_MAINTENANCE_TIMEOUT_MS,
                // Missing promisor objects belong to explicit fetches, not hourly housekeeping.
                env: { GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" },
              },
            ),
          params.signal,
        );
      } catch (error) {
        assertCurrent();
        failed.set(repoRoot, stage);
        const recovery =
          stage === "objects"
            ? "Check the promisor remote, then run openclaw worktrees gc --retry-deferred to resume object repair."
            : "Repair the repository, then run openclaw worktrees gc --retry-deferred or restart the Gateway to retry.";
        log.warn(
          `worktree Git maintenance suspended (${stage}) for ${repoRoot}: ${String(error)}\n${recovery}`,
        );
      }
    }
  };
}
