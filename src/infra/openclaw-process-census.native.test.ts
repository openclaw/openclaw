import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { inspectOtherOpenClawProcesses } from "./openclaw-process-census.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const orphans = new Set<number>();
// Registered after the temp-dir tracker, so every holder exits before its directory goes.
afterEach(async () => {
  await Promise.all([...orphans].map(killTree));
  orphans.clear();
});

/** Signal a fixture and every descendant, then wait until none remains. */
async function killTree(root: number) {
  const tree = [root];
  // The array iterator also visits descendants appended while walking.
  for (const pid of tree) {
    tree.push(...childPids(pid));
  }
  for (const pid of tree) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already exited.
    }
  }
  await waitFor(() => tree.every((pid) => !readCommand(pid)));
}

// Rosetta cannot inspect native Darwin arguments; that refusal has its own unit contract.
const translated = process.arch === "x64" && os.cpus()[0]?.model.includes("Apple");
const native = process.platform === "darwin" && !translated;

/** Start work outside this process tree, as a crashed updater leaves it under launchd. */
async function startOrphan(
  cwd: string,
  command: string,
  script: string,
  ...args: string[]
): Promise<number> {
  const launcher = spawnSync(
    "/bin/sh",
    ["-c", '/bin/sh -c "$0" "$@" </dev/null >/dev/null 2>&1 & echo $!', script, ...args],
    { cwd, encoding: "utf8" },
  );
  const pid = Number(launcher.stdout.trim());
  expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
  orphans.add(pid);
  // The census refuses a process that is still between fork and exec.
  await waitFor(() => readCommand(pid) === command);
  return pid;
}

async function waitFor(ready: () => boolean) {
  for (let attempt = 0; attempt < 250 && !ready(); attempt++) {
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  expect(ready()).toBe(true);
}

function readCommand(pid: number): string {
  const result = spawnSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  return result.stdout.trim();
}

function hasChild(pid: number): boolean {
  return childPids(pid).length > 0;
}

it.runIf(native)("finds a real non-Node process holding retained handoff paths", async () => {
  const retained = fs.realpathSync(dirs.make("handoff-census-"));
  // Ordinary system binaries can carry argument images whose environment
  // the inspector cannot bound; repair matching must still complete.
  const holder = await startOrphan(retained, "/bin/sleep 60", "exec /bin/sleep 60");
  const holding = inspectOtherOpenClawProcesses({
    runId: "census-native-run",
    artifactPaths: [retained],
  });
  expect(holding.error).toBeUndefined();
  expect(holding.matchingPids).toContain(holder);
  // Other OpenClaw processes on the host also match by identity, and host
  // processes the census cannot read are environment-specific; this
  // control proves only that the holder is matched by its reference.
  const unrelated = inspectOtherOpenClawProcesses({
    runId: "census-native-unrelated",
    artifactPaths: [`${retained}-unrelated`],
  });
  expect(unrelated.error).toBeUndefined();
  expect(unrelated.matchingPids).not.toContain(holder);
});

it.runIf(native)("does not report the inspector's own child processes", async () => {
  const retained = fs.realpathSync(dirs.make("handoff-census-self-"));
  // A shell keeps its sleep child, so this covers a grandchild as well.
  const child = spawn("/bin/sh", ["-c", "/bin/sleep 60; :"], { cwd: retained, stdio: "ignore" });
  const closed = once(child, "close");
  try {
    await once(child, "spawn");
    const orphan = await startOrphan(retained, "/bin/sleep 60", "exec /bin/sleep 60");
    await waitFor(() => hasChild(child.pid!));
    const grandchildren = childPids(child.pid!);
    expect(grandchildren).toHaveLength(1);
    const observed = inspectOtherOpenClawProcesses({
      runId: "census-native-self",
      artifactPaths: [retained],
    });
    expect(observed.error).toBeUndefined();
    expect(observed.matchingPids).toContain(orphan);
    expect(observed.matchingPids).not.toContain(child.pid);
    expect(observed.matchingPids).not.toContain(grandchildren[0]);
    expect(observed.unverifiedPids).not.toContain(child.pid);
  } finally {
    await killTree(child.pid!);
    await closed;
  }
});

it.runIf(native)(
  "reports only shared-root holders that may have started before the family deadline",
  async () => {
    const root = fs.realpathSync(dirs.make("handoff-census-root-"));
    const runId = "census-native-deadline-run";
    const deadline = Date.now() - 60_000;
    // The shell names the run; its sleep child only runs from the installation root.
    const runHolder = await startOrphan(
      root,
      `/bin/sh -c /bin/sleep 60; : ${runId}`,
      "/bin/sleep 60; :",
      runId,
    );
    const rootHolder = await startOrphan(root, "/bin/sleep 60", "exec /bin/sleep 60");
    await waitFor(() => hasChild(runHolder));
    const references = { runId, artifactPaths: [root], sharedRoots: [root] };

    const settled = inspectOtherOpenClawProcesses({ ...references, familyDeadline: deadline });
    expect(settled.error).toBeUndefined();
    expect(settled.matchingPids).toContain(runHolder);
    expect(settled.matchingPids).not.toContain(rootHolder);

    const recent = inspectOtherOpenClawProcesses({
      ...references,
      familyDeadline: Date.now() + 60_000,
    });
    expect(recent.matchingPids).toEqual(expect.arrayContaining([runHolder, rootHolder]));
    // Without a recorded family deadline every root holder keeps blocking repair.
    expect(inspectOtherOpenClawProcesses(references).matchingPids).toContain(rootHolder);
  },
);

function childPids(pid: number): number[] {
  const result = spawnSync("/usr/bin/pgrep", ["-P", String(pid)], { encoding: "utf8" });
  return result.stdout.split(/\s+/u).filter(Boolean).map(Number);
}
