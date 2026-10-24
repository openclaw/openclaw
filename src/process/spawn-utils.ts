import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { expectDefined } from "@openclaw/normalization-core";
import { assertAppContainerSpawnSupported } from "../infra/windows-appcontainer-spawn.js";
import { prepareOomScoreAdjustedSpawn } from "./linux-oom-score.js";
import { getSpawnBroker } from "./spawn-broker/context.js";
import { brokerSpawnOptions } from "./spawn-broker/pipe.js";
import { recordChildProcessSpawn } from "./spawn-diagnostics.js";
import type { SpawnInitiation } from "./spawn-initiation.js";

/** Select the process-scoped native spawn transport without changing launch options. */
export function spawnProcess(
  command: string,
  args: string[],
  options: SpawnOptions,
  initiateSpawn?: SpawnInitiation,
): ChildProcess {
  assertAppContainerSpawnSupported(options.stdio);
  const broker = getSpawnBroker();
  // Anonymous secret pipes and inherited numeric descriptors belong to this process.
  const child =
    broker && brokerSpawnOptions(options)
      ? broker.spawn(command, args, options, initiateSpawn)
      : initiateSpawn
        ? initiateSpawn(() => spawn(command, args, options))
        : spawn(command, args, options);
  if (!options.shell && options.argv0 !== undefined) {
    prepareOomScoreAdjustedSpawn(command, args, options).afterSpawn?.(child.pid);
  }
  recordChildProcessSpawn(command, child, undefined, args);
  return child;
}

/** Launch once and surface native spawn failures without changing the process topology. */
export async function spawnAndWait(params: {
  assertCurrent?: () => void;
  initiateSpawn?: SpawnInitiation;
  argv: string[];
  options: SpawnOptions;
  spawnImpl?: typeof spawnProcess;
}): Promise<ChildProcess> {
  // Custom Windows transports can add launcher IPC even when the target inherits stdio.
  assertAppContainerSpawnSupported(params.spawnImpl ? undefined : params.options.stdio);
  const spawnImpl = params.spawnImpl ?? spawnProcess;
  params.assertCurrent?.();
  const child = spawnImpl(
    expectDefined(params.argv[0], "argv entry at 0"),
    params.argv.slice(1),
    params.options,
    params.initiateSpawn,
  );
  await once(child, "spawn");
  return child;
}
