import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { assertInitialTailBound, withOwnedFollowChild } from "./remote-log-tailing-runtime.js";

describe("remote log tailing scenario", () => {
  it("stops and awaits the follow child when the owned operation fails", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    await once(child, "spawn");

    await expect(
      withOwnedFollowChild(child, async () => {
        throw new Error("forced follow failure");
      }),
    ).rejects.toThrow("forced follow failure");

    expect(child.signalCode).not.toBeNull();
  });

  it("accepts a bounded initial tail when concurrent gateway logs replace fixture markers", () => {
    expect(() =>
      assertInitialTailBound({
        lines: ["background cron log", "background websocket log"],
        truncated: true,
      }),
    ).not.toThrow();
  });

  it("rejects an initial tail that exceeds the requested bound", () => {
    expect(() =>
      assertInitialTailBound({
        lines: ["one", "two", "three"],
        truncated: true,
      }),
    ).toThrow("logs.tail did not honor limit");
  });
});
