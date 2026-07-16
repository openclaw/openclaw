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

describe("takeChannelHealthEscalationBudgetSync", () => {
  it("counts escalations within the window and blocks at the cap", () => {
    const env = createStateEnv();
    const base = 1_000_000;
    const first = takeChannelHealthEscalationBudgetSync({
      escalationKey: "telegram:default",
      windowMs: HOUR_MS,
      maxPerWindow: 2,
      env,
      nowMs: base,
    });
    expect(first).toEqual({ allowed: true, usedInWindow: 1 });
    const second = takeChannelHealthEscalationBudgetSync({
      escalationKey: "telegram:default",
      windowMs: HOUR_MS,
      maxPerWindow: 2,
      env,
      nowMs: base + 10_000,
    });
    expect(second).toEqual({ allowed: true, usedInWindow: 2 });
    const third = takeChannelHealthEscalationBudgetSync({
      escalationKey: "telegram:default",
      windowMs: HOUR_MS,
      maxPerWindow: 2,
      env,
      nowMs: base + 20_000,
    });
    expect(third).toEqual({ allowed: false, usedInWindow: 2 });
  });

  it("survives across state database reopen like a process restart", () => {
    const env = createStateEnv();
    const base = 1_000_000;
    takeChannelHealthEscalationBudgetSync({
      escalationKey: "telegram:default",
      windowMs: HOUR_MS,
      maxPerWindow: 2,
      env,
      nowMs: base,
    });
    // A gateway process restart drops all in-memory state; reopening the
    // database is the equivalent boundary in tests.
    closeOpenClawStateDatabaseForTest();
    const afterRestart = takeChannelHealthEscalationBudgetSync({
      escalationKey: "telegram:default",
      windowMs: HOUR_MS,
      maxPerWindow: 2,
      env,
      nowMs: base + 10_000,
    });
    expect(afterRestart).toEqual({ allowed: true, usedInWindow: 2 });
  });

  it("resets the window once it fully elapses", () => {
    const env = createStateEnv();
    const base = 1_000_000;
    for (let i = 0; i < 2; i += 1) {
      takeChannelHealthEscalationBudgetSync({
        escalationKey: "telegram:default",
        windowMs: HOUR_MS,
        maxPerWindow: 2,
        env,
        nowMs: base + i * 1_000,
      });
    }
    const afterWindow = takeChannelHealthEscalationBudgetSync({
      escalationKey: "telegram:default",
      windowMs: HOUR_MS,
      maxPerWindow: 2,
      env,
      nowMs: base + HOUR_MS + 1,
    });
    expect(afterWindow).toEqual({ allowed: true, usedInWindow: 1 });
  });

  it("tracks keys independently", () => {
    const env = createStateEnv();
    const base = 1_000_000;
    takeChannelHealthEscalationBudgetSync({
      escalationKey: "telegram:default",
      windowMs: HOUR_MS,
      maxPerWindow: 1,
      env,
      nowMs: base,
    });
    const otherKey = takeChannelHealthEscalationBudgetSync({
      escalationKey: "slack:default",
      windowMs: HOUR_MS,
      maxPerWindow: 1,
      env,
      nowMs: base,
    });
    expect(otherKey).toEqual({ allowed: true, usedInWindow: 1 });
  });
});
