import { afterEach, describe, expect, it, vi } from "vitest";
import { captureFullEnv } from "../test-utils/env.js";
import { SUPERVISOR_HINT_ENV_VARS } from "./supervisor-markers.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { restartGatewayProcessWithFreshPid } from "./process-respawn.js";

const originalArgv = [...process.argv];
const originalExecArgv = [...process.execArgv];
const envSnapshot = captureFullEnv();
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: string) {
  if (!originalPlatformDescriptor) {
    return;
  }
  Object.defineProperty(process, "platform", {
    ...originalPlatformDescriptor,
    value: platform,
  });
}

afterEach(() => {
  envSnapshot.restore();
  process.argv = [...originalArgv];
  process.execArgv = [...originalExecArgv];
  spawnMock.mockClear();
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
});

function clearSupervisorHints() {
  for (const key of SUPERVISOR_HINT_ENV_VARS) {
    delete process.env[key];
  }
}

describe("restartGatewayProcessWithFreshPid", () => {
  it("returns disabled when BOT_NO_RESPAWN is set", () => {
    process.env.BOT_NO_RESPAWN = "1";
    const result = restartGatewayProcessWithFreshPid();
    expect(result.mode).toBe("disabled");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns supervised when launchd/systemd hints are present", () => {
    process.env.LAUNCH_JOB_LABEL = "ai.bot.gateway";
    const result = restartGatewayProcessWithFreshPid();
    expect(result.mode).toBe("supervised");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("schedules detached launchctl kickstart on macOS when launchd label is set", () => {
    setPlatform("darwin");
    process.env.LAUNCH_JOB_LABEL = "ai.hanzo.bot.gateway";
    process.env.BOT_LAUNCHD_LABEL = "ai.hanzo.bot.gateway";
    const unrefMock = vi.fn();
    spawnMock.mockReturnValue({ unref: unrefMock, on: vi.fn() });

    const result = restartGatewayProcessWithFreshPid();

    expect(result.mode).toBe("supervised");
    expect(spawnMock).toHaveBeenCalledWith(
      "launchctl",
      ["kickstart", "-k", expect.stringContaining("ai.hanzo.bot.gateway")],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
    expect(unrefMock).toHaveBeenCalledOnce();
  });

  it("still returns supervised even if kickstart spawn throws", () => {
    setPlatform("darwin");
    process.env.LAUNCH_JOB_LABEL = "ai.hanzo.bot.gateway";
    process.env.BOT_LAUNCHD_LABEL = "ai.hanzo.bot.gateway";
    spawnMock.mockImplementation((...args: unknown[]) => {
      const [cmd] = args as [string];
      if (cmd === "launchctl") {
        throw new Error("spawn failed");
      }
      return { unref: vi.fn(), on: vi.fn() };
    });

    const result = restartGatewayProcessWithFreshPid();

    // Kickstart is best-effort; failure should not block supervised exit
    expect(result.mode).toBe("supervised");
  });

  it("does not schedule kickstart on non-darwin platforms", () => {
    setPlatform("linux");
    process.env.INVOCATION_ID = "abc123";
    process.env.BOT_LAUNCHD_LABEL = "ai.hanzo.bot.gateway";

    const result = restartGatewayProcessWithFreshPid();

    expect(result.mode).toBe("supervised");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("spawns detached child with current exec argv", () => {
    delete process.env.BOT_NO_RESPAWN;
    clearSupervisorHints();
    process.execArgv = ["--import", "tsx"];
    process.argv = ["/usr/local/bin/node", "/repo/dist/index.js", "gateway", "run"];
    spawnMock.mockReturnValue({ pid: 4242, unref: vi.fn() });

    const result = restartGatewayProcessWithFreshPid();

    expect(result).toEqual({ mode: "spawned", pid: 4242 });
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ["--import", "tsx", "/repo/dist/index.js", "gateway", "run"],
      expect.objectContaining({
        detached: true,
        stdio: "inherit",
      }),
    );
  });

  it("returns supervised when BOT_LAUNCHD_LABEL is set (stock launchd plist)", () => {
    clearSupervisorHints();
    setPlatform("darwin");
    process.env.BOT_LAUNCHD_LABEL = "ai.hanzo.bot.gateway";
    const unrefMock = vi.fn();
    spawnMock.mockReturnValue({ unref: unrefMock, on: vi.fn() });
    const result = restartGatewayProcessWithFreshPid();
    expect(result.mode).toBe("supervised");
    expect(spawnMock).toHaveBeenCalledWith(
      "launchctl",
      expect.arrayContaining(["kickstart", "-k"]),
      expect.objectContaining({ detached: true }),
    );
    expect(unrefMock).toHaveBeenCalledOnce();
  });

  it("returns supervised when BOT_SYSTEMD_UNIT is set", () => {
    clearSupervisorHints();
    process.env.BOT_SYSTEMD_UNIT = "hanzo-bot-gateway.service";
    const result = restartGatewayProcessWithFreshPid();
    expect(result.mode).toBe("supervised");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns supervised when BOT_SERVICE_MARKER is set", () => {
    clearSupervisorHints();
    process.env.BOT_SERVICE_MARKER = "gateway";
    const result = restartGatewayProcessWithFreshPid();
    expect(result.mode).toBe("supervised");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns failed when spawn throws", () => {
    delete process.env.BOT_NO_RESPAWN;
    clearSupervisorHints();

    spawnMock.mockImplementation(() => {
      throw new Error("spawn failed");
    });
    const result = restartGatewayProcessWithFreshPid();
    expect(result.mode).toBe("failed");
    expect(result.detail).toContain("spawn failed");
  });
});
