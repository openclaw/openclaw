import { execFileSync } from "node:child_process";
import { resolveLsofCommandSync } from "../infra/ports-lsof.js";
import { tryListenOnPort } from "../infra/ports-probe.js";
import { sleep } from "../utils.js";

export type PortProcess = { pid: number; command?: string };

export type ForceFreePortResult = {
  killed: PortProcess[];
  waitedMs: number;
  escalatedToSigkill: boolean;
};

type ExecFileError = NodeJS.ErrnoException & {
  status?: number | null;
  stderr?: string | Buffer;
  stdout?: string | Buffer;
  cause?: unknown;
};

const FUSER_SIGNALS: Record<"SIGTERM" | "SIGKILL", string> = {
  SIGTERM: "TERM",
  SIGKILL: "KILL",
};

function readExecOutput(value: string | Buffer | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Buffer) {
    return value.toString("utf8");
  }
  return "";
}

function withErrnoCode(message: string, code: string, cause: unknown): Error {
  const out = new Error(message, { cause: cause instanceof Error ? cause : undefined }) as Error &
    NodeJS.ErrnoException;
  out.code = code;
  return out;
}

function getErrnoCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const direct = (err as { code?: unknown }).code;
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const nested = (cause as { code?: unknown }).code;
    if (typeof nested === "string" && nested.length > 0) {
      return nested;
    }
  }
  return undefined;
}

function isRecoverableLsofError(err: unknown): boolean {
  const code = getErrnoCode(err);
  if (code === "ENOENT" || code === "EACCES" || code === "EPERM") {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /lsof.*(permission denied|not permitted|operation not permitted|eacces|eperm)/i.test(
    message,
  );
}

function parseFuserPidList(output: string): number[] {
  if (!output) {
    return [];
  }
  const values = new Set<number>();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const pidRegion = line.includes(":") ? line.slice(line.indexOf(":") + 1) : line;
    const pidMatches = pidRegion.match(/\d+/g) ?? [];
    for (const match of pidMatches) {
      const pid = Number.parseInt(match, 10);
      if (Number.isFinite(pid) && pid > 0) {
        values.add(pid);
      }
    }
  }
  return [...values];
}

