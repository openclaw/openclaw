import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGlobalCommandRunner, resolveGlobalManager } from "./shared.js";

const runCommandWithTimeout = vi.hoisted(() => vi.fn());
const detectGlobalInstallManagerForRoot = vi.hoisted(() => vi.fn());
const detectGlobalInstallManagerByPresence = vi.hoisted(() => vi.fn());
const pathExists = vi.hoisted(() => vi.fn());

vi.mock("../../process/exec.js", () => ({
  runCommandWithTimeout,
}));

vi.mock("../../infra/update-global.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/update-global.js")>(
    "../../infra/update-global.js",
  );
  return {
    ...actual,
    detectGlobalInstallManagerForRoot,
    detectGlobalInstallManagerByPresence,
  };
});

vi.mock("../../utils.js", async () => {
  const actual = await vi.importActual<typeof import("../../utils.js")>("../../utils.js");
  return {
    ...actual,
    pathExists,
  };
});

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
    detectGlobalInstallManagerForRoot.mockResolvedValue(null);
    detectGlobalInstallManagerByPresence.mockResolvedValue("npm");
    pathExists.mockResolvedValue(false);
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

  it("falls back when the preferred package manager is not actually available", async () => {
    runCommandWithTimeout.mockResolvedValueOnce({
      stdout: "",
      stderr: "npm missing",
      code: 1,
      signal: null,
      killed: false,
      termination: "exit",
    });

    await expect(
      resolveGlobalManager({
        root: "/opt/openclaw",
        installKind: "package",
        timeoutMs: 1200,
        preferredManager: "npm",
      }),
    ).resolves.toBe("pnpm");

    expect(runCommandWithTimeout).toHaveBeenCalledWith(["npm", "root", "-g"], {
      timeoutMs: 1200,
    });
    expect(detectGlobalInstallManagerByPresence).toHaveBeenCalled();
  });

  it("keeps the preferred package manager when it resolves the installed package", async () => {
    runCommandWithTimeout.mockResolvedValueOnce({
      stdout: "/global/npm\n",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    });
    pathExists.mockResolvedValueOnce(true);

    await expect(
      resolveGlobalManager({
        root: "/opt/openclaw",
        installKind: "package",
        timeoutMs: 1200,
        preferredManager: "npm",
      }),
    ).resolves.toBe("npm");

    expect(pathExists).toHaveBeenCalledWith("/global/npm/openclaw");
    expect(detectGlobalInstallManagerByPresence).not.toHaveBeenCalled();
  });
});
