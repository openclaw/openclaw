import { execFileSync } from "node:child_process";
import { inspectPortUsage } from "../infra/ports-inspect.js";
import { resolveLsofCommandSync } from "../infra/ports-lsof.js";

export type PortProcess = { pid: number; command?: string };

export type ForceFreePortResult = {
  killed: PortProcess[];
  waitedMs: number;
  escalatedToSigkill: boolean;
};

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function parseLsofOutput(output: string): PortProcess[] {
  const lines = output.split(/\r?\n/).filter(Boolean);
  const results: PortProcess[] = [];
  let current: Partial<PortProcess> = {};
  for (const line of lines) {
    if (line.startsWith("p")) {
      if (current.pid) results.push(current as PortProcess);
      current = { pid: Number.parseInt(line.slice(1), 10) };
    } else if (line.startsWith("c")) {
      current.command = line.slice(1);
    }
  }
  if (current.pid) results.push(current as PortProcess);
  return results;
}

/**
 * Cross-platform list port listeners.
 * On Windows, uses inspectPortUsage (netstat).
 * On Unix, uses lsof for efficiency.
 */
async function listPortListenersAsync(port: number): Promise<PortProcess[]> {
  if (process.platform === "win32") {
    const diagnostics = await inspectPortUsage(port);
    return diagnostics.listeners
      .filter((l) => l.pid && l.pid > 0)  // Filter out invalid PIDs
      .map((l) => ({
        pid: l.pid!,
        command: l.command || l.commandLine?.split(" ").pop(),
      }));
  }
  // Unix: use lsof for efficiency
  return listPortListeners(port);
}

export function listPortListeners(port: number): PortProcess[] {
  try {
    const lsof = resolveLsofCommandSync();
    const out = execFileSync(lsof, ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-FpFc"], {
      encoding: "utf-8",
    });
    return parseLsofOutput(out);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      throw new Error("lsof not found; required for --force");
    }
    if (status === 1) return []; // no listeners
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export async function killProcess(pid: number, signal: NodeJS.Signals): Promise<void> {
  if (process.platform === "win32") {
    // Windows: use taskkill for SIGTERM and SIGKILL
    const isSigkill = signal === "SIGKILL";
    const flag = isSigkill ? "/F" : ""; // /F for force (SIGKILL), no flag for graceful (SIGTERM)
    try {
      execFileSync("taskkill", [flag, "/PID", String(pid)], { windowsHide: true });
    } catch (err) {
      const code = (err as { code?: number }).code;
      // Exit code 128 means process already terminated
      if (code !=== 128) {
        throw new Error(
          `failed to kill pid ${pid}: ${String((err as { stderr?: string }).stderr || err)}`,
        );
      }
    }
  } else {
    // Unix: use process.kill
    process.kill(pid, signal);
  }
}

export async function forceFreePortAsync(port: number): Promise<PortProcess[]> {
  const listeners = await listPortListenersAsync(port);
  for (const proc of listeners) {
    try {
      await killProcess(proc.pid, "SIGTERM");
    } catch (err) {
      throw new Error(
        `failed to kill pid ${proc.pid}${proc.command ? ` (${proc.command})` : ""}: ${String(err)}`,
      );
    }
  }
  return listeners;
}

export function forceFreePort(port: number, signal: NodeJS.Signals = "SIGTERM"): PortProcess[] {
  const listeners = listPortListeners(port);
  for (const proc of listeners) {
    try {
      process.kill(proc.pid, signal);
    } catch (err) {
      throw new Error(
        `failed to kill pid ${proc.pid}${proc.command ? `(${proc.command})` : ""}: ${String(err)}`,
      );
    }
  }
  return listeners;
}

async function killPidsAsync(listeners: PortProcess[], signal: NodeJS.Signals) {
  for (const proc of listeners) {
    await killProcess(proc.pid, signal);
  }
}

async function checkPortFree(port: number): Promise<boolean> {
  const listeners = await listPortListenersAsync(port);
  return listeners.length === 0;
}

export async function forceFreePortAndWait(
  port: number,
  opts: {
    /** Total wait budget across signals. */
    timeoutMs?: number;
    /** Poll interval for checking whether port reports listeners. */
    intervalMs?: number;
    /** How long to wait after SIGTERM before escalating to SIGKILL. */
    sigtermTimeoutMs?: number;
  } = {},
): Promise<ForceFreePortResult> {
  const timeoutMs = Math.max(opts.timeoutMs ?? 1500, 0);
  const intervalMs = Math.max(opts.intervalMs ?? 100, 1);
  const sigtermTimeoutMs = Math.min(Math.max(opts.sigtermTimeoutMs ?? 600, 0), timeoutMs);

  const killed = await forceFreePortAsync(port);
  if (killed.length === 0) {
    return { killed, waitedMs: 0, escalatedToSigkill: false };
  }

  let waitedMs = 0;
  const triesSigterm = intervalMs > 0 ? Math.ceil(sigtermTimeoutMs / intervalMs) : 0;
  for (let i = 0; i < triesSigterm; i++) {
    if (await checkPortFree(port)) {
      return { killed, waitedMs, escalatedToSigkill: false };
    }
    await sleep(intervalMs);
    waitedMs += intervalMs;
  }

  if (await checkPortFree(port)) {
    return { killed, waitedMs, escalatedToSigkill: false };
  }

  const remaining = await listPortListenersAsync(port);
  await killPidsAsync(remaining, "SIGKILL");

  const remainingBudget = Math.max(timeoutMs - waitedMs, 0);
  const triesSigkill = intervalMs > 0 ? Math.ceil(remainingBudget / intervalMs) : 0;
  for (let i = 0; i < triesSigkill; i++) {
    if (await checkPortFree(port)) {
      return { killed, waitedMs, escalatedToSigkill: true };
    }
    await sleep(intervalMs);
    waitedMs += intervalMs;
  }

  const still = await listPortListenersAsync(port);
  if (still.length === 0) {
    return { killed, waitedMs, escalatedToSigkill: true };
  }

  throw new Error(
    `port ${port} still has listeners after --force: ${still.map((p) => p.pid).join(", ")}`,
  );
}
