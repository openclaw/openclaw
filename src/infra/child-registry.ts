// src/infra/child-registry.ts
import type { ChildProcess } from "node:child_process";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("child-registry");

type ChildEntry = {
  name: string;
  process: ChildProcess;
  managedExternally: boolean;
};

const children = new Map<number, ChildEntry>();

export function registerChild(
  name: string,
  proc: ChildProcess,
  opts?: { managedExternally?: boolean },
): void {
  if (!proc.pid) {
    log.warn(`Cannot register child "${name}": no PID (spawn may have failed)`);
    return;
  }

  children.set(proc.pid, {
    name,
    process: proc,
    managedExternally: opts?.managedExternally ?? false,
  });

  const cleanup = () => {
    if (proc.pid) children.delete(proc.pid);
  };
  proc.on("exit", cleanup);
  proc.on("error", cleanup);
}

export function unregisterChild(pid: number): void {
  children.delete(pid);
}

export async function killAllChildren(
  signal: NodeJS.Signals = "SIGTERM",
  opts?: { excludeManaged?: boolean; timeoutMs?: number },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? (signal === "SIGKILL" ? 500 : 3000);
  const excludeManaged = opts?.excludeManaged ?? false;
  const promises: Promise<void>[] = [];

  // Copy entries to avoid mutation during iteration
  const entries = [...children.entries()];
  for (const [pid, entry] of entries) {
    const { name, process: proc, managedExternally } = entry;

    if (excludeManaged && managedExternally) {
      continue;
    }

    if (proc.killed || proc.exitCode !== null || proc.signalCode !== null) {
      children.delete(pid);
      continue;
    }

    log.info(`Killing child process: ${name} (pid=${pid}) with ${signal}`);
    promises.push(killWithTimeout(pid, proc, signal, timeoutMs, name));
  }

  await Promise.all(promises);
}

async function killWithTimeout(
  pid: number,
  proc: ChildProcess,
  signal: NodeJS.Signals,
  timeoutMs: number,
  name: string,
): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return;
  }

  try {
    proc.kill(signal);
  } catch (err) {
    const errnoErr = err as NodeJS.ErrnoException;
    if (errnoErr.code !== "ESRCH") {
      log.warn(`Failed to send ${signal} to ${name}: ${errnoErr.message}`);
    }
    return;
  }

  if (timeoutMs <= 0) return;

  await Promise.race([
    new Promise<void>((resolve) => proc.once("exit", resolve)),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);

  if (proc.exitCode === null && proc.signalCode === null) {
    if (signal !== "SIGKILL") {
      log.warn(`${name} did not exit after ${timeoutMs}ms; sending SIGKILL`);
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }

      await new Promise<void>((resolve) => setTimeout(resolve, 500));

      if (proc.exitCode === null && proc.signalCode === null) {
        log.warn(`Process ${name} (pid=${pid}) did not respond to SIGKILL; proceeding anyway`);
      }
    } else {
      log.warn(
        `Process ${name} (pid=${pid}) did not respond to SIGKILL after ${timeoutMs}ms; proceeding anyway`,
      );
    }
  }

  children.delete(pid);
}

export function killAllChildrenSync(): void {
  // Copy entries to avoid mutation during iteration
  const entries = [...children.entries()];
  for (const [pid, { name, process: proc }] of entries) {
    if (proc.exitCode !== null || proc.signalCode !== null) continue;
    try {
      // Use console.error since logging may be unreliable during process exit
      console.error(`[child-registry] Force-killing child process: ${name} (pid=${pid})`);
      proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
  children.clear();
}

export function getRegisteredChildren(): Array<{
  pid: number;
  name: string;
  managedExternally: boolean;
}> {
  return [...children.entries()].map(([pid, entry]) => ({
    pid,
    name: entry.name,
    managedExternally: entry.managedExternally,
  }));
}

export function clearRegistry(): void {
  children.clear();
}
