import { ChildProcess } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { spawnWindowsJobChild } from "../../scripts/lib/managed-windows-job.mts";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), limits: vi.fn((..._args: unknown[]) => true) }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
vi.mock("node:module", () => ({
  createRequire: () => () => ({}),
}));
vi.mock("../../src/process/supervisor/service-child-windows-job-native.ts", () => ({
  createWindowsJobBindings: () => ({
    assertLayouts: () => {},
    CreateJobObjectW: () => 1n,
    requireHandle: (value: bigint) => value,
    SetExtendedLimits: mocks.limits,
    extendedLimits: { BasicLimitInformation: { LimitFlags: 0x2000 }, JobMemoryLimit: 0 },
    extendedLimitsSize: 144,
    CloseHandle: () => true,
  }),
}));
afterEach(() => {
  vi.restoreAllMocks();
  mocks.spawn.mockClear();
  mocks.limits.mockClear();
});

it("snapshots command inputs before admission and excludes every NODE_OPTIONS casing from the launcher", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const child = new ChildProcess();
  const send = (child.send = vi.fn(() => true));
  mocks.spawn.mockReturnValue(child);
  const args = ["original"];
  const env = {
    NODE_OPTIONS: "--require=uppercase",
    Node_Options: "--require=mixed",
    VALUE: "original",
  };
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    const owned = spawnWindowsJobChild("fixture", args, { env, stdio: "pipe" });
    args[0] = "mutated";
    env.VALUE = "mutated";
    child.emit("message", { job: mocks.spawn.mock.calls[0]?.[1][1], type: "ready" });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "fixture",
        args: ["original"],
        options: expect.objectContaining({
          env: {
            NODE_OPTIONS: "--require=uppercase",
            Node_Options: "--require=mixed",
            VALUE: "original",
          },
        }),
      }),
      expect.any(Function),
    );
    expect(mocks.spawn.mock.calls[0]?.[2].env).toEqual({ VALUE: "original" });
    owned?.job.close();
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

it("sets an aggregate Job memory limit before admission without contaminating later Jobs", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  mocks.spawn.mockImplementation(() => new ChildProcess());
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    const bounded = spawnWindowsJobChild("fixture", [], {}, undefined, 256 * 1024 ** 2);
    const unbounded = spawnWindowsJobChild("fixture", [], {});
    expect(mocks.limits.mock.calls[0]?.[2]).toMatchObject({
      BasicLimitInformation: { LimitFlags: 0x2200 },
      JobMemoryLimit: 268435456,
    });
    expect(mocks.limits.mock.calls[1]?.[2]).toMatchObject({
      BasicLimitInformation: { LimitFlags: 0x2000 },
      JobMemoryLimit: 0,
    });
    expect(mocks.limits.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.spawn.mock.invocationCallOrder[0]!,
    );
    bounded?.job.close();
    unbounded?.job.close();
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});
