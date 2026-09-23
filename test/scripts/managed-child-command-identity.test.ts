import type { ChildProcess } from "node:child_process";
import { expect, it } from "vitest";
import {
  getManagedChildCommandPid,
  runManagedCommand,
} from "../../scripts/lib/managed-child-process.mts";

it("identifies the actual command across direct and native Job launches", async ({ signal }) => {
  let owner: ChildProcess | undefined;
  let reportedPid = "";
  let consumerPid: number | undefined;
  const exit = await runManagedCommand({
    bin: process.execPath,
    args: ["-e", "process.stdout.write(String(process.pid))"],
    stdio: ["ignore", "pipe", "pipe"],
    signal,
    requireProcessTreeExit: process.platform !== "win32",
    onReady: (child) => {
      owner = child;
      if (process.platform === "win32") {
        // A native launcher has not admitted its command at this synchronous boundary.
        expect(getManagedChildCommandPid(child)).toBeUndefined();
      }
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        reportedPid += chunk;
      });
      child.stderr?.resume();
      child.once("exit", () => {
        consumerPid = getManagedChildCommandPid(child);
      });
    },
  });
  expect(exit).toBe(0);
  expect(Number(reportedPid)).toBeGreaterThan(1);
  expect(consumerPid).toBe(Number(reportedPid));
  if (process.platform === "win32") {
    expect(consumerPid).not.toBe(owner?.pid);
  } else {
    expect(consumerPid).toBe(owner?.pid);
  }
});

it.runIf(process.platform === "win32")(
  "does not credit a launcher when its command fails to spawn",
  async ({ signal }) => {
    let owner: ChildProcess | undefined;
    await expect(
      runManagedCommand({
        bin: "openclaw-test-nonexistent-command-137014.exe",
        stdio: ["ignore", "pipe", "pipe"],
        signal,
        onReady: (child) => {
          owner = child;
          child.stdout?.resume();
          child.stderr?.resume();
        },
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    if (!owner) {
      throw new Error("Failed command had no native launcher owner");
    }
    expect(owner.pid).toBeGreaterThan(1);
    expect(getManagedChildCommandPid(owner)).toBeUndefined();
  },
);
