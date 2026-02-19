import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.hoisted(() => vi.fn());
const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: (...args: unknown[]) => loadConfigMock(...args),
  };
});

vi.mock("../../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

import { createPluginRuntime } from "./index.js";

describe("plugin runtime security hardening", () => {
  const blockedError =
    "runtime.system.runCommandWithTimeout is disabled for security hardening. Use fixed-purpose runtime APIs instead.";

  beforeEach(() => {
    loadConfigMock.mockReset();
    runCommandWithTimeoutMock.mockReset();
    loadConfigMock.mockReturnValue({});
  });

  it("blocks runtime.system.runCommandWithTimeout by default", async () => {
    const runtime = createPluginRuntime();
    await expect(
      runtime.system.runCommandWithTimeout(["echo", "hello"], { timeoutMs: 1000 }),
    ).rejects.toThrow(blockedError);
    expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("allows runtime.system.runCommandWithTimeout when explicitly opted in", async () => {
    loadConfigMock.mockReturnValue({
      plugins: {
        runtime: {
          allowLegacyExec: true,
        },
      },
    });
    const commandResult = {
      stdout: "hello\n",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit" as const,
    };
    runCommandWithTimeoutMock.mockResolvedValue(commandResult);

    const runtime = createPluginRuntime();
    await expect(
      runtime.system.runCommandWithTimeout(["echo", "hello"], { timeoutMs: 1000 }),
    ).resolves.toEqual(commandResult);
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(["echo", "hello"], { timeoutMs: 1000 });
  });

  it("fails closed when config loading throws", async () => {
    loadConfigMock.mockImplementation(() => {
      throw new Error("config read failed");
    });

    const runtime = createPluginRuntime();
    await expect(
      runtime.system.runCommandWithTimeout(["echo", "hello"], { timeoutMs: 1000 }),
    ).rejects.toThrow(blockedError);
    expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
  });
});
