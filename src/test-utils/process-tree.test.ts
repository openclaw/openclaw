// Tests race-safe process cleanup helpers.
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { killPidIfAlive } from "./process-tree.js";

describe.each(["linux", "darwin"] as const)("killPidIfAlive (%s)", (platform) => {
  beforeEach(() => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const readFileSync = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
      // Keep the fake live PID's procfs state consistent with its existence probe.
      if (String(args[0]) === "/proc/123/status") {
        return "State:\tS (sleeping)\nThreads:\t1\n";
      }
      return readFileSync(...args);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ignores ESRCH when a live process exits before SIGKILL", () => {
    const killError = Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    const kill = vi
      .spyOn(process, "kill")
      .mockReturnValue(true)
      .mockReturnValueOnce(true)
      .mockImplementationOnce(() => {
        throw killError;
      });

    expect(() => killPidIfAlive(123)).not.toThrow();
    expect(kill).toHaveBeenNthCalledWith(1, 123, 0);
    expect(kill).toHaveBeenNthCalledWith(2, 123, "SIGKILL");
  });

  it("rethrows other SIGKILL failures", () => {
    const killError = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    vi.spyOn(process, "kill")
      .mockReturnValue(true)
      .mockReturnValueOnce(true)
      .mockImplementationOnce(() => {
        throw killError;
      });

    expect(() => killPidIfAlive(123)).toThrow(killError);
  });
});
