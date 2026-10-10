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
] as const;
export type GitProcessOperation = (typeof GIT_OPERATIONS)[number];
const gitOperations: ReadonlySet<string> = new Set(GIT_OPERATIONS);
const gitOperation = resolveGlobalSingleton(
  Symbol.for("openclaw.gitSpawnOperation"),
  () => new AsyncLocalStorage<GitProcessOperation | "unknown">(),
);

/** Preserve the admitted owner across retries, ref admission, and asynchronous spawn events. */
export function withGitProcessOperation<T>(
  operation: GitProcessOperation | undefined,
  run: () => T,
): T {
  return operation === undefined
    ? run()
    : gitOperation.run(gitOperations.has(operation) ? operation : "unknown", run);
}

/** Count admitted local and broker launches, without recording paths or arguments. */
export function recordChildProcessSpawn(command: string, child: ChildProcess): void {
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  const name = path.win32
    .basename(command)
    .toLowerCase()
    .replace(/\.(exe|cmd)$/, "");
  const family = COMMAND_FAMILIES.test(name) ? name : "other";
  const operation = family === "git" ? (gitOperation.getStore() ?? "unknown") : "none";
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
