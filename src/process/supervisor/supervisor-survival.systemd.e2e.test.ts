import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSystemdScopeBoundary, isSystemdUserScopeAvailable } from "./boundary.js";

/**
 * Gate G-D1 — supervisor restart survival proof.
 *
 * Stands up a real `systemd --user` "gateway" service whose process launches a
 * worker through the production systemd-scope boundary plan, then stops the
 * gateway with `systemctl --user stop` and proves the worker survives and
 * writes its terminal event *after* the gateway is gone.
 *
 * The worker only writes its terminal event once it observes a `release` marker
 * that the test creates strictly after the gateway has stopped — so a passing
 * run cannot be explained by the worker finishing before the stop.
 *
 * Skipped when no per-user systemd manager is reachable (e.g. CI without a user
 * bus). See the matching boundary unit tests for always-on coverage and
 * `docs/superpowers/plans/2026-05-18-openclaw-multitasking-dgap1-supervisor-survival.md`
 * for the macOS launchd manual-verification gap.
 */

function systemctlUserReachable(): boolean {
  if (!isSystemdUserScopeAvailable()) {
    return false;
  }
  const probe = spawnSync("systemctl", ["--user", "show", "-p", "Version"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  return probe.status === 0;
}

const SYSTEMD_READY = systemctlUserReachable();

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await delay(100);
  }
  return predicate();
}

function unitActiveState(unit: string): string {
  const res = spawnSync("systemctl", ["--user", "is-active", unit], {
    encoding: "utf8",
    timeout: 5_000,
  });
  return (res.stdout || res.stderr || "").trim();
}

const WORKER_SCRIPT = `
const fs = require("node:fs");
const dir = process.argv[2];
fs.writeFileSync(dir + "/worker-started", String(process.pid));
const deadline = Date.now() + 20000;
const tick = () => {
  if (fs.existsSync(dir + "/release")) {
    fs.writeFileSync(dir + "/terminal-event.json", JSON.stringify({ reason: "completed", pid: process.pid }));
    process.exit(0);
  }
  if (Date.now() > deadline) {
    fs.writeFileSync(dir + "/terminal-event.json", JSON.stringify({ reason: "timeout", pid: process.pid }));
    process.exit(1);
  }
  setTimeout(tick, 100);
};
tick();
`;

const GATEWAY_SCRIPT = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const [, , planCommand, planArgsJson, dir] = process.argv;
const child = spawn(planCommand, JSON.parse(planArgsJson), { stdio: "inherit" });
fs.writeFileSync(dir + "/gateway-started", JSON.stringify({ gatewayPid: process.pid, launcherPid: child.pid }));
setInterval(() => {}, 1000);
`;

describe("supervisor restart survival (systemd --user scope)", () => {
  let workDir = "";
  let gatewayUnit = "";
  let workerUnit = "";

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "openclaw-survival-"));
  });

  afterEach(() => {
    if (gatewayUnit) {
      spawnSync("systemctl", ["--user", "stop", gatewayUnit], { timeout: 5_000 });
    }
    if (workerUnit) {
      spawnSync("systemctl", ["--user", "stop", workerUnit], { timeout: 5_000 });
    }
    const units = [gatewayUnit, workerUnit].filter(Boolean);
    if (units.length > 0) {
      spawnSync("systemctl", ["--user", "reset-failed", ...units], { timeout: 5_000 });
    }
    if (workDir) {
      rmSync(workDir, { recursive: true, force: true });
    }
    gatewayUnit = "";
    workerUnit = "";
    workDir = "";
  });

  it.skipIf(!SYSTEMD_READY)(
    "worker survives `systemctl stop` of its gateway and writes its terminal event",
    async () => {
      const suffix = `${process.pid}-${Date.now()}`;
      gatewayUnit = `openclaw-test-gw-${suffix}.service`;
      const workerPath = join(workDir, "worker.cjs");
      const gatewayPath = join(workDir, "gateway.cjs");
      writeFileSync(workerPath, WORKER_SCRIPT);
      writeFileSync(gatewayPath, GATEWAY_SCRIPT);

      // Build the worker launcher from the production systemd-scope boundary.
      const plan = createSystemdScopeBoundary().plan({
        argv: [process.execPath, workerPath, workDir],
        runId: suffix,
      });
      workerUnit = plan.unitId ?? "";
      expect(plan.command).toBe("systemd-run");
      expect(workerUnit).toMatch(/\.scope$/);

      // Launch the gateway as a transient systemd --user service. Its process
      // spawns the worker through the boundary plan (a sibling user scope).
      const start = spawnSync(
        "systemd-run",
        [
          "--user",
          "--quiet",
          "--collect",
          `--unit=${gatewayUnit}`,
          "--",
          process.execPath,
          gatewayPath,
          plan.command,
          JSON.stringify(plan.args),
          workDir,
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
      expect(start.status, `systemd-run failed: ${start.stderr}`).toBe(0);

      // The worker only writes `worker-started` after systemd has registered its
      // scope and exec'd it, so this is a reliable "worker is in its own cgroup"
      // synchronization point.
      const workerStarted = await waitFor(() => existsSync(join(workDir, "worker-started")), 8_000);
      expect(workerStarted, "worker never started inside its scope").toBe(true);

      // Stop the gateway. This tears down the gateway service cgroup (gateway
      // process + the systemd-run launcher), but not the sibling worker scope.
      const stop = spawnSync("systemctl", ["--user", "stop", gatewayUnit], {
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(stop.status, `systemctl stop failed: ${stop.stderr}`).toBe(0);

      const gatewayDown = await waitFor(() => unitActiveState(gatewayUnit) !== "active", 5_000);
      expect(gatewayDown, "gateway service did not stop").toBe(true);

      // No terminal event yet: the worker is blocked on the release marker we
      // only create now, strictly after the gateway is confirmed stopped.
      expect(existsSync(join(workDir, "terminal-event.json"))).toBe(false);
      writeFileSync(join(workDir, "release"), "go");

      const terminalWritten = await waitFor(
        () => existsSync(join(workDir, "terminal-event.json")),
        15_000,
      );
      expect(terminalWritten, "surviving worker never wrote its terminal event").toBe(true);

      const terminal = JSON.parse(readFileSync(join(workDir, "terminal-event.json"), "utf8"));
      // `completed` (not `timeout`) proves the worker did real work *after* the
      // gateway stop — the survival contract for gate G-D1.
      expect(terminal.reason).toBe("completed");
    },
    40_000,
  );
});
