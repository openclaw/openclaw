import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { runWithMainThreadTask } from "../infra/main-thread-stall.js";
import { assertAppContainerSpawnSupported } from "../infra/windows-appcontainer-spawn.js";
import { getAgentExecCgroup, type ProcessExecutionIntent } from "./linux-exec-cgroup.js";
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
  executionIntent: ProcessExecutionIntent = "gateway-internal",
): ChildProcess {
  assertAppContainerSpawnSupported(options.stdio);
  const broker = getSpawnBroker();
  const agentExecCgroup = executionIntent === "agent-tool" ? getAgentExecCgroup() : undefined;
  // The broker places the child itself; without one the parent does it after the fork.
  const placeParentSide =
    agentExecCgroup && !broker
      ? (child: ChildProcess) => placeChild(child, agentExecCgroup)
      : undefined;
  // Anonymous secret pipes and inherited numeric descriptors belong to this process.
  const child =
    broker && brokerSpawnOptions(options)
      ? broker.spawn(command, args, options, initiateSpawn, agentExecCgroup)
      : spawnDirectly(command, args, options, initiateSpawn, placeParentSide);
  if (!options.shell && options.argv0 !== undefined) {
    prepareOomScoreAdjustedSpawn(command, args, options).afterSpawn?.(child.pid);
  }
  recordChildProcessSpawn(command, child, undefined, args);
  return child;
}

function spawnDirectly(
  command: string,
  args: string[],
  options: SpawnOptions,
  initiateSpawn?: SpawnInitiation,
  afterSpawn?: (child: ChildProcess) => void,
): ChildProcess {
  const launch = () => {
    const child = spawn(command, args, options);
    afterSpawn?.(child);
    return child;
  };
  return initiateSpawn
    ? initiateSpawn(() => runWithMainThreadTask("process:spawn", launch, "native"))
    : runWithMainThreadTask("process:spawn", launch, "native");
}

/**
 * The spawn broker moves a child into the agent exec cgroup from outside, and it
 * exists only where its command transport is supported; the Gateway also ships on
 * runtimes that start no broker. There the parent places the child it just started:
 * one write of the child's pid keeps the native launch path, so a target that cannot
 * start still fails with its own ENOENT, EACCES or missing-interpreter error instead
 * of the wrapper's exit status.
 *
 * A child that forks before this write leaves those first descendants in the parent's
 * cgroup. That is accepted: they are bounded by the exec that follows, and hiding
 * startup failures behind a launcher is the worse trade for every caller.
 */
function placeChild(child: ChildProcess, agentExecCgroup: string): void {
  if (child.pid === undefined) {
    return;
  }
  try {
    writeFileSync(`${agentExecCgroup}/cgroup.procs`, String(child.pid));
  } catch {
    // Best effort: an unwritable or vanished cgroup must not fail the command.
  }
}

/** Launch once and surface native spawn failures without changing the process topology. */
export async function spawnAndWait(params: {
  assertCurrent?: () => void;
  initiateSpawn?: SpawnInitiation;
  executionIntent?: ProcessExecutionIntent;
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
    params.executionIntent,
  );
  await once(child, "spawn");
  return child;
}