function killPortWithFuser(port: number, signal: "SIGTERM" | "SIGKILL"): PortProcess[] {
  const args = ["-k", `-${FUSER_SIGNALS[signal]}`, `${port}/tcp`];
  try {
    const stdout = execFileSync("fuser", args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parseFuserPidList(stdout).map((pid) => ({ pid }));
  } catch (err: unknown) {
    const execErr = err as ExecFileError;
    const code = execErr.code;
    const status = execErr.status;
    const stdout = readExecOutput(execErr.stdout);
    const stderr = readExecOutput(execErr.stderr);
    const parsed = parseFuserPidList([stdout, stderr].filter(Boolean).join("\n"));
    if (status === 1) {
      // fuser exits 1 if nothing matched; keep any parsed PIDs in case signal succeeded.
      return parsed.map((pid) => ({ pid }));
    }
    if (code === "ENOENT") {
      throw withErrnoCode(
        "fuser not found; required for --force when lsof is unavailable",
        "ENOENT",
        err,
      );
    }
    if (code === "EACCES" || code === "EPERM") {
      throw withErrnoCode("fuser permission denied while forcing gateway port", code, err);
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

async function isPortBusy(port: number): Promise<boolean> {
  try {
    await tryListenOnPort({ port, exclusive: true });
    return false;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      return true;
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export function parseLsofOutput(output: string): PortProcess[] {
  const lines = output.split(/\r?\n/).filter(Boolean);
  const results: PortProcess[] = [];
  let current: Partial<PortProcess> = {};
  for (const line of lines) {
    if (line.startsWith("p")) {
      if (current.pid) {
        results.push(current as PortProcess);
      }
      current = { pid: Number.parseInt(line.slice(1), 10) };
    } else if (line.startsWith("c")) {
      current.command = line.slice(1);
    }
  }
  if (current.pid) {
    results.push(current as PortProcess);
  }
  return results;
}

export function listPortListeners(port: number): PortProcess[] {
  try {
    const lsof = resolveLsofCommandSync();
    const out = execFileSync(lsof, ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-FpFc"], {
      encoding: "utf-8",
    });
    return parseLsofOutput(out);
  } catch (err: unknown) {
    const execErr = err as ExecFileError;
    const status = execErr.status ?? undefined;
    const code = execErr.code;
    if (code === "ENOENT") {
      throw withErrnoCode("lsof not found; required for --force", "ENOENT", err);
    }
    if (code === "EACCES" || code === "EPERM") {
      throw withErrnoCode("lsof permission denied while inspecting gateway port", code, err);
    }
    if (status === 1) {
      const stderr = readExecOutput(execErr.stderr).trim();
      if (
        stderr &&
        /permission denied|not permitted|operation not permitted|can't stat/i.test(stderr)
      ) {
        throw withErrnoCode(
          `lsof permission denied while inspecting gateway port: ${stderr}`,
          "EACCES",
          err,
        );
      }
      return [];
    } // no listeners
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export function forceFreePort(port: number): PortProcess[] {
  const listeners = listPortListeners(port);
  for (const proc of listeners) {
    try {
      process.kill(proc.pid, "SIGTERM");
    } catch (err) {
      throw new Error(
        `failed to kill pid ${proc.pid}${proc.command ? ` (${proc.command})` : ""}: ${String(err)}`,
        { cause: err },
      );
    }
  }
  return listeners;
}

function killPids(listeners: PortProcess[], signal: NodeJS.Signals) {
  for (const proc of listeners) {
    try {
      process.kill(proc.pid, signal);
    } catch (err) {
      throw new Error(
        `failed to kill pid ${proc.pid}${proc.command ? ` (${proc.command})` : ""}: ${String(err)}`,
        { cause: err },
      );
    }
  }
}

export async function forceFreePortAndWait(
  port: number,
  opts: {
    /** Total wait budget across signals. */
    timeoutMs?: number;
    /** Poll interval for checking whether lsof reports listeners. */
    intervalMs?: number;
    /** How long to wait after SIGTERM before escalating to SIGKILL. */
    sigtermTimeoutMs?: number;
  } = {},
): Promise<ForceFreePortResult> {
  const timeoutMs = Math.max(opts.timeoutMs ?? 1500, 0);
  const intervalMs = Math.max(opts.intervalMs ?? 100, 1);
  const sigtermTimeoutMs = Math.min(Math.max(opts.sigtermTimeoutMs ?? 600, 0), timeoutMs);

  let killed: PortProcess[] = [];
  let useFuserFallback = false;

  try {
    killed = forceFreePort(port);
  } catch (err) {
    if (!isRecoverableLsofError(err)) {
      throw err;
    }
    useFuserFallback = true;
    killed = killPortWithFuser(port, "SIGTERM");
  }

  const checkBusy = async (): Promise<boolean> =>
    useFuserFallback ? isPortBusy(port) : listPortListeners(port).length > 0;

  if (!(await checkBusy())) {
    return { killed, waitedMs: 0, escalatedToSigkill: false };
  }

  let waitedMs = 0;
  const triesSigterm = intervalMs > 0 ? Math.ceil(sigtermTimeoutMs / intervalMs) : 0;
  for (let i = 0; i < triesSigterm; i++) {
    if (!(await checkBusy())) {
      return { killed, waitedMs, escalatedToSigkill: false };
    }
    await sleep(intervalMs);
    waitedMs += intervalMs;
  }

  if (!(await checkBusy())) {
    return { killed, waitedMs, escalatedToSigkill: false };
  }

  if (useFuserFallback) {
    killPortWithFuser(port, "SIGKILL");
  } else {
    const remaining = listPortListeners(port);
    killPids(remaining, "SIGKILL");
  }

  const remainingBudget = Math.max(timeoutMs - waitedMs, 0);
  const triesSigkill = intervalMs > 0 ? Math.ceil(remainingBudget / intervalMs) : 0;
  for (let i = 0; i < triesSigkill; i++) {
    if (!(await checkBusy())) {
      return { killed, waitedMs, escalatedToSigkill: true };
    }
    await sleep(intervalMs);
    waitedMs += intervalMs;
  }

  if (!(await checkBusy())) {
    return { killed, waitedMs, escalatedToSigkill: true };
  }

  if (useFuserFallback) {
    throw new Error(`port ${port} still has listeners after --force (fuser fallback)`);
  }
  const still = listPortListeners(port);
  throw new Error(
    `port ${port} still has listeners after --force: ${still.map((p) => p.pid).join(", ")}`,
  );
}
