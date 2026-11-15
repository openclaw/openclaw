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
  executionScopeKey?: string,
): ChildProcess {
  assertAppContainerSpawnSupported(options.stdio);
  const broker = getSpawnBroker();
  // Anonymous secret pipes and inherited numeric descriptors belong to this process.
  const child =
    broker && brokerSpawnOptions(options)
      ? broker.spawn(
          command,
          args,
          options,
          initiateSpawn,
          executionIntent === "agent-tool" ? getAgentExecCgroup(executionScopeKey) : undefined,
        )
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

/**
 * Spawn a shell that places itself in the agent exec cgroup before it runs the
 * command. The broker does this from outside, but it exists only where its command
 * transport is supported, and the Gateway also ships on runtimes that start none.
 *
 * The launcher reports its own startup, so this transport is opt-in at the caller
 * that can live with it — a shell that cannot start makes the capture or validation
 * fall back, which is what already happens when a snapshot cannot be produced.
 * `spawnProcess` keeps the native launch path, and with it ENOENT, EACCES and
 * missing-interpreter errors for every caller of the shared startup contract.
 */
export function spawnPlacedAgentShell(
  command: string,
  args: string[],
  options: SpawnOptions,
  initiateSpawn?: SpawnInitiation,
): ChildProcess {
  const broker = getSpawnBroker();
  const agentExecCgroup = broker && brokerSpawnOptions(options) ? undefined : getAgentExecCgroup();
  if (!agentExecCgroup || options.shell === true || options.argv0 !== undefined) {
    return spawnProcess(command, args, options, initiateSpawn, "agent-tool");
  }
  const cgroupProcs = `${agentExecCgroup}/cgroup.procs`.replace(/'/g, `'\\''`);
  const launcher = [
    // Placement is best effort: an unwritable cgroup must not fail the capture.
    // The append keeps the write from asking the cgroup file to be truncated.
    `printf '%s\\n' "$$" >> '${cgroupProcs}' 2>/dev/null || true`,
    'exec "$@"',
  ].join("; ");
  return spawnProcess(
    "/bin/sh",
    ["-c", launcher, "openclaw-agent-exec", command, ...args],
    options,
    initiateSpawn,
    "agent-tool",
  );
}

/** Launch once and surface native spawn failures without changing the process topology. */
export async function spawnAndWait(params: {
  assertCurrent?: () => void;
  initiateSpawn?: SpawnInitiation;
  executionIntent?: ProcessExecutionIntent;
  executionScopeKey?: string;
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
    params.executionScopeKey,
  );
  await once(child, "spawn");
  return child;
}
