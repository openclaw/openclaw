import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { probeScheduledTaskState } from "./schtasks-state-probe.js";

it.skipIf(process.platform !== "win32")(
  "reads real Windows PowerShell task presence without an unknown result",
  () => {
    const taskName = `OpenClaw probe test ${randomUUID()}`;
    const missing = probeScheduledTaskState(taskName);
    console.log("Unregistered task probe:", missing);
    expect(missing).toEqual({ status: "missing" });

    const created = spawnSync(
      "schtasks.exe",
      ["/Create", "/TN", taskName, "/SC", "ONSTART", "/TR", "cmd.exe /c exit 0"],
      { encoding: "utf8", windowsHide: true, timeout: 5_000 },
    );
    expect(created.error).toBeUndefined();
    if (created.status !== 0) {
      console.log("Task registration unavailable; verified the missing-task contract.");
      return;
    }
    try {
      const found = probeScheduledTaskState(taskName);
      console.log("Registered task probe:", found);
      expect(found).toMatchObject({ status: "found", state: 3, enabled: true });
    } finally {
      const removed = spawnSync("schtasks.exe", ["/Delete", "/TN", taskName, "/F"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5_000,
      });
      expect(removed.error).toBeUndefined();
      expect(removed.status, removed.stderr || removed.stdout).toBe(0);
    }
  },
  30_000,
);
