import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import {
  areDiagnosticsEnabledForProcess,
  emitInternalDiagnosticEvent,
} from "../infra/diagnostic-events.js";
import { toErrorObject } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getSpawnBroker } from "./spawn-broker/context.js";
import { brokerSpawnOptions } from "./spawn-broker/host.js";

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

/** Select the process-scoped native spawn transport without changing launch options. */
export function spawnProcess(command: string, args: string[], options: SpawnOptions): ChildProcess {
  const broker = getSpawnBroker();
  // Anonymous secret pipes and inherited numeric descriptors belong to this process.
  const child =
    broker && brokerSpawnOptions(options)
      ? broker.spawn(command, args, options)
      : spawn(command, args, options);
  recordChildProcessSpawn(command, child);
  return child;
}

type SpawnWithFallbackResult = {
  child: ChildProcess;
  usedFallback: boolean;
};

type SpawnWithFallbackParams = {
  assertCurrent?: () => void;
  argv: string[];
  options: SpawnOptions;
  fallbacks?: SpawnOptions[];
  spawnImpl?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
};

function shouldRetry(err: unknown): boolean {
  const code =
    err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "";
  return code === "EBADF";
}

async function spawnAndWaitForSpawn(
  spawnImpl: NonNullable<SpawnWithFallbackParams["spawnImpl"]>,
  argv: string[],
  options: SpawnOptions,
): Promise<ChildProcess> {
  const child = spawnImpl(expectDefined(argv[0], "argv entry at 0"), argv.slice(1), options);

  try {
    await once(child, "spawn");
  } catch (err) {
    throw toErrorObject(err, "Non-Error rejection");
  }
  return child;
}

export async function spawnWithFallback(
  params: SpawnWithFallbackParams,
): Promise<SpawnWithFallbackResult> {
  const spawnImpl = params.spawnImpl ?? spawnProcess;
  const baseOptions = { ...params.options };
  const fallbacks = params.fallbacks ?? [];
  const attempts = [baseOptions, ...fallbacks.map((options) => ({ ...baseOptions, ...options }))];

  let lastError: unknown;
  for (const [index, attempt] of attempts.entries()) {
    // Caller revocation is not a spawn failure and cannot select a fallback.
    params.assertCurrent?.();
    try {
      const child = await spawnAndWaitForSpawn(spawnImpl, params.argv, attempt);
      return {
        child,
        usedFallback: index > 0,
      };
    } catch (err) {
      lastError = err;
      const nextFallback = fallbacks[index];
      if (!nextFallback || !shouldRetry(err)) {
        throw err;
      }
    }
  }

  throw lastError;
}
