import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { captureFullEnv } from "../../test-utils/env.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const scheduleGatewaySigusr1RestartMock = vi.hoisted(() => vi.fn());
const triggerOpenClawRestartMock = vi.hoisted(() => vi.fn());
const isLocalRestartScriptAvailableMock = vi.hoisted(() => vi.fn());

vi.mock("../../infra/restart.js", () => ({
  isLocalRestartScriptAvailable: (...args: unknown[]) => isLocalRestartScriptAvailableMock(...args),
  scheduleGatewaySigusr1Restart: (...args: unknown[]) => scheduleGatewaySigusr1RestartMock(...args),
  triggerOpenClawRestart: (...args: unknown[]) => triggerOpenClawRestartMock(...args),
}));

const { handleRestartCommand } = await import("./commands-session.js");

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

const restartEnabledCfg = {
  commands: { restart: true },
} as OpenClawConfig;

function buildParams(commandBody: string, overrides?: Record<string, unknown>) {
  return buildCommandTestParams(commandBody, restartEnabledCfg, overrides);
}

beforeEach(() => {
  isLocalRestartScriptAvailableMock.mockReset();
  scheduleGatewaySigusr1RestartMock.mockReset();
  triggerOpenClawRestartMock.mockReset();
  isLocalRestartScriptAvailableMock.mockReturnValue(false);
});

afterEach(() => {
  envSnapshot.restore();
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
  vi.restoreAllMocks();
});

describe("handleRestartCommand", () => {
  it("prefers local restart script for Telegram on macOS when available", async () => {
    setPlatform("darwin");
    isLocalRestartScriptAvailableMock.mockReturnValue(true);

    vi.spyOn(process, "listenerCount").mockImplementation((signal) =>
      signal === "SIGUSR1" ? 1 : 0,
    );

    triggerOpenClawRestartMock.mockReturnValue({
      ok: true,
      method: "launchctl",
      detail: "scheduled local restart script: /tmp/openclaw-restart-local-gateway.sh",
    });

    const result = await handleRestartCommand(
      buildParams("/restart", {
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
      }),
      true,
    );

    expect(triggerOpenClawRestartMock).toHaveBeenCalledWith({ preferLocalScript: true });
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(result?.reply?.text).toContain("local restart script");
  });

  it("uses in-process SIGUSR1 scheduling for non-Telegram surfaces", async () => {
    setPlatform("darwin");
    isLocalRestartScriptAvailableMock.mockReturnValue(true);
    vi.spyOn(process, "listenerCount").mockImplementation((signal) =>
      signal === "SIGUSR1" ? 1 : 0,
    );

    const result = await handleRestartCommand(buildParams("/restart"), true);

    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledWith({ reason: "/restart" });
    expect(triggerOpenClawRestartMock).not.toHaveBeenCalled();
    expect(result?.reply?.text).toContain("SIGUSR1");
  });

  it("keeps SIGUSR1 path for Telegram when no local script is configured", async () => {
    setPlatform("darwin");
    isLocalRestartScriptAvailableMock.mockReturnValue(false);
    vi.spyOn(process, "listenerCount").mockImplementation((signal) =>
      signal === "SIGUSR1" ? 1 : 0,
    );

    const result = await handleRestartCommand(
      buildParams("/restart", {
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
      }),
      true,
    );

    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledWith({ reason: "/restart" });
    expect(triggerOpenClawRestartMock).not.toHaveBeenCalled();
    expect(result?.reply?.text).toContain("SIGUSR1");
  });
});
