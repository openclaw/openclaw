import path from "node:path";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runCommandBuffersWithTimeout } from "../../process/exec-runner.js";
import { withChildProcessOperation } from "../../process/spawn-diagnostics.js";

const log = createSubsystemLogger("agents/worktrees");
const TEMP_PACK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export async function cleanTemporaryPacks(
  directory: string,
  names: string[],
  signal: AbortSignal | undefined,
  assertCurrent: () => void,
) {
  const files = names
    // index-pack also leaves tmp_idx_/tmp_rev_ files when interrupted; Git prune owns
    // every tmp_ prefix, but gc.auto is disabled for managed clones.
    .filter((name) => /^tmp_[a-z]+_[a-zA-Z0-9_-]+$/.test(name))
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
