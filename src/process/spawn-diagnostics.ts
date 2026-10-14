import { AsyncLocalStorage } from "node:async_hooks";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import {
  areDiagnosticsEnabledForProcess,
  emitInternalDiagnosticEvent,
} from "../infra/diagnostic-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const spawnCounts = resolveGlobalSingleton(Symbol.for("openclaw.childProcessSpawnCounts"), () => ({
  counts: new Map<string, { family: string; operation: string; count: number }>(),
  sampledAt: performance.now(),
}));
let spawnLog: ReturnType<typeof createSubsystemLogger> | undefined;
const COMMAND_FAMILIES =
  /^(node|bun|git|ps|pgrep|lsof|sh|bash|zsh|cmd|powershell|pwsh|npm|pnpm|python|python3|uv|ssh|openclaw)$/;
const GIT_OPERATIONS = [
  "repository.identities",
  "repository.branches",
  "checkout.revision",
  "checkout.context",
  "checkout.diff",
  "checkout.baseline",
  "pull-request.branch-facts",
  "worktree.snapshot",
  "worktree.cleanup",
  "worktree.provision",
  "worktree.inspect",
  "worktree.recovery",
  "workspace.inventory",
  "workspace.manifest",
  "workspace.result-cleanup",
  "project.clone",
  "session.materialize",
  "publication",
  "github.identity",
  "project.checkout",
  "update.inspect",
  "worktree.config",
  "worktree.maintenance",
  "workspace.sync",
  "workspace.result",
] as const;
export type GitProcessOperation = (typeof GIT_OPERATIONS)[number];
const gitOperations: ReadonlySet<string> = new Set(GIT_OPERATIONS);
const gitOperation = resolveGlobalSingleton(
  Symbol.for("openclaw.gitSpawnOperation"),
  () => new AsyncLocalStorage<GitProcessOperation | "unknown">(),
);

// Unscoped callers remain visible without exporting aliases, arguments, or repository paths.
function unscopedGitOperation(args: readonly string[]): string {
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(arg)) {
      i += 2;
    } else if (/^--(?:git-dir|work-tree|namespace|config-env|attr-source)=/u.test(arg)) {
      i++;
    } else if (
      [
        "--no-pager",
        "--no-optional-locks",
        "--no-lazy-fetch",
        "--literal-pathspecs",
        "--bare",
      ].includes(arg)
    ) {
      i++;
    } else {
      break;
    }
  }
  const command = args[i] ?? "";
  return /^(config|rev-parse|status|diff|ls-files|rev-list|merge-base|cat-file|symbolic-ref|for-each-ref|show-ref|remote|log|show|hash-object|update-ref|worktree|branch|fetch|clone|init|checkout|read-tree|write-tree|commit-tree|pack-objects|index-pack|maintenance|multi-pack-index|gc|fast-import|add|commit|push|reset|clean|merge|tag|describe|switch|ls-tree|update-index|check-ref-format|diff-tree|diff-index|diff-files|sparse-checkout|checkout-index|check-attr|mktree|var|apply|fsck|ls-remote|rebase|reflog)$/u.test(
    command,
  )
    ? `unscoped.${command}`
    : command === "--version" || command === "version"
      ? "unscoped.version"
      : "unscoped.other";
}

/** Preserve the admitted owner across retries, ref admission, and asynchronous spawn events. */
export function withGitProcessOperation<T>(
  operation: GitProcessOperation | undefined,
  run: () => T,
  mode: "override" | "default" = "override",
): T {
  return operation === undefined || (mode === "default" && gitOperation.getStore() !== undefined)
    ? run()
    : gitOperation.run(gitOperations.has(operation) ? operation : "unknown", run);
}

/** Count admitted local and broker launches, without recording paths or arguments. */
export function recordChildProcessSpawn(
  command: string,
  child: ChildProcess,
  sqliteOperation?: `sqlite.${"scoped-read" | "session"}.${"broker" | "native"}`,
  args: readonly string[] = [],
): void {
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  const name = path.win32
    .basename(command)
    .toLowerCase()
    .replace(/\.(exe|cmd)$/, "");
  const family = COMMAND_FAMILIES.test(name) ? name : "other";
  const operation =
    family === "git"
      ? (gitOperation.getStore() ?? unscopedGitOperation(args))
      : (sqliteOperation ?? "none");
  const key = `${family}:${operation}`;
  child.once("spawn", () => {
    if (areDiagnosticsEnabledForProcess()) {
      const previous = spawnCounts.counts.get(key);
      spawnCounts.counts.set(key, { family, operation, count: (previous?.count ?? 0) + 1 });
    }
  });
}

/** The existing diagnostics heartbeat owns sampling; rates use actual elapsed time. */
export function emitChildProcessSpawnSample(): void {
  const now = performance.now();
  if (!areDiagnosticsEnabledForProcess()) {
    spawnCounts.counts.clear();
    spawnCounts.sampledAt = now;
    return;
  }
  const intervalMs = now - spawnCounts.sampledAt;
  if (intervalMs < 60_000) {
    return;
  }
  for (const { family, operation, count } of spawnCounts.counts.values()) {
    emitInternalDiagnosticEvent({
      type: "diagnostic.child_process.spawn",
      family,
      operation,
      count,
      intervalMs,
    });
    (spawnLog ??= createSubsystemLogger("gateway/diagnostics/process")).debug(
      `child process spawns: family=${family} operation=${operation} count=${count} ratePerMinute=${((count * 60_000) / intervalMs).toFixed(2)}`,
    );
  }
  spawnCounts.counts.clear();
  spawnCounts.sampledAt = now;
}
