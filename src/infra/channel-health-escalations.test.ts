// Channel-health escalation budget tests cover restart-surviving accounting.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { takeChannelHealthEscalationBudgetSync } from "./channel-health-escalations.js";

const HOUR_MS = 60 * 60_000;

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

function createStateEnv(): NodeJS.ProcessEnv {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-health-escalations-"));
  return { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv;
}

function take(env: NodeJS.ProcessEnv, nowMs: number, key = "telegram:default", max = 2) {
  return takeChannelHealthEscalationBudgetSync({
    escalationKey: key,
    windowMs: HOUR_MS,
    maxPerWindow: max,
    env,
    nowMs,
  });
}

describe("takeChannelHealthEscalationBudgetSync", () => {
  it("counts escalations within the rolling window and blocks at the cap", () => {
    const env = createStateEnv();
    const base = 1_000_000;
    expect(take(env, base)).toEqual({ allowed: true, usedInWindow: 1 });
    expect(take(env, base + 10_000)).toEqual({ allowed: true, usedInWindow: 2 });
    expect(take(env, base + 20_000)).toEqual({ allowed: false, usedInWindow: 2 });
  });

  it("survives across state database reopen like a process restart", () => {
    const env = createStateEnv();
    const base = 1_000_000;
    take(env, base);
    // A gateway process restart drops all in-memory state; reopening the
    // database is the equivalent boundary in tests.
    closeOpenClawStateDatabaseForTest();
    expect(take(env, base + 10_000)).toEqual({ allowed: true, usedInWindow: 2 });
    expect(take(env, base + 20_000)).toEqual({ allowed: false, usedInWindow: 2 });
  });

  it("does not double the allowance across a window boundary (rolling, not fixed)", () => {
    const env = createStateEnv();
    const base = 1_000_000;
    take(env, base);
    take(env, base + 60_000);
    // A fixed window resetting here would allow two more restarts back to back.
    // The rolling window must keep both recent escalations in scope.
    expect(take(env, base + 61_000).allowed).toBe(false);
    expect(take(env, base + HOUR_MS - 1).allowed).toBe(false);
    // Only once the oldest escalation ages past the trailing window does one
    // slot free up.
    expect(take(env, base + HOUR_MS + 1)).toEqual({ allowed: true, usedInWindow: 2 });
    expect(take(env, base + HOUR_MS + 2).allowed).toBe(false);
  });

  it("tracks keys independently", () => {
    const env = createStateEnv();
    const base = 1_000_000;
    take(env, base, "telegram:default", 1);
    expect(take(env, base, "slack:default", 1)).toEqual({ allowed: true, usedInWindow: 1 });
  });

  it("fails closed when the state database is unavailable", () => {
    const bogusFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-health-escalations-")),
      "not-a-dir",
    );
    fs.writeFileSync(bogusFile, "block");
    const env = { OPENCLAW_STATE_DIR: bogusFile } as NodeJS.ProcessEnv;
    const result = take(env, 1_000_000);
    expect(result.allowed).toBe(false);
    expect(result.unavailable).toBe(true);
  });
});
