import path from "node:path";

type ProcessDescendantEntry = {
  pid: number;
  ppid?: number;
  command?: { ppid: number; argv?: readonly string[] } | { ppid: number };
};

/**
 * Collect this process's own re-exec (`openclaw`) and worker children plus
 * their descendants so Doctor does not treat its own helper processes as
 * external holders while preserving separate same-group CLI peers.
 */
export function collectSelfManagedDescendants(
  processes: readonly ProcessDescendantEntry[],
  selfPid: number,
): Set<number> {
  const childrenByParent = new Map<number, number[]>();
  const byPid = new Map<number, ProcessDescendantEntry>();
  for (const entry of processes) {
    byPid.set(entry.pid, entry);
    const parentPid = entry.command?.ppid ?? entry.ppid ?? 0;
    if (parentPid > 0 && entry.pid !== parentPid) {
      const siblings = childrenByParent.get(parentPid);
      if (siblings) {
        siblings.push(entry.pid);
      } else {
        childrenByParent.set(parentPid, [entry.pid]);
      }
    }
  }
  const isSelfManagedChild = (pid: number): boolean => {
    const entry = byPid.get(pid);
    const argv = entry?.command && "argv" in entry.command ? entry.command.argv : undefined;
    if (!argv?.length) {
      return false;
    }
    const head = path.basename(argv[0] ?? "").toLowerCase();
    return (
      head === "openclaw" ||
      argv.some((arg) => arg.endsWith(".worker.js") || arg.endsWith(".worker.ts"))
    );
  };
  const descendants = new Set<number>();
  const queue = (childrenByParent.get(selfPid) ?? []).filter(isSelfManagedChild);
  while (queue.length > 0) {
    const pid = queue.pop()!;
    if (pid === selfPid || descendants.has(pid)) {
      continue;
    }
    descendants.add(pid);
    for (const childPid of childrenByParent.get(pid) ?? []) {
      queue.push(childPid);
    }
  }
  return descendants;
}
