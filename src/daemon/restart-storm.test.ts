import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendGatewayLifecycleAuditLog, resolveGatewayRestartLogPath } from "./restart-logs.js";
import { readGatewayForcedRestartSummary, warnAboutGatewayRestartStorm } from "./restart-storm.js";

const { findForeignLaunchdJobs } = vi.hoisted(() => ({
  findForeignLaunchdJobs: vi.fn(async () => [
    {
      label: "ai.openclaw.test.storm",
      program: "/tmp/synthetic-updater.sh",
      keepAlive: true,
      gatewayActions: ["restart"],
      safeToRemove: true,
    },
  ]),
}));

vi.mock("./launchd-foreign-jobs.js", () => ({ findForeignLaunchdJobs }));

describe("managed Gateway external restart storm diagnostics", () => {
  let stateDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-restart-storm-"));
    env = { OPENCLAW_STATE_DIR: stateDir };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T12:00:00.000Z"));
    findForeignLaunchdJobs.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function restart() {
    appendGatewayLifecycleAuditLog(env, {
      source: "cli",
      action: "restart",
      mode: "kickstart",
      interactive: false,
    });
  }

  function record(fields: string, ageMs = 0) {
    const logPath = resolveGatewayRestartLogPath(env);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(
      logPath,
      `[${new Date(Date.now() - ageMs).toISOString()}] openclaw gateway lifecycle ${fields}\n`,
    );
  }

  it("warns at the third external restart, names the likely job, and deduplicates across startup calls", async () => {
    const firstStartup = vi.fn();
    restart();
    restart();
    await warnAboutGatewayRestartStorm(env, firstStartup);
    expect(firstStartup).not.toHaveBeenCalled();
    expect(findForeignLaunchdJobs).not.toHaveBeenCalled();

    restart();
    await warnAboutGatewayRestartStorm(env, firstStartup);
    expect(firstStartup).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("3 external CLI restarts in 10 minutes"),
    );
    expect(firstStartup.mock.calls[0]?.[0]).toContain("ai.openclaw.test.storm");
    expect(firstStartup.mock.calls[0]?.[0]).toContain("openclaw doctor --fix");

    const nextStartup = vi.fn();
    restart();
    await warnAboutGatewayRestartStorm(env, nextStartup);
    expect(nextStartup).not.toHaveBeenCalled();
    expect(findForeignLaunchdJobs).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(resolveGatewayRestartLogPath(env), "utf8")).toContain(
      "restart-storm warning Gateway restart storm:",
    );
  });

  it("counts only disruptive external CLI restart steps, not safe, internal, or activation events", () => {
    for (const fields of [
      "source=safe-rpc action=restart mode=deferred",
      "source=safe-rpc action=restart mode=rpc",
      "source=supervisor action=restart mode=sigusr1",
      "source=handoff action=restart mode=kickstart",
      "source=cli action=restart mode=handoff-kickstart",
      "source=cli action=restart mode=handoff-reload",
      "source=cli action=start mode=kickstart",
      "source=cli action=stop mode=bootout",
      "source=cli action=restart mode=enable",
      "source=cli action=restart mode=bootout",
      "source=cli action=restart mode=bootstrap",
    ]) {
      record(fields);
    }
    restart();
    expect(readGatewayForcedRestartSummary(env)).toEqual({
      count: 2,
      windowMs: 600_000,
      lastRestartAt: "2026-09-01T12:00:00.000Z",
    });
  });

  it("expires old restarts and warnings and ignores malformed and future records", async () => {
    restart();
    restart();
    restart();
    await warnAboutGatewayRestartStorm(env, vi.fn());
    vi.setSystemTime(new Date("2026-09-01T12:10:00.001Z"));
    record("source=cli action=restart mode=kickstart", -60_000);
    fs.appendFileSync(
      resolveGatewayRestartLogPath(env),
      "[invalid] openclaw gateway lifecycle source=cli action=restart mode=kickstart\n",
    );
    expect(readGatewayForcedRestartSummary(env).count).toBe(0);

    restart();
    restart();
    restart();
    const warn = vi.fn();
    await warnAboutGatewayRestartStorm(env, warn);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("bounds history reads even when the restart log has a large handoff transcript", async () => {
    restart();
    restart();
    restart();
    fs.appendFileSync(resolveGatewayRestartLogPath(env), `${"x".repeat(256 * 1024)}\n`);
    restart();
    restart();
    const warn = vi.fn();
    await warnAboutGatewayRestartStorm(env, warn);
    expect(readGatewayForcedRestartSummary(env).count).toBe(2);
    expect(warn).not.toHaveBeenCalled();
    expect(findForeignLaunchdJobs).not.toHaveBeenCalled();
  });

  it("does not block startup when history is absent or job inspection fails", async () => {
    const warn = vi.fn();
    await warnAboutGatewayRestartStorm(env, warn);
    expect(warn).not.toHaveBeenCalled();
    restart();
    restart();
    restart();
    findForeignLaunchdJobs.mockRejectedValueOnce(new Error("launchd unavailable"));
    await warnAboutGatewayRestartStorm(env, warn);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Check for a stray keepalive launchd job"),
    );
  });

  it("does not name protected, unrelated, or non-keepalive jobs as the likely cause", async () => {
    restart();
    restart();
    restart();
    findForeignLaunchdJobs.mockResolvedValueOnce([
      {
        label: "ai.openclaw.gateway",
        program: "/tmp/gateway",
        keepAlive: true,
        gatewayActions: ["restart"],
        safeToRemove: false,
      },
      {
        label: "ai.openclaw.test.observer",
        program: "/tmp/observer",
        keepAlive: true,
        gatewayActions: [],
        safeToRemove: false,
      },
      {
        label: "ai.openclaw.test.once",
        program: "/tmp/once",
        keepAlive: false,
        gatewayActions: ["restart"],
        safeToRemove: true,
      },
    ]);
    const warn = vi.fn();
    await warnAboutGatewayRestartStorm(env, warn);
    expect(warn.mock.calls[0]?.[0]).not.toContain("ai.openclaw.");
  });
});
