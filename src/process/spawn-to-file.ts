import type { ChildProcess, SpawnOptions } from "node:child_process";
import path from "node:path";
import { getAgentExecCgroup, type ProcessExecutionIntent } from "./linux-exec-cgroup.js";
import { getSpawnBroker } from "./spawn-broker/context.js";
import { prepareProcessOutputFile } from "./spawn-broker/file-output.js";
import { brokerSpawnOptions } from "./spawn-broker/pipe.js";
import type { ProcessOutputFile } from "./spawn-broker/protocol.js";
import { recordChildProcessSpawn } from "./spawn-diagnostics.js";
import type { SpawnInitiation } from "./spawn-initiation.js";
import { spawnProcess } from "./spawn-utils.js";

/** Keep stdout bytes with their file owner instead of transferring them to the Gateway. */
export async function spawnProcessToFile(
  command: string,
  args: string[],
  options: SpawnOptions,
  output: ProcessOutputFile,
  initiateSpawn?: SpawnInitiation,
  executionIntent: ProcessExecutionIntent = "gateway-internal",
): Promise<{ child: ChildProcess; output: Promise<number> }> {
  const target = { ...output, path: path.resolve(output.path) };
  const broker = getSpawnBroker();
  const prepared = broker && brokerSpawnOptions(options);
  if (broker && prepared) {
    const spawned = broker.spawnToFile(
      command,
      args,
      prepared,
      target,
      initiateSpawn,
      executionIntent === "agent-tool" ? getAgentExecCgroup() : undefined,
    );
    recordChildProcessSpawn(command, spawned.child, undefined, args);
    return spawned;
  }
  const destination = await prepareProcessOutputFile(target);
  try {
    const stdio = options.stdio ?? "pipe";
    const entries = typeof stdio === "string" ? [stdio, stdio, stdio] : [...stdio];
    entries[1] = destination.stdio;
    const child = spawnProcess(
      command,
      args,
      { ...options, stdio: entries },
      initiateSpawn,
      executionIntent,
    );
    return { child, output: destination.start(child, options.detached) };
  } catch (error) {
    await destination.close();
    throw error;
  }
}
