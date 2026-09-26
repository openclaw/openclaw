import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS } from "../infra/windows-powershell-spawn.js";
import { probeScheduledTaskState } from "./schtasks-state-probe.js";

const SCHTASKS_COMMAND_TIMEOUT_MS = 5_000;

it.skipIf(process.platform !== "win32")(
  "reads real Windows PowerShell task presence without an unknown result",
  () => {
    const taskName = `OpenClaw probe test ${randomUUID()}`;
    // Prove native task-state semantics; the unit matrix covers the production 5s budget.
    const missing = probeScheduledTaskState(taskName, WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS);
    console.log("Unregistered task probe:", missing);
    expect(missing).toEqual({ status: "missing" });

    const created = spawnSync(
      "schtasks.exe",
      ["/Create", "/TN", taskName, "/SC", "ONSTART", "/TR", "cmd.exe /c exit 0"],
      { encoding: "utf8", windowsHide: true, timeout: SCHTASKS_COMMAND_TIMEOUT_MS },
    );
    expect(created.error).toBeUndefined();
    if (created.status !== 0) {
      console.log("Task registration unavailable; verified the missing-task contract.");
      return;
    }
    try {
      const found = probeScheduledTaskState(taskName, WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS);
      console.log("Registered task probe:", found);
      expect(found).toMatchObject({ status: "found", state: 3, enabled: true });
    } finally {
      const removed = spawnSync("schtasks.exe", ["/Delete", "/TN", taskName, "/F"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: SCHTASKS_COMMAND_TIMEOUT_MS,
      });
      expect(removed.error).toBeUndefined();
      expect(removed.status, removed.stderr || removed.stdout).toBe(0);
    }
  },
  2 * WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS + 2 * SCHTASKS_COMMAND_TIMEOUT_MS + 10_000,
);
