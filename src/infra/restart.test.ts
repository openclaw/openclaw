import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  isGatewayWorkAdmissionClosed,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { captureFullEnv, withEnv } from "../test-utils/env.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
    } as Partial<typeof import("node:child_process")>,
  );
});

// mock-isolation: Keep restart path resolution in the synthetic test state directory.
vi.mock("../config/paths.js", () => ({
  resolveGatewayPort: () => 18789,
  resolveStateDir: (env: NodeJS.ProcessEnv = process.env) =>
    env.OPENCLAW_STATE_DIR ?? "/tmp/openclaw-state",
}));

const {
  consumeGatewayRestartAuthorization,
  normalizeGatewayRestartDelayMs,
  requestGatewayRestartWithSignalAdmission,
  resetGatewayRestartStateForInProcessRestart,
  scheduleGatewayRestart,
  triggerOpenClawRestart,
} = await import("./restart.js");

const envSnapshot = captureFullEnv();

beforeEach(() => {
  spawnSyncMock.mockReset();
});

afterEach(() => {
  resetGatewayRestartStateForInProcessRestart();
  resetGatewayWorkAdmission();
  vi.useRealTimers();
  envSnapshot.restore();
  vi.restoreAllMocks();
});

it.each([0, 37])("handles launchctl bootstrap status %s", (bootstrapStatus) => {
  mockProcessPlatform("darwin");
  withEnv(
    { VITEST: undefined, NODE_ENV: undefined, HOME: "/Users/test", OPENCLAW_PROFILE: "default" },
    () => {
      const failure = { status: 1, stdout: "" };
      spawnSyncMock.mockImplementation((command: string, args: string[]) => {
        if (command !== "launchctl") {
          return failure;
        }
        if (args[0] === "bootstrap") {
          return {
            status: bootstrapStatus,
            stderr: bootstrapStatus === 0 ? "" : "Operation already in progress",
          };
        }
        if (args[0] !== "kickstart") {
          return failure;
        }
        if (args[1] === "-k") {
          return { status: 113, stderr: "service not loaded" };
        }
        return bootstrapStatus === 0 ? failure : { status: 0, stdout: "" };
      });
      const uid = typeof process.getuid === "function" ? process.getuid() : 501;
      expect(triggerOpenClawRestart()).toEqual({
        ok: true,
        method: "launchctl",
        tried: [
          `launchctl kickstart -k gui/${uid}/ai.openclaw.gateway`,
          `launchctl bootstrap gui/${uid} /Users/test/Library/LaunchAgents/ai.openclaw.gateway.plist`,
          ...(bootstrapStatus === 37 ? [`launchctl kickstart gui/${uid}/ai.openclaw.gateway`] : []),
        ],
      });
    },
  );
});

it("rejects restart without signaling an embedded host that has no restart handler", () => {
  mockProcessPlatform("linux");
  const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  const listeners = process.listeners("SIGUSR2");
  process.removeAllListeners("SIGUSR2");
  resetGatewayRestartStateForInProcessRestart();
  resetGatewayWorkAdmission();
  try {
    const result = requestGatewayRestartWithSignalAdmission("embedded-host");
    expect(result).toEqual({ status: "failed" });
    expect(killSpy).not.toHaveBeenCalled();
    expect(consumeGatewayRestartAuthorization()).toBe(false);
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  } finally {
    for (const listener of listeners) {
      process.on("SIGUSR2", listener);
    }
  }
});

it("uses the default delay when the requested delay is NaN", () => {
  expect(normalizeGatewayRestartDelayMs(Number.NaN)).toBe(2000);
});

it("does not emit an overflow-sized restart before its effective 60-second delay", async () => {
  vi.useFakeTimers();
  const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  const restart = scheduleGatewayRestart({ delayMs: 2_147_153_648 });
  expect(restart.delayMs).toBe(60_000);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(killSpy).not.toHaveBeenCalled();
});
