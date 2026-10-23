import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scriptPath = fileURLToPath(new URL("../../scripts/qa-lab-up.ts", import.meta.url));

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("../../extensions/qa-lab/src/cli.runtime.ts");
});

async function runCli(args: string[]) {
  const runQaDockerUpCommand = vi.fn(async () => {});
  const loadRuntime = vi.fn(() => ({ runQaDockerUpCommand }));
  vi.doMock("../../extensions/qa-lab/src/cli.runtime.ts", loadRuntime);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  try {
    process.argv = [process.execPath, scriptPath, ...args];
    process.exitCode = undefined;
    await import("../../scripts/qa-lab-up.js");
    return { code: process.exitCode, stdout, stderr, loadRuntime, runQaDockerUpCommand };
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
  }
}

describe("scripts/qa-lab-up", () => {
  it("prints help before loading the Docker runtime", async () => {
    const result = await runCli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.loadRuntime).not.toHaveBeenCalled();
    expect(result.stdout).toHaveBeenCalledWith(expect.stringContaining("Usage: pnpm qa:lab:up"));
  });

  it("accepts the pnpm run argument separator", async () => {
    const result = await runCli(["--", "--gateway-port", "4100"]);
    expect(result.code).toBe(0);
    expect(result.runQaDockerUpCommand).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayPort: 4100 }),
    );
  });

  it("accepts the maximum TCP port before loading the Docker runtime", async () => {
    const result = await runCli(["--gateway-port", "65535", "--qa-lab-port", "65535"]);
    expect(result.code).toBe(0);
    expect(result.loadRuntime).toHaveBeenCalledOnce();
    expect(result.runQaDockerUpCommand).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayPort: 65535, qaLabPort: 65535 }),
    );
  });

  it.each([
    [["--gateway-port", ""], "--gateway-port must be a positive integer."],
    [["--gateway-port", "1.5"], "--gateway-port must be a positive integer."],
    [["--gateway-port", "0x1000"], "--gateway-port must be a positive integer."],
    [["--gateway-port", "0"], "--gateway-port must be a positive integer."],
    [["--gateway-port", "65536"], "--gateway-port must be a TCP port from 1 to 65535."],
    [["--qa-lab-port", ""], "--qa-lab-port must be a positive integer."],
    [["--qa-lab-port", "1e4"], "--qa-lab-port must be a positive integer."],
    [["--qa-lab-port", "65536"], "--qa-lab-port must be a TCP port from 1 to 65535."],
  ])("rejects invalid TCP ports: %j", async (args, message) => {
    const result = await runCli(args);
    expect(result.code).toBe(1);
    expect(result.stderr).toHaveBeenCalledWith(`${message}\n`);
    expect(result.loadRuntime).not.toHaveBeenCalled();
  });
});
