import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { childPidsFromProcStat } from "./linux-child-subreaper.js";

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("condition did not settle within the deadline");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
}

it.skipIf(process.platform !== "linux")(
  "enumerates a real spawned child by parent id from /proc stat files",
  async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
      stdio: "ignore",
    });
    const pid = child.pid;
    if (pid === undefined) {
      throw new Error("the probe child never started");
    }
    try {
      await until(() => childPidsFromProcStat().includes(pid));
      expect(childPidsFromProcStat()).toContain(pid);
    } finally {
      child.kill();
      await once(child, "close");
    }
    await until(() => !childPidsFromProcStat().includes(pid));
  },
);
