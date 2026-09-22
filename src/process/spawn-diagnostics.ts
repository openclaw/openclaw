import type { ChildProcess } from "node:child_process";
import path from "node:path";
import {
  areDiagnosticsEnabledForProcess,
  emitInternalDiagnosticEvent,
} from "../infra/diagnostic-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const spawnCounts = resolveGlobalSingleton(Symbol.for("openclaw.childProcessSpawnCounts"), () => ({
  counts: new Map<string, number>(),
  sampledAt: performance.now(),
}));
let spawnLog: ReturnType<typeof createSubsystemLogger> | undefined;
const COMMAND_FAMILIES =
  /^(node|git|ps|pgrep|lsof|sh|bash|zsh|cmd|powershell|pwsh|npm|pnpm|python|python3|uv|ssh|openclaw)$/;

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
  child.once("spawn", () => {
    if (areDiagnosticsEnabledForProcess()) {
      spawnCounts.counts.set(family, (spawnCounts.counts.get(family) ?? 0) + 1);
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
  for (const [family, count] of spawnCounts.counts) {
    emitInternalDiagnosticEvent({
      type: "diagnostic.child_process.spawn",
      family,
      count,
      intervalMs,
    });
    (spawnLog ??= createSubsystemLogger("gateway/diagnostics/process")).debug(
      `child process spawns: family=${family} count=${count} ratePerMinute=${((count * 60_000) / intervalMs).toFixed(2)}`,
    );
  }
  spawnCounts.counts.clear();
  spawnCounts.sampledAt = now;
}
