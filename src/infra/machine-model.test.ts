import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { spawn, read } = vi.hoisted(() => ({
  spawn: vi.fn<typeof import("node:child_process").spawnSync>(),
  read: vi.fn<(file: string, encoding: "utf-8") => string>(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: spawn,
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  readFileSync: read,
}));

let resolveMachineModelIdentifier: typeof import("./machine-model.js").resolveMachineModelIdentifier;

beforeEach(async () => {
  vi.resetModules();
  ({ resolveMachineModelIdentifier } = await import("./machine-model.js"));
  spawn.mockReset();
  read.mockReset();
});

afterEach(() => vi.restoreAllMocks());

const dmi = "/sys/devices/virtual/dmi/id/product_name";
const deviceTree = "/proc/device-tree/model";
it.each([
  ["darwin", "success", " Mac16,1\n", null, "Mac16,1"],
  ["darwin", "timeout", "", null, undefined],
  ["linux", "DMI", " Test Laptop \n", "Other model", "Test Laptop"],
  ["linux", "missing DMI", null, " Test Board\0\0", "Test Board"],
  ["linux", "empty DMI", " \n", "Test Board\0\n", "Test Board"],
  ["linux", "missing files", null, null, undefined],
  ["linux", "empty files", "\0", " \0\0", undefined],
  ["linux", "bounded DMI", "x".repeat(80), null, "x".repeat(64)],
  ["linux", "bounded tree", null, "x".repeat(63) + "🚀", "x".repeat(63)],
  ["win32", "unsupported", null, null, undefined],
] as const)("resolves %s %s", (platform, name, product, tree, expected) => {
  vi.spyOn(os, "platform").mockReturnValue(platform);
  spawn.mockReturnValue({
    stdout: product ?? "",
    stderr: "",
    pid: 1,
    output: [],
    status: name === "timeout" ? null : 0,
    signal: name === "timeout" ? "SIGKILL" : null,
    ...(name === "timeout" ? { error: new Error("spawnSync sysctl ETIMEDOUT") } : {}),
  });

  const files = new Map([
    [dmi, product],
    [deviceTree, tree],
  ]);
  read.mockImplementation((file) => {
    const value = files.get(file);
    if (value == null) {
      throw new Error("ENOENT");
    }
    return value;
  });

  expect(resolveMachineModelIdentifier()).toBe(expected);
  if (platform === "darwin") {
    expect(spawn).toHaveBeenCalledExactlyOnceWith("sysctl", ["-n", "hw.model"], {
      encoding: "utf-8",
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
  } else {
    expect(spawn).not.toHaveBeenCalled();
  }
  if (platform === "linux") {
    expect(read).toHaveBeenNthCalledWith(1, dmi, "utf-8");
  } else {
    expect(read).not.toHaveBeenCalled();
  }
  const probes = [spawn.mock.calls.length, read.mock.calls.length];
  read.mockReturnValue("Changed Laptop");
  expect(resolveMachineModelIdentifier(platform)).toBe(expected);
  expect([spawn.mock.calls.length, read.mock.calls.length]).toEqual(probes);
});
