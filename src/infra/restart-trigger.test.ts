import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureFullEnv } from "../test-utils/env.js";

const cleanStaleGatewayProcessesSyncMock = vi.hoisted(() => vi.fn());
const relaunchGatewayScheduledTaskMock = vi.hoisted(() => vi.fn());

vi.mock("./restart-stale-pids.js", async () => {
  const actual =
    await vi.importActual<typeof import("./restart-stale-pids.js")>("./restart-stale-pids.js");
  return {
    ...actual,
    cleanStaleGatewayProcessesSync: (...args: unknown[]) =>
      cleanStaleGatewayProcessesSyncMock(...args),
  };
});

vi.mock("./windows-task-restart.js", () => ({
  relaunchGatewayScheduledTask: (...args: unknown[]) => relaunchGatewayScheduledTaskMock(...args),
}));

import { __testing, triggerOpenClawRestart } from "./restart.js";

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

beforeEach(() => {
  cleanStaleGatewayProcessesSyncMock.mockReset();
  relaunchGatewayScheduledTaskMock.mockReset();
  // The SIGUSR1 fast path is gated by test-mode early-return; opt out here so
  // the real platform branch is exercised.
  delete process.env.VITEST;
  delete process.env.NODE_ENV;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  __testing.resetSigusr1State();
  envSnapshot.restore();
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
  while (process.listenerCount("SIGUSR1") > 0) {
    const [first] = process.listeners("SIGUSR1");
    if (first) {
      process.removeListener("SIGUSR1", first);
    }
  }
});

describe("triggerOpenClawRestart SIGUSR1 fast path", () => {
  it("returns method=sigusr1 when a SIGUSR1 listener is registered", () => {
    const listener = vi.fn();
    process.on("SIGUSR1", listener);
    setPlatform("linux");

    const result = triggerOpenClawRestart();

    expect(result.ok).toBe(true);
    expect(result.method).toBe("sigusr1");
    // Fast path must skip platform-specific spawns.
    expect(cleanStaleGatewayProcessesSyncMock).not.toHaveBeenCalled();
    expect(relaunchGatewayScheduledTaskMock).not.toHaveBeenCalled();
  });

  it("takes the fast path on Windows as well — the scheduled-task relaunch is handled by process-respawn.ts during the subsequent SIGUSR1 drain/exit cycle, not here", () => {
    const listener = vi.fn();
    process.on("SIGUSR1", listener);
    setPlatform("win32");

    const result = triggerOpenClawRestart();

    expect(result.method).toBe("sigusr1");
    expect(relaunchGatewayScheduledTaskMock).not.toHaveBeenCalled();
  });

  it("falls through to platform dispatch when no SIGUSR1 listener is registered", () => {
    setPlatform("win32");
    relaunchGatewayScheduledTaskMock.mockReturnValue({ ok: true, method: "schtasks" });

    const result = triggerOpenClawRestart();

    expect(relaunchGatewayScheduledTaskMock).toHaveBeenCalledOnce();
    expect(result.method).toBe("schtasks");
  });
});
