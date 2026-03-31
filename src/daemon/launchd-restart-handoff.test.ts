import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const unrefMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { scheduleDetachedLaunchdRestartHandoff } from "./launchd-restart-handoff.js";

afterEach(() => {
  spawnMock.mockReset();
  unrefMock.mockReset();
  spawnMock.mockReturnValue({ pid: 4242, unref: unrefMock });
});

describe("scheduleDetachedLaunchdRestartHandoff", () => {
  it("waits for the caller pid before kickstarting launchd", () => {
    const env = {
      HOME: "/Users/test",
      OPENCLAW_PROFILE: "default",
    };
    spawnMock.mockReturnValue({ pid: 4242, unref: unrefMock });

    const result = scheduleDetachedLaunchdRestartHandoff({
      env,
      mode: "kickstart",
      waitForPid: 9876,
    });

    expect(result).toEqual({ ok: true, pid: 4242 });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args[0]).toBe("-c");
    expect(args[2]).toBe("openclaw-launchd-restart-handoff");
    expect(args[6]).toBe("9876");
    expect(args[1]).toContain('while kill -0 "$wait_pid" >/dev/null 2>&1; do');
    expect(args[1]).toContain('launchctl kickstart -k "$service_target" >/dev/null 2>&1');
    expect(args[1]).not.toContain("sleep 1");
    expect(unrefMock).toHaveBeenCalledTimes(1);
  });

  it("bootout before bootstrap in kickstart mode to clear throttle state", () => {
    const env = { HOME: "/Users/test", OPENCLAW_PROFILE: "default" };
    spawnMock.mockReturnValue({ pid: 4242, unref: unrefMock });

    scheduleDetachedLaunchdRestartHandoff({ env, mode: "kickstart", waitForPid: 9876 });

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    const script = args[1];
    // bootout must appear before bootstrap so any stale registration and
    // ThrottleInterval state is cleared before re-registering the service.
    const bootoutIndex = script.indexOf('launchctl bootout "$domain" "$plist_path"');
    const bootstrapIndex = script.indexOf('launchctl bootstrap "$domain" "$plist_path"');
    expect(bootoutIndex).toBeGreaterThanOrEqual(0);
    expect(bootstrapIndex).toBeGreaterThan(bootoutIndex);
  });

  it("bootout before bootstrap in start-after-exit mode to clear throttle state", () => {
    const env = { HOME: "/Users/test", OPENCLAW_PROFILE: "default" };
    spawnMock.mockReturnValue({ pid: 5555, unref: unrefMock });

    const result = scheduleDetachedLaunchdRestartHandoff({
      env,
      mode: "start-after-exit",
      waitForPid: 1234,
    });

    expect(result).toEqual({ ok: true, pid: 5555 });
    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    const script = args[1];
    expect(args[6]).toBe("1234");
    // start-after-exit should also clear throttle state via bootout before bootstrap.
    const bootoutIndex = script.indexOf('launchctl bootout "$domain" "$plist_path"');
    const bootstrapIndex = script.indexOf('launchctl bootstrap "$domain" "$plist_path"');
    expect(bootoutIndex).toBeGreaterThanOrEqual(0);
    expect(bootstrapIndex).toBeGreaterThan(bootoutIndex);
    // Should attempt start first, then fall back to the bootstrap path.
    expect(script).toContain('launchctl start "$service_target"');
    expect(script).toContain('launchctl kickstart -k "$service_target"');
  });
});
