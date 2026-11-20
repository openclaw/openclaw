// Shared-teardown census: a hidden subagent whose task ended must hold no process.
// Reads both registries through their published test APIs, so it loads no module itself.

type CensusProcess = {
  scopeKey: string;
  command: string;
  startedAt: number;
  pid?: number;
  exited: boolean;
  durable?: unknown;
  cancellationRequested?: boolean;
};
type EndedTask = { scopes: Set<string>; endedAt: number };

/** Live, not durable, no stop requested, and owned by an ended hidden subagent: nothing ends it. */
export function findLeakedSubagentProcesses(): CensusProcess[] {
  const store = globalThis as Record<PropertyKey, unknown>;
  const processes = (
    store[Symbol.for("openclaw.bashProcessRegistryTestApi")] as
      | { listExecSessionsForCancellation?: () => CensusProcess[] }
      | undefined
  )?.listExecSessionsForCancellation?.();
  const tasks = (
    store[Symbol.for("openclaw.subagentRegistryTestApi")] as
      | { testing?: { endedSubagentTasksForTests?: () => EndedTask[] } }
      | undefined
  )?.testing?.endedSubagentTasksForTests?.();
  return (processes ?? []).filter(
    (session) =>
      !session.exited &&
      !session.durable &&
      !session.cancellationRequested &&
      tasks?.some((task) => task.scopes.has(session.scopeKey) && session.startedAt <= task.endedAt),
  );
}

/** Fail the file and kill what it leaked, so no process outlives it. */
export function stopLeakedSubagentProcesses(): void {
  const leaked = findLeakedSubagentProcesses();
  for (const { pid } of leaked) {
    try {
      if (pid) {
        process.kill(pid, "SIGKILL");
      }
    } catch {
      // Already gone.
    }
  }
  if (leaked.length > 0) {
    throw new Error(
      `An ended subagent still runs ${leaked.length} process(es): ${leaked
        .map(({ scopeKey, command }) => `${scopeKey}: ${command}`)
        .join("; ")}. Its task end must stop them.`,
    );
  }
}
