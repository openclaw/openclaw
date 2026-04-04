import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGlobalCommandRunner } from "./shared.js";

const runCommandWithTimeout = vi.hoisted(() => vi.fn());

vi.mock("../../process/exec.js", () => ({
  runCommandWithTimeout,
}));

describe("createGlobalCommandRunner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runCommandWithTimeout.mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    });
  });

  it("forwards argv/options and maps exec result shape", async () => {
    runCommandWithTimeout.mockResolvedValueOnce({
      stdout: "out",
      stderr: "err",
      code: 17,
      signal: null,
      killed: false,
      termination: "exit",
    });
    const runCommand = createGlobalCommandRunner();

    const result = await runCommand(["npm", "root", "-g"], {
      timeoutMs: 1200,
      cwd: "/tmp/openclaw",
      env: { OPENCLAW_TEST: "1" },
    });

    expect(runCommandWithTimeout).toHaveBeenCalledWith(["npm", "root", "-g"], {
      timeoutMs: 1200,
      cwd: "/tmp/openclaw",
      env: { OPENCLAW_TEST: "1" },
    });
    expect(result).toEqual({
      stdout: "out",
      stderr: "err",
      code: 17,
    });
  });
});
