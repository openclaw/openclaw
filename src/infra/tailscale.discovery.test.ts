import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const runExecMock = vi.hoisted(() => vi.fn());
vi.mock("../process/exec.js", () => ({ runExec: runExecMock }));

import { findTailscaleBinary } from "./tailscale.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.unstubAllEnvs();
  runExecMock.mockReset();
});

describe("findTailscaleBinary", () => {
  it("finds the PATH executable without spawning which and keeps CLI validation", async () => {
    const root = tempDirs.make("openclaw-tailscale-discovery-");
    const binary = path.join(root, "tailscale");
    fs.writeFileSync(binary, "", { mode: 0o755 });
    vi.stubEnv("PATH", root);
    runExecMock.mockImplementation(async (command: string, args: string[]) => {
      if (command === "which") {
        return { stdout: `${binary}\n`, stderr: "" };
      }
      if (command === binary && args[0] === "version") {
        return { stdout: "1.94.0\n", stderr: "" };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    await expect(findTailscaleBinary()).resolves.toBe(binary);
    expect(runExecMock).toHaveBeenCalledExactlyOnceWith(binary, ["version"], { timeoutMs: 3000 });
  });

  it("rejects a PATH candidate whose version command fails", async () => {
    const root = tempDirs.make("openclaw-tailscale-invalid-");
    const binary = path.join(root, "tailscale");
    fs.writeFileSync(binary, "", { mode: 0o755 });
    vi.stubEnv("PATH", root);
    runExecMock.mockImplementation(async (command: string) => {
      if (command === "locate") {
        return { stdout: "", stderr: "" };
      }
      throw new Error("CLI cannot run");
    });

    await expect(findTailscaleBinary()).resolves.toBeNull();
    expect(runExecMock).toHaveBeenCalledWith(binary, ["version"], { timeoutMs: 3000 });
    expect(runExecMock.mock.calls.some(([command]) => command === "which")).toBe(false);
  });
});
