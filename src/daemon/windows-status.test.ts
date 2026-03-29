import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectWindowsGatewayStatus } from "./windows-status.js";

async function withTempHome(
  run: (env: NodeJS.ProcessEnv & { USERPROFILE: string; APPDATA: string }) => Promise<void>,
) {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-win-status-"));
  const appData = path.join(tempHome, "AppData", "Roaming");
  await fs.mkdir(appData, { recursive: true });
  try {
    await run({
      ...process.env,
      USERPROFILE: tempHome,
      APPDATA: appData,
    });
  } finally {
    await fs.rm(tempHome, { recursive: true, force: true });
  }
}

describe("collectWindowsGatewayStatus", () => {
  afterEach(() => {
    // no-op to keep test structure consistent if future state is added
  });

  it("reports startup-folder fallback and missing task script guidance", async () => {
    await withTempHome(async (env) => {
      const startupDir = path.join(
        env.APPDATA,
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
        "Startup",
      );
      await fs.mkdir(startupDir, { recursive: true });
      await fs.writeFile(path.join(startupDir, "OpenClaw Gateway.cmd"), "@echo off\r\n", "utf8");

      const summary = await collectWindowsGatewayStatus(env, {
        taskRegistered: false,
        runtimeStatus: "stopped",
        execFileImpl: async (_command, args) => {
          if (args[0] === "--status") {
            return { code: 0, stdout: "Default Distribution: Ubuntu-24.04\r\n", stderr: "" };
          }
          if (args[0] === "--list") {
            return {
              code: 0,
              stdout: "* Ubuntu-24.04           Running         2\r\n",
              stderr: "",
            };
          }
          if (args.includes("printf openclaw-wsl-ok")) {
            return { code: 0, stdout: "openclaw-wsl-ok", stderr: "" };
          }
          if (args.includes("grep -Eiq")) {
            return { code: 0, stdout: "disabled", stderr: "" };
          }
          return { code: 1, stdout: "", stderr: "unexpected" };
        },
      });

      expect(summary.serviceMode).toBe("startup-fallback");
      expect(summary.startupEntryInstalled).toBe(true);
      expect(summary.degradedReason).toContain("missing task script");
      expect(summary.wsl.wslExeAvailable).toBe(true);
      expect(summary.wsl.defaultDistroReachable).toBe(true);
      expect(summary.wsl.systemdEnabled).toBe(false);
    });
  });

  it("reports missing WSL2 with an actionable fix", async () => {
    await withTempHome(async (env) => {
      const summary = await collectWindowsGatewayStatus(env, {
        taskRegistered: true,
        runtimeStatus: "running",
        portListening: true,
        execFileImpl: async () => ({
          code: 1,
          stdout: "",
          stderr: "wsl.exe was not found",
        }),
      });

      expect(summary.serviceMode).toBe("scheduled-task");
      expect(summary.wsl.wslExeAvailable).toBe(false);
      expect(summary.wsl.recommendedAction).toContain("wsl --install");
    });
  });

  it("treats stalled WSL probes as degraded but bounded-time diagnostics", async () => {
    await withTempHome(async (env) => {
      const summary = await collectWindowsGatewayStatus(env, {
        taskRegistered: false,
        runtimeStatus: "stopped",
        execFileImpl: async () => ({
          code: 1,
          stdout: "",
          stderr: "Command failed because it timed out after 5000ms",
        }),
      });

      expect(summary.wsl.wslExeAvailable).toBe(true);
      expect(summary.wsl.defaultDistroReachable).toBe(false);
      expect(summary.wsl.detail).toContain("timed out");
      expect(summary.wsl.recommendedAction).toContain("wsl --shutdown");
    });
  });
});
