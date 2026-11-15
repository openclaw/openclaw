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
  stopping?: Promise<StopOutcome>;
};

const state = resolveGlobalSingleton(Symbol.for("openclaw.adoptedProcesses"), () => ({
  adopted: new Set<AdoptedProcess>(),
  // SAFETY: the reaper slot starts empty; only trackers below assign it.
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

/** Stopping is confirmed only by observing that the recorded process identity is gone. */
export type StopOutcome = { status: "stopped" } | { status: "uncertain"; reason: string };

const KILL_CONFIRM_TIMEOUT_MS = 2_000;

async function waitForExit(entry: { pid: number; startTime?: number }, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (isSameLiveProcess(entry) && Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  return !isSameLiveProcess(entry);
}

/** SIGTERM, then SIGKILL after the cancel grace; each signal re-checks process identity. */
async function terminate(entry: { pid: number; startTime?: number }): Promise<StopOutcome> {
  // "sent", "gone", or the reason the signal failed.
  const signal = (name: NodeJS.Signals): { result: "sent" | "gone" } | { failed: string } => {
    if (!isSameLiveProcess(entry)) {
      return { result: "gone" };
    }
    try {
      process.kill(entry.pid, name);
      return { result: "sent" };
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : String(error);
      return code === "ESRCH" ? { result: "gone" } : { failed: `${name} failed (${code})` };
    }
  };
  const term = signal("SIGTERM");
  if ("result" in term && term.result === "gone") {
    return { status: "stopped" };
  }
  if ("result" in term && (await waitForExit(entry, GRACEFUL_CANCEL_TIMEOUT_MS))) {
    return { status: "stopped" };
  }
  const kill = signal("SIGKILL");
  if (
    ("result" in kill && kill.result === "gone") ||
    (await waitForExit(entry, KILL_CONFIRM_TIMEOUT_MS))
  ) {
    return { status: "stopped" };
  }
  const reason =
    "failed" in kill
      ? kill.failed
      : "failed" in term
        ? term.failed
        : "it did not exit after SIGKILL";
  return { status: "uncertain", reason };
}

function stopEntry(entry: AdoptedProcess): Promise<StopOutcome> {
  return (entry.stopping ??= terminate(entry).then((outcome) => {
    if (outcome.status === "stopped") {
      settle(entry);
    } else {
      // Keep the record: the process may still run. A later stop can retry.
      entry.stopping = undefined;
    }
    return outcome;
  }));
}

/** Stop a process that cannot be adopted (over the cap) by its observed identity. */
export async function killReleasedProcess(survivor: ReleasedProcess): Promise<StopOutcome> {
  return await terminate({ pid: survivor.pid, startTime: startTimeOf(survivor.pid) });
}

/**
 * Take custody of a handed-off process: it is reaped when it exits and stopped on
 * request, session reset, or host stop. Undefined when it already exited.
 */
export function adoptReleasedProcess(
  scopeKey: string,
  survivor: ReleasedProcess,
  onExit: () => void,
): { stop: () => Promise<StopOutcome> } | undefined {
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

/** Host stop: stop every adopted process and report those whose exit could not be confirmed. */
export async function stopReleasedProcesses(): Promise<void> {
  const entries = [...state.adopted];
  const outcomes = await Promise.all(entries.map(stopEntry));
  const unconfirmed = entries.flatMap((entry, index) => {
    const outcome = outcomes[index]!;
    return outcome.status === "uncertain" ? [`pid ${entry.pid} (${outcome.reason})`] : [];
  });
  if (unconfirmed.length > 0) {
    // The records stay; a later stop retries them.
    const { warnProcessSupervisorFailure } = await import("./supervisor-log.runtime.js");
    warnProcessSupervisorFailure(
      `Could not confirm that these processes stopped: ${unconfirmed.join(", ")}`,
    );
  }
}
