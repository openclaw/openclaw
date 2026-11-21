import fs from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { appendGatewayLifecycleAuditLog, resolveGatewayRestartLogPath } from "./restart-logs.js";
import { readGatewayForcedRestartSummary, warnAboutGatewayRestartStorm } from "./restart-storm.js";

const { findForeignLaunchdJobs } = vi.hoisted(() => ({
  findForeignLaunchdJobs: vi.fn(async () => [
    {
      label: "ai.openclaw.test.storm",
      keepAlive: true,
      gatewayActions: ["restart"],
      safeToRemove: true,
    },
  ]),
}));

vi.mock("./launchd-foreign-jobs.js", () => ({ findForeignLaunchdJobs }));

const dirs = useAutoCleanupTempDirTracker(afterEach);
const warn = vi.fn();
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  env = { OPENCLAW_STATE_DIR: dirs.make("openclaw-restart-storm-") };
  vi.useFakeTimers({ now: new Date("2026-09-01T12:00:00.000Z") });
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

function restart(count = 1) {
  for (let i = 0; i < count; i++) {
    appendGatewayLifecycleAuditLog(env, {
      source: "cli",
      action: "restart",
      mode: "kickstart",
      interactive: false,
    });
  }
}

const append = (text: string) => fs.appendFileSync(resolveGatewayRestartLogPath(env), text);

it("warns at the third external restart, names the likely job, and deduplicates across startup calls", async () => {
  restart(2);
  await warnAboutGatewayRestartStorm(env, warn);
  expect(warn).not.toHaveBeenCalled();
  expect(findForeignLaunchdJobs).not.toHaveBeenCalled();

  restart();
  await warnAboutGatewayRestartStorm(env, warn);
  const message =
    /3 external CLI restarts in 10 minutes.*ai\.openclaw\.test\.storm.*openclaw doctor --fix/;
  expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(message));

  const nextStartup = vi.fn();
  restart();
  await warnAboutGatewayRestartStorm(env, nextStartup);
  expect(nextStartup).not.toHaveBeenCalled();
  expect(findForeignLaunchdJobs).toHaveBeenCalledTimes(1);
  const log = fs.readFileSync(resolveGatewayRestartLogPath(env), "utf8");
  expect(log).toContain("restart-storm warning Gateway restart storm:");
});

it.each([
  ["expired", 3, 1],
  ["oversize", 2, 0],
] as const)("ignores %s history", async (mode, count, warnings) => {
  restart(3);
  if (mode === "expired") {
    await warnAboutGatewayRestartStorm(env, vi.fn());
    vi.setSystemTime(new Date("2026-09-01T12:10:00.001Z"));
    const event = "openclaw gateway lifecycle source=cli action=restart mode=kickstart\n";
    append(`[2026-09-01T12:11:00.001Z] ${event}`);
    append(`[invalid] ${event}`);
  } else {
    append(`${"x".repeat(256 * 1024)}\n`);
  }
  expect(readGatewayForcedRestartSummary(env).count).toBe(0);
  restart(count);
  await warnAboutGatewayRestartStorm(env, warn);
  expect(readGatewayForcedRestartSummary(env).count).toBe(count);
  expect(warn).toHaveBeenCalledTimes(warnings);
  if (!warnings) {
    expect(findForeignLaunchdJobs).not.toHaveBeenCalled();
  }
});

it("does not block startup when history is absent or job inspection fails", async () => {
  await warnAboutGatewayRestartStorm(env, warn);
  expect(warn).not.toHaveBeenCalled();
  restart(3);
  findForeignLaunchdJobs.mockRejectedValueOnce(new Error("launchd unavailable"));
  await warnAboutGatewayRestartStorm(env, warn);
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("Check for a stray keepalive launchd job"),
  );
});
