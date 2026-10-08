import fs from "node:fs";
import os from "node:os";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const mocks = vi.hoisted(() => ({
  runExec: vi.fn(),
  note: vi.fn(),
  readCommand: vi.fn(),
  findJobs: vi.fn(),
}));

vi.mock("../process/exec.js", () => ({
  runExec: mocks.runExec,
}));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));
vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({ readCommand: mocks.readCommand }),
}));
vi.mock("../daemon/launchd.js", () => ({ findStaleOpenClawUpdateLaunchdJobs: mocks.findJobs }));

import {
  collectGatewayPlatformWarnings,
  noteMacLaunchctlGatewayEnvOverrides,
  noteMacStaleOpenClawUpdateLaunchdJobs,
  noteStartupOptimizationHints,
} from "./doctor-platform-notes.js";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" });
  vi.stubEnv("HOME", "/tmp/openclaw-doctor-host");
  vi.stubEnv("OPENCLAW_STATE_DIR", "/tmp/openclaw-doctor-host-state");
  vi.spyOn(fs, "existsSync").mockReturnValue(false);
  mocks.runExec.mockResolvedValue({ stdout: "", stderr: "" });
  mocks.readCommand.mockResolvedValue(null);
  mocks.findJobs.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (platformDescriptor) {
    Object.defineProperty(process, "platform", platformDescriptor);
  }
});

describe("noteMacLaunchctlGatewayEnvOverrides", () => {
  it("prints clear unsetenv instructions for token override", async () => {
    mocks.runExec.mockImplementation(async (_command, [, name]) => ({
      stdout: name === "OPENCLAW_GATEWAY_TOKEN" ? " \tlaunchctl-token\n" : " \n",
      stderr: "",
    }));
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          token: "config-token",
        },
      },
    };

    await noteMacLaunchctlGatewayEnvOverrides(cfg);

    expect(mocks.note).toHaveBeenCalledTimes(1);
    expect(mocks.runExec).toHaveBeenCalledTimes(2);

    const [message, title] = expectDefined<unknown[]>(mocks.note.mock.calls[0], "note call 0");
    expect(title).toBe("Gateway (macOS)");
    expect(message).toContain("Host-wide launchctl gateway auth overrides detected");
    expect(message).toContain("Current managed Gateway installs do not need these values");
    expect(message).toContain("OPENCLAW_GATEWAY_TOKEN");
    expect(message).toContain("launchctl unsetenv OPENCLAW_GATEWAY_TOKEN");
    expect(message).not.toContain("OPENCLAW_GATEWAY_PASSWORD");
    expect(message).not.toContain("launchctl-token");
    expect(message).not.toContain("config-token");
  });

  it("treats SecretRef-backed credentials as configured", async () => {
    mocks.runExec.mockImplementation(async (_command, [, name]) => ({
      stdout: name === "OPENCLAW_GATEWAY_PASSWORD" ? " \tlaunchctl-password\n" : " \n",
      stderr: "",
    }));
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    };

    await noteMacLaunchctlGatewayEnvOverrides(cfg);

    expect(mocks.note).toHaveBeenCalledTimes(1);
    const [message] = expectDefined<unknown[]>(mocks.note.mock.calls[0], "note call 0");
    expect(message).toContain("OPENCLAW_GATEWAY_PASSWORD");
    expect(message).not.toContain("OPENCLAW_GATEWAY_TOKEN");
    expect(message).not.toContain("launchctl-password");
  });

  it("does nothing on non-darwin platforms", async () => {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
    mocks.runExec.mockResolvedValue({ stdout: "launchctl-token", stderr: "" });
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          token: "config-token",
        },
      },
    };

    await noteMacLaunchctlGatewayEnvOverrides(cfg);

    expect(mocks.runExec).not.toHaveBeenCalled();
    expect(mocks.note).not.toHaveBeenCalled();
  });

  it("bounds launchctl getenv calls and ignores timeout failures", async () => {
    mocks.runExec.mockRejectedValue(new Error("timed out"));
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          token: "config-token",
        },
      },
    };

    await noteMacLaunchctlGatewayEnvOverrides(cfg);

    expect(mocks.runExec).toHaveBeenNthCalledWith(
      1,
      "/bin/launchctl",
      ["getenv", "OPENCLAW_GATEWAY_TOKEN"],
      { logOutput: false, timeoutMs: 5_000 },
    );
    expect(mocks.runExec).toHaveBeenNthCalledWith(
      2,
      "/bin/launchctl",
      ["getenv", "OPENCLAW_GATEWAY_PASSWORD"],
      { logOutput: false, timeoutMs: 5_000 },
    );
    expect(mocks.note).not.toHaveBeenCalled();
  });
});

