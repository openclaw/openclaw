import { PassThrough } from "node:stream";
import { beforeEach, expect, it, vi } from "vitest";
import { startLaunchAgent } from "./launchd-lifecycle.js";

const native = vi.hoisted(() => ({
  retired: false,
  retireDuringPreparation: true,
  retireAfterKickstart: false,
  missingJob: false,
  commands: [] as string[][],
}));
vi.mock("./launchd-system.js", () => ({
  assertNoSystemLaunchDaemonOwnership: async () => {
    await Promise.resolve();
    native.retired = native.retireDuringPreparation;
  },
  isSystemLaunchDaemonOwnershipError: () => false,
}));
vi.mock("./exec-file.js", () => ({
  execFileUtf8: async (
    _command: string,
    args: string[],
    options?: { beforeEffect?: () => void },
  ) => {
    options?.beforeEffect?.();
    native.commands.push(args);
    if (args[0] === "kickstart" && native.retireAfterKickstart) {
      native.retired = true;
    }
    const missing = native.missingJob && (args[0] === "kickstart" || args[0] === "print");
    return {
      code: missing ? 3 : 0,
      stdout: "",
      stderr: missing ? "No such process" : "",
      termination: "exit",
    };
  },
}));
beforeEach(() => {
  native.retired = false;
  native.retireDuringPreparation = true;
  native.retireAfterKickstart = false;
  native.missingJob = false;
  native.commands.length = 0;
});

function start() {
  return startLaunchAgent({
    env: { HOME: "/Users/test" },
    stdout: new PassThrough(),
    beforeEffect: () => {
      if (native.retired) {
        throw new Error("stop intent retired");
      }
    },
  });
}

it("rechecks start authority after awaited launchd preparation before native dispatch", async () => {
  await expect(start()).rejects.toThrow("stop intent retired");
  expect(native.commands).toEqual([]);
});

it("rechecks start authority before restoring a missing launchd job", async () => {
  native.retireDuringPreparation = false;
  native.retireAfterKickstart = true;
  native.missingJob = true;
  await expect(start()).rejects.toThrow("stop intent retired");
  expect(native.commands.some((args) => args[0] === "bootstrap")).toBe(false);
  expect(native.commands.filter((args) => args[0] === "kickstart")).toHaveLength(1);
});

it("does not recheck effect-only authority after successful launchd startup", async () => {
  native.retireDuringPreparation = false;
  native.retireAfterKickstart = true;
  await expect(start()).resolves.toBeUndefined();
  expect(native.retired).toBe(true);
});
