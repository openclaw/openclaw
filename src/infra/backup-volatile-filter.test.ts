import { describe, expect, it } from "vitest";
import { isVolatileBackupPath } from "./backup-volatile-filter.js";

const stateDir = "/opt/openclaw/state";
const plan = { stateDirs: [stateDir] };

describe("isVolatileBackupPath", () => {
  it.each([
    // volatile: session transcripts
    [`${stateDir}/sessions/s-abc/transcript.jsonl`, true],
    [`${stateDir}/sessions/s-abc/run.log`, true],
    // volatile: cron run logs
    [`${stateDir}/cron/runs/2026-01-01/job.log`, true],
    // volatile: generic state logs
    [`${stateDir}/logs/gateway.jsonl`, true],
    [`${stateDir}/logs/nested/gateway.log`, true],
    // volatile: sockets/pids/tmp/lock anywhere
    [`${stateDir}/ipc/gateway.sock`, true],
    [`${stateDir}/gateway.pid`, true],
    ["/var/tmp/openclaw/pending.tmp", true],
    ["/home/user/.openclaw/state/work.lock", true],

    // non-volatile: session config, not jsonl/log
    [`${stateDir}/sessions/s-abc/meta.json`, false],
    // non-volatile: cron definitions
    [`${stateDir}/cron/jobs.json`, false],
    // non-volatile: cron runs but wrong extension
    [`${stateDir}/cron/runs/2026-01-01/job.json`, false],
    // non-volatile: plain config
    [`${stateDir}/config.json`, false],
    // non-volatile: workspace files outside state
    ["/home/user/project/README.md", false],
    // non-volatile: log-like name outside scope
    ["/home/user/notes/daily.log", false],
  ])("classifies %s as volatile=%s", (p, expected) => {
    expect(isVolatileBackupPath(p, plan)).toBe(expected);
  });

  it("returns false when no state dirs are provided", () => {
    expect(
      isVolatileBackupPath(`${stateDir}/sessions/s-abc/transcript.jsonl`, { stateDirs: [] }),
    ).toBe(false);
  });

  it("still skips sockets/pids/tmp/lock with no state dirs configured", () => {
    expect(isVolatileBackupPath("/any/path/daemon.sock", { stateDirs: [] })).toBe(true);
    expect(isVolatileBackupPath("/any/path/daemon.pid", { stateDirs: [] })).toBe(true);
  });

  it("does not match paths that escape the anchor via `..`", () => {
    // `/opt/openclaw/state/sessions/../config.jsonl` resolves to
    // `/opt/openclaw/state/config.jsonl`, which is NOT inside sessions/.
    expect(isVolatileBackupPath(`${stateDir}/sessions/../config.jsonl`, plan)).toBe(false);
    expect(isVolatileBackupPath(`${stateDir}/cron/runs/../jobs.log`, plan)).toBe(false);
    expect(isVolatileBackupPath(`${stateDir}/logs/../notes.jsonl`, plan)).toBe(false);
  });

  it("normalizes Windows-style separators before anchor checks", () => {
    const winStateDir = "C:\\openclaw\\state";
    const winPlan = { stateDirs: [winStateDir] };
    expect(
      isVolatileBackupPath(`${winStateDir}\\sessions\\s-abc\\transcript.jsonl`, winPlan),
    ).toBe(true);
    expect(isVolatileBackupPath(`${winStateDir}\\cron\\runs\\2026\\job.log`, winPlan)).toBe(true);
    // `..` escape via backslashes must also be rejected.
    expect(isVolatileBackupPath(`${winStateDir}\\sessions\\..\\config.jsonl`, winPlan)).toBe(
      false,
    );
  });
});
