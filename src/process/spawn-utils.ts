import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { expectDefined } from "@openclaw/normalization-core";
import { toErrorObject } from "../infra/errors.js";
import { getSpawnBroker } from "./spawn-broker/context.js";
import { brokerSpawnOptions } from "./spawn-broker/host.js";
import { recordChildProcessSpawn } from "./spawn-diagnostics.js";
import type { SpawnInitiation } from "./spawn-initiation.js";

/** Select the process-scoped native spawn transport without changing launch options. */
export function spawnProcess(
  command: string,
  args: string[],
  options: SpawnOptions,
  initiateSpawn?: SpawnInitiation,
): ChildProcess {
  const broker = getSpawnBroker();
  // Anonymous secret pipes and inherited numeric descriptors belong to this process.
  const child =
    broker && brokerSpawnOptions(options)
      ? broker.spawn(command, args, options, initiateSpawn)
      : initiateSpawn
        ? initiateSpawn(() => spawn(command, args, options))
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
  initiateSpawn?: SpawnInitiation;
  argv: string[];
  options: SpawnOptions;
  fallbacks?: SpawnOptions[];
  spawnImpl?: typeof spawnProcess;
};

function shouldRetry(err: unknown): boolean {
  const code =
    err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "";
  return code === "EBADF";
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
      const child = spawnImpl(
        expectDefined(params.argv[0], "argv entry at 0"),
        params.argv.slice(1),
        attempt,
        params.initiateSpawn,
      );
      await once(child, "spawn").catch((err: unknown) => {
        throw toErrorObject(err, "Non-Error rejection");
      });
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
