import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { runRespawnedChild } from "../openclaw-respawn.mjs";

describe("runRespawnedChild", () => {
  it("exits with the child status", () => {
    const child = new EventEmitter() as ChildProcess;
    const spawn = vi.fn(() => child);
    const exit = vi.fn();

    runRespawnedChild({
      command: "/usr/bin/node",
      args: ["entry.js"],
      env: {},
      spawn: spawn as unknown as typeof import("node:child_process").spawn,
      exit: exit as unknown as (code?: number) => never,
      signals: ["SIGTERM"],
    });

    expect(spawn).toHaveBeenCalledWith("/usr/bin/node", ["entry.js"], {
      stdio: "inherit",
      env: {},
    });

    child.emit("exit", 0, null);

    expect(exit).toHaveBeenCalledWith(0);
  });

  it("marks signal-terminated children as failed without forcing another exit", () => {
    const child = new EventEmitter() as ChildProcess;
    const spawn = vi.fn(() => child);
    const exit = vi.fn();

    runRespawnedChild({
      command: "/usr/bin/node",
      args: ["entry.js"],
      spawn: spawn as unknown as typeof import("node:child_process").spawn,
      exit: exit as unknown as (code?: number) => never,
      signals: ["SIGTERM"],
    });

    child.emit("exit", null, "SIGTERM");

    expect(exit).toHaveBeenCalledWith(1);
  });

  it("escalates from forwarded signal to SIGTERM and then SIGKILL when the child does not exit", () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as ChildProcess;
    const kill = vi.fn<(signal?: NodeJS.Signals) => boolean>(() => true);
    child.kill = kill as ChildProcess["kill"];
    const spawn = vi.fn(() => child);
    const exit = vi.fn();

    try {
      runRespawnedChild({
        command: "/usr/bin/node",
        args: ["entry.js"],
        spawn: spawn as unknown as typeof import("node:child_process").spawn,
        exit: exit as unknown as (code?: number) => never,
        platform: "darwin",
        signals: ["SIGINT"],
        signalExitGraceMs: 1_000,
        signalForceKillGraceMs: 1_000,
      });

      process.emit("SIGINT");
      expect(kill).toHaveBeenCalledWith("SIGINT");

      vi.advanceTimersByTime(1_000);
      expect(kill).toHaveBeenCalledWith("SIGTERM");
      expect(exit).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1_000);
      expect(kill).toHaveBeenCalledWith("SIGKILL");
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      child.emit("exit", 1, null);
      vi.useRealTimers();
    }
  });
});
