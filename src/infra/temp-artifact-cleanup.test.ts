import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import * as processCensus from "./openclaw-process-census.js";
import { maintainRetainedUpdateRuntimes } from "./temp-artifact-cleanup.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("reclaims a runtime by its recorded creator from another installation on a busy host", async () => {
  const base = await fs.realpath(tempDirs.make("openclaw-retained-owner-"));
  vi.spyOn(os, "tmpdir").mockReturnValue(base);
  // Other OpenClaw processes always run here; none names a runtime.
  const census = vi.spyOn(processCensus, "inspectOtherOpenClawProcesses").mockImplementation(((
    _directory: string,
    options?: { creatorExited: boolean },
  ) => ({
    pids: options?.creatorExited ? [] : [4242],
  })) as typeof processCensus.inspectOtherOpenClawProcesses);
  const pidNamespace = process.platform === "linux" ? await fs.readlink("/proc/self/ns/pid") : null;
  const creator = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  try {
    await once(creator, "spawn");
    const pid = creator.pid!;
    const runtimes = {
      Owned1: { name: "openclaw", pid, startTime: getFileLockProcessStartTime(pid), pidNamespace },
      Reused: { name: "openclaw", pid, startTime: 1, pidNamespace },
      Other1: { name: "openclaw", pid, startTime: 1, pidNamespace: "pid:[1]" },
      Legacy: undefined,
    };
    const directory = (name: string) => path.join(base, `openclaw-update-runtime-${name}`);
    for (const [name, owner] of Object.entries(runtimes)) {
      await fs.mkdir(directory(name));
      if (owner) {
        await fs.writeFile(path.join(directory(name), "owner.json"), JSON.stringify(owner));
      }
    }
    const maintain = () =>
      maintainRetainedUpdateRuntimes({
        packageRoots: [path.join(base, "another-installation/openclaw")],
        repair: true,
        assertCurrent() {},
      });
    const busy = "other OpenClaw processes are still running (PIDs: 4242)";
    expect((await maintain()).toSorted()).toEqual([
      `Removed abandoned updater runtime: ${directory("Reused")}`,
      `Runtime retained at ${directory("Legacy")}: it does not match a runtime an OpenClaw updater created, so it is kept`,
      expect.stringContaining(`${directory("Other1")}: ${busy}`),
      `Runtime retained at ${directory("Owned1")}: the creating update (PID ${pid}) is still running`,
    ]);
    expect(census).toHaveBeenCalledTimes(2);
    expect(census).toHaveBeenCalledWith(directory("Other1"), { creatorExited: false });
    expect(census).toHaveBeenCalledWith(directory("Reused"), { creatorExited: true });
    creator.kill("SIGKILL");
    await once(creator, "exit");
    expect(await maintain()).toContain(`Removed abandoned updater runtime: ${directory("Owned1")}`);
    expect(new Set(await fs.readdir(base))).toEqual(
      new Set(["openclaw-update-runtime-Legacy", "openclaw-update-runtime-Other1"]),
    );
  } finally {
    creator.kill("SIGKILL");
  }
});

it.runIf(process.platform === "linux")(
  "reclaims the runtime of an exited updater that its parent has not reaped",
  async () => {
    const base = await fs.realpath(tempDirs.make("openclaw-retained-zombie-"));
    vi.spyOn(os, "tmpdir").mockReturnValue(base);
    vi.spyOn(processCensus, "inspectOtherOpenClawProcesses").mockReturnValue({ pids: [] });
    // The shell's child exits; the process that replaced the shell never waits for it.
    const parent = spawn("sh", ["-c", "sleep 0.1 & echo $!; exec sleep 60"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    try {
      const [output] = await once(parent.stdout, "data");
      const pid = Number(String(output).trim());
      await vi.waitFor(async () =>
        expect(await fs.readFile(`/proc/${pid}/status`, "utf8")).toMatch(/^State:\s+Z/m),
      );
      const directory = path.join(base, "openclaw-update-runtime-Zombie");
      await fs.mkdir(directory);
      const startTime = getFileLockProcessStartTime(pid);
      expect(startTime).not.toBeNull();
      await fs.writeFile(
        path.join(directory, "owner.json"),
        JSON.stringify({
          name: "openclaw",
          pid,
          startTime,
          pidNamespace: await fs.readlink("/proc/self/ns/pid"),
        }),
      );
      expect(
        await maintainRetainedUpdateRuntimes({
          packageRoots: [path.join(base, "installation/openclaw")],
          repair: true,
          assertCurrent() {},
        }),
      ).toEqual([`Removed abandoned updater runtime: ${directory}`]);
    } finally {
      parent.kill("SIGKILL");
    }
  },
);