describe("noteMacStaleOpenClawUpdateLaunchdJobs", () => {
  it("uses service env for gateway platform stale updater warnings", async () => {
    const serviceEnv = {
      OPENCLAW_STATE_DIR: "/tmp/openclaw-daemon",
      OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.manual-update.gateway",
    };
    mocks.readCommand.mockResolvedValue({
      programArguments: ["/bin/node", "cli", "gateway"],
      environment: serviceEnv,
    });

    const warnings = await collectGatewayPlatformWarnings({});

    expect(warnings).toEqual([]);
    expect(mocks.runExec).not.toHaveBeenCalled();
    expect(mocks.readCommand).toHaveBeenCalledTimes(1);
    expect(mocks.findJobs).toHaveBeenCalledWith(
      expect.objectContaining({
        HOME: "/tmp/openclaw-doctor-host",
        OPENCLAW_STATE_DIR: "/tmp/openclaw-daemon",
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.manual-update.gateway",
      }),
    );
  });

  it("prints stale updater job cleanup guidance on macOS", async () => {
    mocks.findJobs.mockResolvedValue([
      {
        label: "ai.openclaw.update.2026.5.12",
        lastExitStatus: 127,
      },
      {
        label: "ai.openclaw.manual-update.1717168800",
        lastExitStatus: 0,
      },
    ]);

    await noteMacStaleOpenClawUpdateLaunchdJobs();

    expect(mocks.findJobs).toHaveBeenCalledTimes(1);
    const [message, title] = expectDefined<unknown[]>(mocks.note.mock.calls[0], "note call 0");
    expect(title).toBe("Gateway (macOS)");
    expect(message).toContain("Stale OpenClaw updater launchd job(s) detected");
    expect(message).toContain("ai.openclaw.update.2026.5.12");
    expect(message).toContain("ai.openclaw.manual-update.1717168800");
    expect(message).toContain("launchctl remove <label>");
    expect(message).toContain("openclaw gateway restart");
  });
});

describe("collectGatewayPlatformWarnings", () => {
  it("collects guidance when launch agent writes are disabled", async () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (candidate) => candidate === "/tmp/openclaw-doctor-host/.openclaw/disable-launchagent",
    );
    mocks.readCommand.mockResolvedValue({ environment: { HOME: "/tmp/openclaw-doctor-service" } });
    const warnings = await collectGatewayPlatformWarnings({});

    expect(warnings).toEqual([expect.stringContaining("LaunchAgent writes are disabled")]);
    expect(warnings[0]).toContain("disable-launchagent");
  });
});

describe("noteStartupOptimizationHints", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
    vi.spyOn(os, "arch").mockReturnValue("arm64");
    vi.spyOn(os, "totalmem").mockReturnValue(4 * 1024 ** 3);
  });

  it("does not warn when compile cache and no-respawn are configured", () => {
    noteStartupOptimizationHints({
      NODE_COMPILE_CACHE: "/var/tmp/openclaw-compile-cache",
      OPENCLAW_NO_RESPAWN: "1",
    });

    expect(mocks.note).not.toHaveBeenCalled();
  });

  it("warns when compile cache is under /tmp and no-respawn is not set", () => {
    noteStartupOptimizationHints({
      NODE_COMPILE_CACHE: "/tmp/openclaw-compile-cache",
    });

    expect(mocks.note).toHaveBeenCalledTimes(1);
    const [message, title] = expectDefined<unknown[]>(mocks.note.mock.calls[0], "note call 0");
    expect(title).toBe("Startup optimization");
    expect(message).toBe(
      [
        "- NODE_COMPILE_CACHE points to /tmp; use /var/tmp so cache survives reboots and warms startup reliably.",
        "- OPENCLAW_NO_RESPAWN is not set to 1; set it when you want routine gateway restarts to stay in-process instead of handing off to a managed supervisor.",
        "- Suggested env for low-power hosts:",
        "  export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache",
        "  mkdir -p /var/tmp/openclaw-compile-cache",
        "  export OPENCLAW_NO_RESPAWN=1",
      ].join("\n"),
    );
  });

  it("warns when compile cache is disabled via env override", () => {
    noteStartupOptimizationHints({
      NODE_COMPILE_CACHE: "/var/tmp/openclaw-compile-cache",
      OPENCLAW_NO_RESPAWN: "1",
      NODE_DISABLE_COMPILE_CACHE: "1",
    });

    expect(mocks.note).toHaveBeenCalledTimes(1);
    const [message] = expectDefined<unknown[]>(mocks.note.mock.calls[0], "note call 0");
    expect(message).toBe(
      [
        "- NODE_DISABLE_COMPILE_CACHE is set; startup compile cache is disabled.",
        "- Suggested env for low-power hosts:",
        "  export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache",
        "  mkdir -p /var/tmp/openclaw-compile-cache",
        "  export OPENCLAW_NO_RESPAWN=1",
        "  unset NODE_DISABLE_COMPILE_CACHE",
      ].join("\n"),
    );
  });

  it("skips startup optimization note on win32", () => {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });

    noteStartupOptimizationHints({
      NODE_COMPILE_CACHE: "/tmp/openclaw-compile-cache",
    });

    expect(mocks.note).not.toHaveBeenCalled();
  });

  it("skips startup optimization note on non-target linux hosts", () => {
    vi.mocked(os.arch).mockReturnValue("x64");
    vi.mocked(os.totalmem).mockReturnValue(32 * 1024 ** 3);

    noteStartupOptimizationHints({
      NODE_COMPILE_CACHE: "/tmp/openclaw-compile-cache",
    });

    expect(mocks.note).not.toHaveBeenCalled();
  });
});
