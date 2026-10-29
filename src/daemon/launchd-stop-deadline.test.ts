await vi.hoisted(() => import("./launchd-ancestry.test-support.js"));
import "./launchd-fs.mocks.test-support.js";
import { expect, it, vi } from "vitest";
import {
  inspectPortUsage,
  isPidDefinitelyDead,
  probePortUsage,
} from "./launchd-ancestry.test-support.js";
import {
  capturePassThroughOutput,
  createLaunchdEnvWithGatewayPort,
} from "./launchd-install.test-support.js";
import { launchdTestState as state } from "./launchd-state.test-support.js";
import { stopLaunchAgent } from "./launchd.js";

it.each([
  ["process exit", -3_600_000],
  ["process exit", 3_600_000],
  ["port release", -3_600_000],
  ["port release", 3_600_000],
] as const)("preserves the %s deadline when the wall clock steps %i ms", async (phase, step) => {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  state.bootoutLeavesLoaded = phase === "process exit";
  isPidDefinitelyDead.mockReturnValue(phase !== "process exit");
  inspectPortUsage.mockResolvedValue({
    port: 19011,
    status: phase === "port release" ? "busy" : "free",
    listeners: [],
    hints: [],
  });
  probePortUsage.mockResolvedValue("busy");
  const settled = vi.fn();
  const stopped = stopLaunchAgent({
    env: createLaunchdEnvWithGatewayPort("19011"),
    stdout: capturePassThroughOutput(() => {}),
  }).then(settled, settled);
  try {
    await vi.advanceTimersByTimeAsync(500);
    if (phase === "port release") {
      await vi.waitFor(() => expect(probePortUsage).toHaveBeenCalled());
    }
    expect(settled).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + step);
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).not.toHaveBeenCalled();
  } finally {
    state.serviceLoaded = false;
    isPidDefinitelyDead.mockReturnValue(true);
    probePortUsage.mockResolvedValue("free");
    await vi.advanceTimersByTimeAsync(500);
    await stopped;
    vi.useRealTimers();
  }
  expect(settled).toHaveBeenCalledExactlyOnceWith(undefined);
});
