import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";
import { once } from "node:events";
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
  // Anonymous secret pipes and inherited numeric descriptors belong to this process.
  const child =
    broker && brokerSpawnOptions(options)
      ? broker.spawn(command, args, options, initiateSpawn, agentExecCgroup)
      : agentExecCgroup && !broker
        ? spawnInsideAgentExecCgroup(command, args, options, agentExecCgroup, initiateSpawn)
        : initiateSpawn
          ? initiateSpawn(() =>
              runWithMainThreadTask("process:spawn", () => spawn(command, args, options), "native"),
            )
          : runWithMainThreadTask("process:spawn", () => spawn(command, args, options), "native");
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
): ChildProcess {
  return initiateSpawn
    ? initiateSpawn(() =>
        runWithMainThreadTask("process:spawn", () => spawn(command, args, options), "native"),
      )
    : runWithMainThreadTask("process:spawn", () => spawn(command, args, options), "native");
}

/**
 * The spawn broker moves a child into the agent exec cgroup from outside, and it
 * exists only where its command transport is supported; the Gateway also ships on
 * runtimes that start no broker. Elsewhere the child moves itself instead: the
 * launcher writes its own pid into the cgroup and replaces itself with the
 * requested command, so pid, stdio, cwd, argv0 and signal semantics are unchanged.
 */
function spawnInsideAgentExecCgroup(
  command: string,
  args: string[],
  options: SpawnOptions,
  agentExecCgroup: string,
  initiateSpawn?: SpawnInitiation,
): ChildProcess {
  if (options.shell === true || options.argv0 !== undefined) {
    return spawnDirectly(command, args, options, initiateSpawn);
  }
  const cgroupProcs = `${agentExecCgroup}/cgroup.procs`.replace(/'/g, `'\\''`);
  const launcher = [
    // Placement is best effort: an unwritable cgroup must not fail the command.
    `printf '%s' "$$" > '${cgroupProcs}' 2>/dev/null || true`,
    'exec "$@"',
  ].join("; ");
  return spawnDirectly(
    "/bin/sh",
    ["-c", launcher, "openclaw-agent-exec", command, ...args],
    options,
    initiateSpawn,
  );
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
