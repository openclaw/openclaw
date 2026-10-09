import fs from "node:fs/promises";
import path from "node:path";
import { isMissingPathError } from "../../infra/errors.js";
import { withContentGitSlot } from "../../infra/git-content-budget.js";
import { enqueueGitRefMutation } from "../../infra/git-exec.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runCommandBuffersWithTimeout } from "../../process/exec-runner.js";
import { requireGit, resolveGitMetadataPath } from "./git.js";
import { readRegistryWorktrees } from "./registry-read.js";

const log = createSubsystemLogger("agents/worktrees");
const WORKTREE_GIT_MAINTENANCE_TIMEOUT_MS = 30 * 60 * 1000;
const PACK_BATCH_BYTES = 512 * 1024 * 1024;
const PACK_BATCH_COUNT = 1024;
const PACK_BATCH_TIMEOUT_MS = 5 * 60 * 1000;
const TEMP_PACK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type MaintenanceParams = {
  signal?: AbortSignal;
  commitGuard?: () => void;
  retryDeferred?: boolean;
  shouldDeferRepository?: (repoRoot: string) => string | undefined;
};

/** Repair pack lookup even when the repository's broader maintenance is suspended. */
export async function repairWorktreePackIndex(
  repoRoot: string,
  params: Pick<MaintenanceParams, "signal" | "commitGuard"> & { consolidate?: boolean } = {},
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
  // Fetch and snapshot repair must not replace the MIDX between batch publication and expiry.
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
        if (params.consolidate) {
          await cleanTemporaryPacks(packDirectory, packs, params.signal, assertCurrent);
          await consolidatePacks(repoRoot, packDirectory, packs, options);
        }
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
  // A failed repository needs operator repair, not another hourly attempt.
  const failed = new Set<string>();
  return async (params: MaintenanceParams): Promise<void> => {
    const assertCurrent = () => {
      params.signal?.throwIfAborted();
      params.commitGuard?.();
    };
    assertCurrent();
    if (params.retryDeferred) {
      failed.clear();
    }
    const live = await readRegistryWorktrees(env, { liveOnly: true }).catch((error: unknown) => {
      assertCurrent();
      log.warn(`worktree Git maintenance inventory failed: ${String(error)}`);
      return [];
    });
    for (const repoRoot of new Set(live.map((record) => record.repoRoot))) {
      assertCurrent();
      if (failed.has(repoRoot) || params.shouldDeferRepository?.(repoRoot)) {
        continue;
      }
      try {
        await repairWorktreePackIndex(repoRoot, { ...params, consolidate: true });
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
        if (!failed.has(repoRoot)) {
          failed.add(repoRoot);
          log.warn(
            `worktree Git maintenance suspended for ${repoRoot}: ${String(error)}\nRepair the repository, then run openclaw worktrees gc --retry-deferred or restart the Gateway to retry.`,
          );
        }
      }
    }
  };
}
