await vi.hoisted(() => import("./launchd-ancestry.test-support.js"));
import "./launchd-fs.mocks.test-support.js";
import { expect, it, vi } from "vitest";
import { isPidDefinitelyDead } from "./launchd-ancestry.test-support.js";
import {
  capturePassThroughOutput,
  createDefaultLaunchdEnv,
} from "./launchd-install.test-support.js";
import { launchdTestState as state } from "./launchd-state.test-support.js";
import { stopLaunchAgent } from "./launchd.js";

it("does not prematurely expire the stop deadline when the wall clock moves forward", async () => {
  // Fake Date + timers so vi.setSystemTime moves Date without moving the
  // real monotonic performance clock used by the stop deadline.
  vi.useFakeTimers();
  let output = "";
  const stdout = capturePassThroughOutput((text) => (output += text));
  state.bootoutLeavesLoaded = true;
  isPidDefinitelyDead.mockReturnValue(false);
  try {
    const stopped = stopLaunchAgent({ env: createDefaultLaunchdEnv(), stdout });
    // Let the bootout and the first probe iteration run.
    await vi.advanceTimersByTimeAsync(500);
    expect(output).not.toContain("Stopped LaunchAgent");
    // Jump the wall clock well past the stop timeout. A monotonic deadline
    // is unaffected; a wall-clock deadline would expire immediately.
    vi.setSystemTime(new Date(Date.now() + 3_600_000));
    await vi.advanceTimersByTimeAsync(500);
    // The stop must still be pending — the monotonic deadline is far away.
    expect(output).not.toContain("Stopped LaunchAgent");
    // Complete the stop normally and verify it finishes.
    state.serviceLoaded = false;
    isPidDefinitelyDead.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(500);
    await stopped;
    expect(output).toContain("Stopped LaunchAgent");
  } finally {
    vi.useRealTimers();
  }
});
