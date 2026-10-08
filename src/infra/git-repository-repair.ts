import path from "node:path";
import { performance } from "node:perf_hooks";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../process/exec-result.js";
import type { SpawnResult } from "../process/exec.js";
import { normalizeGitPathForFilesystem, type GitCommandOptions } from "./git-exec.js";
import { clearStaleGitRemoteRefLocks } from "./git-ref-lock-repair.js";

const log = createSubsystemLogger("git/repair");
const REPAIR_TIMEOUT_MS = 300_000;
const MAX_REFS = 50_000;
const MAX_MISSING_TIPS = 4_096;
const OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
type RepairResult = Pick<
  SpawnResult,
  | "code"
  | "termination"
  | "stdout"
  | "stderr"
  | "stdoutTruncatedBytes"
  | "outputLimitExceeded"
  | "cleanup"
>;
type RepairCommand = (args: string[], options: GitCommandOptions) => Promise<RepairResult>;
type FetchResult = {
  code: number | null;
  termination: string;
  stderr: string | Uint8Array;
  cleanup?: string;
  outputLimitExceeded?: boolean;
};

/** The caller keeps its checkout/ref mutation admission through repair and retry. */
export async function withGitRepositoryRepair<T extends FetchResult>(params: {
  cwd: string;
  result: T;
  run: RepairCommand;
  retry: () => Promise<T>;
  remote: string;
  /** Project refresh owns this mapping independently of checkout-local config. */
  canonicalTracking?: boolean;
  pruneTracking?: boolean;
  /** Carry source-ref preservation through a caller's later publication. */
  onRepaired?: (protectedRefs: ReadonlySet<string>) => void;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}): Promise<T> {
  const { result } = params;
  if (
    result.termination !== "exit" ||
    result.code !== 128 ||
    result.cleanup === "uncertain" ||
    result.outputLimitExceeded
  ) {
    return result;
  }
  const stderr =
    typeof result.stderr === "string" ? result.stderr : Buffer.from(result.stderr).toString("utf8");
  if (
    !/which is in the commit graph file but not in the object database|trying to write ref '[^']+' with nonexistent object/iu.test(
      stderr,
    )
  ) {
    return result;
  }
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    params.assertCurrent?.();
  };
  log.warn(`Git repository has missing ref tips; attempting repair for ${params.cwd}`);
  try {
    const started = performance.now();
    const remainingBudget = () => {
      assertCurrent();
      const remaining = REPAIR_TIMEOUT_MS - (performance.now() - started);
      if (remaining <= 0) {
        throw new Error("repair exceeded its five-minute budget");
      }
      return Math.ceil(remaining);
    };
    const run = async (args: string[], input?: string) => {
      const outcome = await params.run(
        [
          "-c",
          "core.commitGraph=false",
          "-c",
          "maintenance.auto=false",
          "-c",
          "fetch.writeCommitGraph=false",
          ...args,
        ],
        {
          input,
          signal: params.signal,
          beforeRun: assertCurrent,
          timeoutMs: remainingBudget(),
          maxOutputBytes: 8 * 1024 * 1024,
          env: { GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" },
          killProcessTree: true,
        },
      );
      if (outcome.cleanup === "uncertain") {
        throw new CommandProcessCleanupError();
      }
      assertCurrent();
      if (
        outcome.termination !== "exit" ||
        outcome.code !== 0 ||
        outcome.stdoutTruncatedBytes ||
        outcome.outputLimitExceeded
      ) {
        // Remote diagnostics can contain credentials; keep the warning local and actionable.
        throw new Error(`repair ${args[0]} failed (${outcome.termination}, exit ${outcome.code})`);
      }
      return outcome.stdout;
    };
    const rows = (await run(["for-each-ref", "--format=%(refname) %(objectname) %(symref)"]))
      .trim()
      .split("\n")
      .filter(Boolean);
    if (rows.length > MAX_REFS) {
      throw new Error(`repair inventory exceeds ${MAX_REFS} refs`);
    }
    const refs = new Map<string, string>();
    const symbolicRefs = new Map<string, string>();
    for (const row of rows) {
      const [ref, oid, symbolic] = row.trim().split(" ");
      if (!ref?.startsWith("refs/") || !oid || !OID.test(oid)) {
        throw new Error("repair received an invalid ref inventory");
      }
      if (symbolic) {
        symbolicRefs.set(ref, symbolic);
      } else {
        refs.set(ref, oid);
      }
    }
    const worktrees = (await run(["worktree", "list", "--porcelain", "-z"])).split("\0");
    const protectedRefs = new Set<string>();
    const protect = (ref: string) => {
      let current = ref;
      while (!protectedRefs.has(current)) {
        protectedRefs.add(current);
        const target = symbolicRefs.get(current);
        if (!target) {
          break;
        }
        current = target;
      }
    };
    for (const ref of symbolicRefs.keys()) {
      if (!ref.startsWith("refs/remotes/origin/")) {
        protect(ref);
      }
    }
    for (const field of worktrees) {
      if (field.startsWith("branch ")) {
        protect(field.slice(7));
      }
    }
    const remoteRefs = new Set<string>();
    for (const row of (await run(["ls-remote", "--heads", "--", params.remote]))
      .trim()
      .split("\n")
      .filter(Boolean)) {
      const [oid, ref] = row.split("\t");
      if (!oid || !OID.test(oid) || !ref?.startsWith("refs/heads/")) {
        throw new Error("repair received an invalid remote inventory");
      }
      remoteRefs.add(`refs/remotes/origin/${ref.slice("refs/heads/".length)}`);
    }
    if (remoteRefs.size > MAX_REFS) {
      throw new Error(`repair inventory exceeds ${MAX_REFS} remote refs`);
    }
    const tracking = [...refs.keys()].filter((ref) => ref.startsWith("refs/remotes/origin/"));
    const canonicalTracking =
      params.canonicalTracking ||
      (await run(["config", "--get-all", "remote.origin.fetch"])).trim() ===
        "+refs/heads/*:refs/remotes/origin/*";
    const commonDirectory = path.resolve(
      params.cwd,
      normalizeGitPathForFilesystem((await run(["rev-parse", "--git-common-dir"])).trim()),
    );
    const cleared = await clearStaleGitRemoteRefLocks({
      commonDirectory,
      refs: [...new Set([...tracking, ...remoteRefs])],
      assertCurrent: () => {
        remainingBudget();
      },
      signal: params.signal,
    });
    // A remapped tracking name need not equal its upstream branch name.
    const obsolete =
      canonicalTracking && params.pruneTracking !== false
        ? tracking.filter((ref) => !remoteRefs.has(ref) && !protectedRefs.has(ref))
        : [];
    if (obsolete.length) {
      await run(
        ["update-ref", "--no-deref", "--stdin"],
        `${obsolete.map((ref) => `delete ${ref} ${refs.get(ref)}`).join("\n")}\n`,
      );
      for (const ref of obsolete) {
        refs.delete(ref);
      }
    }
    const tips = new Set(refs.values());
    for (const field of worktrees) {
      if (field.startsWith("HEAD ") && OID.test(field.slice(5)) && !/^0+$/u.test(field.slice(5))) {
        tips.add(field.slice(5));
      }
    }
    const objects = tips.size
      ? await run(
          ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
          `${[...tips].join("\n")}\n`,
        )
      : "";
    const missing = objects
      .trim()
      .split("\n")
      .filter((row) => row.endsWith(" missing"))
      .map((row) => row.split(" ")[0]!);
    if (missing.length > MAX_MISSING_TIPS) {
      throw new Error(`repair exceeds ${MAX_MISSING_TIPS} missing ref tips`);
    }
    if (missing.length) {
      const partial =
        (
          await run(["config", "--type=bool", "--default=false", "--get", "remote.origin.promisor"])
        ).trim() === "true";
      // No ref updates or FETCH_HEAD: avoid connectivity walking the very refs being repaired.
      await run(
        [
          "-c",
          "fetch.negotiationAlgorithm=noop",
          "fetch",
          "--no-auto-maintenance",
          "--no-tags",
          "--no-prune",
          "--no-prune-tags",
          "--no-write-fetch-head",
          "--no-recurse-submodules",
          ...(partial ? ["--filter=blob:none"] : []),
          "--stdin",
          "--",
          params.remote,
        ],
        `${missing.join("\n")}\n`,
      );
    }
    assertCurrent();
    const retried = await params.retry();
    if (retried.cleanup === "uncertain") {
      throw new CommandProcessCleanupError();
    }
    assertCurrent();
    if (retried.termination !== "exit" || retried.code !== 0) {
      throw new Error("fetch still fails after ref-tip repair");
    }
    params.onRepaired?.(protectedRefs);
    log.warn(
      `Git repository repaired for ${params.cwd}: fetched ${missing.length} missing tips, pruned ${obsolete.length} obsolete tracking refs, cleared ${cleared} stale ref locks`,
    );
    return retried;
  } catch (error) {
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    assertCurrent();
    log.warn(
      `Git repository repair failed for ${params.cwd}: ${error instanceof Error ? error.message : "repair unavailable"}. Local branches and worktree HEADs were preserved; repair the clone's missing objects or ref locks, then retry.`,
    );
    return result;
  }
}
