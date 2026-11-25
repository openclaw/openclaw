// Real-behavior driver for the Linux child subreaper owner. It runs as a
// plain-node process, esbuild-bundled by linux-child-subreaper.e2e.real.test.ts,
// inside an isolated user+mount namespace whose /proc/<pid>/task is shadowed
// by an empty tmpfs. Per-thread children files are then genuinely absent,
// which is the exact enumeration surface a kernel built without
// CONFIG_PROC_CHILDREN presents to the shipped owner.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLinuxChildSubreaper } from "./linux-child-subreaper.js";

const log = (message: string): void => {
  console.log("E2E-DRIVER " + message);
};

const delay = (milliseconds: number): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
};

/** Field 4 of a stat line, after the comm field so comm spaces cannot shift it. */
function statParentAndState(pid: number): { ppid: number; state: string } {
  const line = readFileSync("/proc/" + String(pid) + "/stat", "utf8");
  const fields = line.slice(line.lastIndexOf(")") + 2).split(" ");
  return { ppid: Number(fields[1]), state: fields[0] ?? "?" };
}

async function main(): Promise<void> {
  const taskEntries = readdirSync("/proc/self/task");
  log(
    "per-thread children files: " +
      (taskEntries.length === 0 ? "absent" : "present (" + taskEntries.join(", ") + ")"),
  );
  if (taskEntries.length !== 0) {
    throw new Error("children files are still readable; the tmpfs shadow did not take effect");
  }

  const owner = acquireLinuxChildSubreaper();
  log("owner acquired: adoption enabled and childless admission passed with children files absent");

  const scratchDirectory = mkdtempSync(join(tmpdir(), "subreaper-e2e-"));
  const orphanPidFile = join(scratchDirectory, "orphan.pid");
  const root = spawn("sh", ["-c", "sleep 30 & echo $! > " + orphanPidFile + "; exec sleep 0.2"], {
    stdio: "ignore",
  });
  if (root.pid === undefined) {
    throw new Error("the application root never started");
  }
  owner.retainSpawnedChild(root.pid, root);
  const [rootExitCode] = (await once(root, "exit")) as [number | null, unknown];
  log(
    "application root exited with code " +
      String(rootExitCode) +
      " (runtime-reaped: the spawned result stays observable)",
  );

  const orphanPid = Number(readFileSync(orphanPidFile, "utf8").trim());
  const deadline = Date.now() + 5_000;
  let discovered = false;
  while (Date.now() < deadline) {
    if (owner.children().includes(orphanPid)) {
      discovered = true;
      break;
    }
    await delay(20);
  }
  if (!discovered) {
    const kernel = statParentAndState(orphanPid);
    log(
      "FAIL: owner.children() stayed empty while orphan " +
        String(orphanPid) +
        " is adopted in the kernel (stat ppid " +
        String(kernel.ppid) +
        ", state " +
        kernel.state +
        ") — enumeration silently under-reports",
    );
    log("strict cleanup drain(): " + String(owner.drain("SIGKILL")));
    try {
      process.kill(orphanPid, "SIGKILL");
    } catch {
      // The orphan may have exited on its own already.
    }
    throw new Error("adopted orphan never discovered; strict cleanup cannot complete");
  }
  log(
    "adopted orphan " +
      String(orphanPid) +
      " discovered by owner enumeration with children files absent",
  );

  const signalDrain = owner.drain("SIGTERM");
  log("drain(SIGTERM) on the running adopted orphan returned " + String(signalDrain));
  // Elapsed time is not exit evidence on a loaded runner: keep observing the
  // owner until strict cleanup completes or the deadline expires.
  const cleanupDeadline = Date.now() + 5_000;
  let cleanupDrain = false;
  while (Date.now() < cleanupDeadline) {
    cleanupDrain = owner.drain();
    if (cleanupDrain) {
      break;
    }
    await delay(20);
  }
  log("drain() after orphan exit returned " + String(cleanupDrain));
  if (!cleanupDrain) {
    throw new Error("strict cleanup did not complete (ECHILD extinction not reached)");
  }
  const zombieRetained = existsSync("/proc/" + String(orphanPid) + "/stat");
  log(
    "adopted orphan stat entry after cleanup: " +
      (zombieRetained ? "retained (leak)" : "gone (natively reaped)"),
  );
  if (zombieRetained) {
    throw new Error("the adopted orphan is still visible in /proc after strict cleanup");
  }
  rmSync(scratchDirectory, { recursive: true, force: true });
  log(
    "PASS: adoption, owner enumeration, signaling, native reaping, and completed strict cleanup all observed with children files absent",
  );
}

main().catch((error: unknown) => {
  console.error("E2E-DRIVER FAIL: " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
