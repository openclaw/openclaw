import { readProcessIdentity, isSupported } from "@openclaw/proc-safe/identity";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import { GRACEFUL_CANCEL_TIMEOUT_MS } from "./cancellation-policy.js";
import type { ReleasedProcess } from "./types.js";

const REAP_INTERVAL_MS = 5_000;

/** A process a command left running, pinned to its start time so a reused PID is never signalled. */
type AdoptedProcess = ReleasedProcess & {
  scopeKey: string;
  startTime?: number;
  onExit: () => void;
  stopping?: Promise<void>;
};

const state = resolveGlobalSingleton(Symbol.for("openclaw.adoptedProcesses"), () => ({
  adopted: new Set<AdoptedProcess>(),
  reaper: undefined as NodeJS.Timeout | undefined,
}));

function startTimeOf(pid: number): number | undefined {
  try {
    const identity = isSupported() ? readProcessIdentity(pid) : null;
    // Linux wall-clock start estimates drift; the since-boot birth is stable.
    return identity && !identity.exited
      ? (identity.startTimeSinceBootMicros ?? identity.startTimeMicros)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The same live process we recorded: a reused PID has a different start time. */
function isSameLiveProcess(entry: { pid: number; startTime?: number }): boolean {
  if (isPidDefinitelyDead(entry.pid)) {
    return false;
  }
  return entry.startTime === undefined || startTimeOf(entry.pid) === entry.startTime;
}

function settle(entry: AdoptedProcess): void {
  if (state.adopted.delete(entry)) {
    entry.onExit();
  }
  if (state.adopted.size === 0 && state.reaper) {
    clearInterval(state.reaper);
    state.reaper = undefined;
  }
}

function reap(): void {
  for (const entry of state.adopted) {
    if (!entry.stopping && !isSameLiveProcess(entry)) {
      settle(entry);
    }
  }
}

/** SIGTERM, then SIGKILL after the cancel grace; each signal re-checks process identity. */
async function terminate(entry: { pid: number; startTime?: number }): Promise<void> {
  const signal = (name: NodeJS.Signals) => {
    if (!isSameLiveProcess(entry)) {
      return false;
    }
    try {
      process.kill(entry.pid, name);
      return true;
    } catch {
      return false;
    }
  };
  if (!signal("SIGTERM")) {
    return;
  }
  const deadline = Date.now() + GRACEFUL_CANCEL_TIMEOUT_MS;
  while (isSameLiveProcess(entry) && Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  signal("SIGKILL");
}

function stopEntry(entry: AdoptedProcess): Promise<void> {
  return (entry.stopping ??= terminate(entry).finally(() => {
    settle(entry);
  }));
}

/** Stop a process that cannot be adopted (over the cap) by its observed identity. */
export async function killReleasedProcess(survivor: ReleasedProcess): Promise<void> {
  await terminate({ pid: survivor.pid, startTime: startTimeOf(survivor.pid) });
}

/**
 * Take custody of a handed-off process: it is reaped when it exits and stopped on
 * request, session reset, or host stop. Undefined when it already exited.
 */
export function adoptReleasedProcess(
  scopeKey: string,
  survivor: ReleasedProcess,
  onExit: () => void,
): { stop: () => Promise<void> } | undefined {
  const startTime = startTimeOf(survivor.pid);
  if (startTime === undefined && isPidDefinitelyDead(survivor.pid)) {
    return undefined;
  }
  const entry: AdoptedProcess = Object.assign({}, survivor, { scopeKey, startTime, onExit });
  state.adopted.add(entry);
  state.reaper ??= setInterval(reap, REAP_INTERVAL_MS);
  state.reaper.unref();
  return { stop: () => stopEntry(entry) };
}

/** A one-shot run ends: its processes keep running without OpenClaw. */
export function forgetReleasedProcesses(scopeKey: string): ReleasedProcess[] {
  const handedOff: ReleasedProcess[] = [];
  for (const entry of state.adopted) {
    if (entry.scopeKey === scopeKey && isSameLiveProcess(entry)) {
      state.adopted.delete(entry);
      handedOff.push(
        entry.command === undefined
          ? { pid: entry.pid }
          : { pid: entry.pid, command: entry.command },
      );
    }
  }
  return handedOff;
}

/** Host stop: stop every adopted process. Session reset stops its own through their sessions. */
export async function stopReleasedProcesses(): Promise<void> {
  await Promise.all([...state.adopted].map(stopEntry));
}
