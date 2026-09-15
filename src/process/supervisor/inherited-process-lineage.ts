export const INHERITED_PROCESS_LINEAGE_FD_ENV = "OPENCLAW_WORKER_LINEAGE_FDS";

let currentFds: number[] | undefined;

export function getInheritedProcessLineageFds(): readonly number[] {
  return currentFds ?? [];
}

export function consumeInheritedProcessLineageFd(): (() => void) | undefined {
  const raw = process.env[INHERITED_PROCESS_LINEAGE_FD_ENV];
  delete process.env[INHERITED_PROCESS_LINEAGE_FD_ENV];
  if (raw === undefined) {
    return undefined;
  }
  const fds = raw.split(",").map(Number);
  if (!/^[0-9]+(?:,[0-9]+)*$/.test(raw) || fds.some((fd) => !Number.isSafeInteger(fd) || fd < 3)) {
    throw new Error("worker process lineage descriptor is invalid");
  }
  currentFds = fds;
  return () => {
    if (currentFds === fds) {
      currentFds = undefined;
    }
  };
}
