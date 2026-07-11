// Covers the operator killswitch persisted-state module.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  engageKillswitchSync,
  getKillswitchStatusSync,
  isKillswitchEngagedSync,
  releaseKillswitchSync,
} from "./killswitch.js";

const tempDirs: string[] = [];

function createKillswitchEnv(): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-killswitch-"));
  tempDirs.push(dir);
  return { ...process.env, OPENCLAW_STATE_DIR: dir };
}

describe("killswitch state", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("defaults to not engaged", () => {
    const env = createKillswitchEnv();
    expect(isKillswitchEngagedSync(env)).toBe(false);
    expect(getKillswitchStatusSync(env)).toEqual({ engaged: false });
  });

  it("engages with reason and source, then releases", () => {
    const env = createKillswitchEnv();
    engageKillswitchSync({ reason: "agent misbehaving", source: "signal", env });
    expect(isKillswitchEngagedSync(env)).toBe(true);
    const engaged = getKillswitchStatusSync(env);
    expect(engaged.engaged).toBe(true);
    expect(engaged.reason).toBe("agent misbehaving");
    expect(engaged.source).toBe("signal");
    expect(typeof engaged.engagedAtMs).toBe("number");
    expect(engaged.releasedAtMs).toBeUndefined();

    releaseKillswitchSync({ source: "cli", env });
    expect(isKillswitchEngagedSync(env)).toBe(false);
    const released = getKillswitchStatusSync(env);
    expect(released.engaged).toBe(false);
    expect(released.reason).toBeUndefined();
    expect(released.source).toBe("cli");
    expect(typeof released.releasedAtMs).toBe("number");
  });

  it("survives being engaged twice (idempotent re-engage keeps latest reason)", () => {
    const env = createKillswitchEnv();
    engageKillswitchSync({ reason: "first", source: "cli", env });
    engageKillswitchSync({ reason: "second", source: "signal", env });
    const status = getKillswitchStatusSync(env);
    expect(status.engaged).toBe(true);
    expect(status.reason).toBe("second");
    expect(status.source).toBe("signal");
  });

  it("releasing when never engaged is a no-op that reports not engaged", () => {
    const env = createKillswitchEnv();
    releaseKillswitchSync({ source: "cli", env });
    expect(isKillswitchEngagedSync(env)).toBe(false);
  });
});
