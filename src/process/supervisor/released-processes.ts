import { readProcessIdentity, isSupported } from "@openclaw/proc-safe/identity";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { isPidDefinitelyDead, isPidDefinitelyDeadAsync } from "../../shared/pid-alive.js";
import { sleep } from "../../utils/sleep.js";
import { readCommandProcessStartTime } from "../command-process-identity.js";
import { GRACEFUL_CANCEL_TIMEOUT_MS } from "./cancellation-policy.js";
import type { ReleasedProcess } from "./types.js";

const REAP_INTERVAL_MS = 5_000;

/** A process a command left running, pinned to its start time so a reused PID is never signalled. */
type AdoptedProcess = ReleasedProcess & {
  scopeKey: string;
  startTime?: number | Promise<number | undefined>;
  onExit: () => void;
  stopping?: Promise<StopOutcome>;
};

const state = resolveGlobalSingleton<{
  adopted: Set<AdoptedProcess>;
  reaping: Promise<void> | undefined;
  reaper: NodeJS.Timeout | undefined;
}>(Symbol.for("openclaw.adoptedProcesses"), () => ({
  adopted: new Set<AdoptedProcess>(),
  reaping: undefined,
  reaper: undefined,
}));

function startTimeOf(pid: number): number | undefined | Promise<number | undefined> {
  if (process.platform === "linux" || process.platform === "android") {
    return Promise.resolve(readCommandProcessStartTime(pid)).then((birth) => birth ?? undefined);
  }
  try {
    const identity = isSupported() ? readProcessIdentity(pid) : null;
    return identity && !identity.exited
      ? (identity.startTimeSinceBootMicros ?? identity.startTimeMicros)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Undefined means inspection could not prove either the recorded process or its exit. */
async function isSameLiveProcess(
  entry: Pick<AdoptedProcess, "pid" | "startTime">,
): Promise<boolean | undefined> {
  const startTime = await entry.startTime;
  if (await isPidDefinitelyDeadAsync(entry.pid)) {
    return false;
  }
  if (startTime === undefined) {
    return undefined;
  }
  const current = await startTimeOf(entry.pid);
  return current === undefined ? undefined : current === startTime;
}

function settle(entry: AdoptedProcess): void {
  if (state.adopted.delete(entry)) {
    entry.onExit();
  }
  clearIdleReaper();
}

function clearIdleReaper(): void {
  if (state.adopted.size === 0 && state.reaper) {
    clearInterval(state.reaper);
    state.reaper = undefined;
  }
}

function reap(): Promise<void> {
  return (state.reaping ??= (async () => {
    for (const entry of state.adopted) {
      if (!entry.stopping && (await isSameLiveProcess(entry)) === false && !entry.stopping) {
        settle(entry);
      }
    }
  })().finally(() => {
    state.reaping = undefined;
  }));
}

/** Stopping is confirmed only by observing that the recorded process identity is gone. */
export type StopOutcome = { status: "stopped" } | { status: "uncertain"; reason: string };

const KILL_CONFIRM_TIMEOUT_MS = 2_000;

async function waitForExit(entry: Pick<AdoptedProcess, "pid" | "startTime">, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while ((await isSameLiveProcess(entry)) !== false && Date.now() < deadline) {
    await sleep(100);
  }
  return (await isSameLiveProcess(entry)) === false;
}

/** SIGTERM, then SIGKILL after the cancel grace; each signal re-checks process identity. */
async function terminate(entry: Pick<AdoptedProcess, "pid" | "startTime">): Promise<StopOutcome> {
  // "sent", "gone", or the reason the signal failed.
  const signal = async (
    name: NodeJS.Signals,
  ): Promise<{ result: "sent" | "gone" } | { failed: string }> => {
    const live = await isSameLiveProcess(entry);
    if (live === false) {
      return { result: "gone" };
    }
    if (live === undefined) {
      return { failed: "process identity unavailable" };
    }
    try {
      process.kill(entry.pid, name);
      return { result: "sent" };
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : String(error);
      return code === "ESRCH" ? { result: "gone" } : { failed: `${name} failed (${code})` };
    }
  };
  const term = await signal("SIGTERM");
  if ("result" in term && term.result === "gone") {
    return { status: "stopped" };
  }
  if ("result" in term && (await waitForExit(entry, GRACEFUL_CANCEL_TIMEOUT_MS))) {
    return { status: "stopped" };
  }
  const kill = await signal("SIGKILL");
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
  // Publish custody before Linux birth I/O settles; shutdown and Stop join the same capture.
  // An already-exited Linux survivor may remain visible until the next reap confirms it.
  const entry: AdoptedProcess = Object.assign({}, survivor, { scopeKey, startTime, onExit });
  state.adopted.add(entry);
  state.reaper ??= setInterval(() => {
    void reap();
  }, REAP_INTERVAL_MS);
  state.reaper.unref();
  return { stop: () => stopEntry(entry) };
}

/** A one-shot run ends: its processes keep running without OpenClaw. */
export async function forgetReleasedProcesses(scopeKey: string): Promise<ReleasedProcess[]> {
  const handedOff: ReleasedProcess[] = [];
  for (const entry of state.adopted) {
    if (
      entry.scopeKey === scopeKey &&
      !entry.stopping &&
      (await isSameLiveProcess(entry)) !== false &&
      !entry.stopping &&
      state.adopted.delete(entry)
    ) {
      handedOff.push(
        entry.command === undefined
          ? { pid: entry.pid }
          : { pid: entry.pid, command: entry.command },
      );
    }
  }
  clearIdleReaper();
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
