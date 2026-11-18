import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { adoptReleasedProcess } from "./released-processes.js";

const groups: number[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const pgid of groups.splice(0)) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

it.runIf(process.platform !== "win32")(
  "a group stop gives a child that outlives the survivor the rest of the grace",
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "group-grace-"));
    const marker = path.join(dir, "flushed");
    // The survivor exits on SIGTERM at once; its child needs a second to finish its writes.
    const child = `trap 'sleep 1; echo flushed > "${marker}"; exit 0' TERM; while :; do sleep 0.1; done`;
    const survivor = spawn(
      "sh",
      ["-c", `sh -c '${child.replaceAll("'", "'\\''")}' & exec sleep 60`],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    const pid = survivor.pid!;
    groups.push(pid);
    await delay(300);
    const adopted = adoptReleasedProcess("group-grace", { pid, pgid: pid }, () => {});

    expect(await adopted!.stop({ group: true })).toEqual({ status: "stopped" });

    expect(fs.readFileSync(marker, "utf8").trim()).toBe("flushed");
    expect(() => process.kill(-pid, 0)).toThrow();
  },
  20_000,
);

it.runIf(process.platform !== "win32")(
  "a group stop is uncertain while a member it cannot signal remains",
  async () => {
    // The survivor exits on SIGTERM; its child keeps running, as one under another user would.
    const survivor = spawn("sh", ["-c", "sleep 60 & exec sleep 60"], {
      detached: true,
      stdio: "ignore",
    });
    const pid = survivor.pid!;
    groups.push(pid);
    await delay(300);
    const adopted = adoptReleasedProcess("group-denied", { pid, pgid: pid }, () => {});
    const realKill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((target, signal) => {
      if (target === -pid && signal !== "SIGTERM") {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      }
      return realKill(target, signal);
    });

    expect(await adopted!.stop({ group: true })).toMatchObject({ status: "uncertain" });
  },
  20_000,
);

it.runIf(process.platform !== "win32")(
  "a group stop is uncertain when SIGKILL ends the survivor but not its group",
  async () => {
    // Both ignore SIGTERM; the forced kill reaches only the survivor, as with a child under
    // another user.
    const survivor = spawn("sh", ["-c", "trap '' TERM; sleep 60 & exec sleep 60"], {
      detached: true,
      stdio: "ignore",
    });
    const pid = survivor.pid!;
    groups.push(pid);
    await delay(300);
    const onExit = vi.fn();
    const adopted = adoptReleasedProcess("group-kill-denied", { pid, pgid: pid }, onExit);
    const realKill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((target, signal) => {
      if (target === -pid && signal === "SIGKILL") {
        try {
          return realKill(pid, "SIGKILL");
        } catch {
          return true;
        }
      }
      return realKill(target, signal);
    });

    expect(await adopted!.stop({ group: true })).toMatchObject({ status: "uncertain" });
    // Custody holds while the group runs: the reaper does not settle it, and a retry stops it.
    await delay(6_000);
    expect(onExit).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(await adopted!.stop({ group: true })).toEqual({ status: "stopped" });
    expect(onExit).toHaveBeenCalledOnce();
    expect(() => process.kill(-pid, 0)).toThrow();
  },
  40_000,
);
