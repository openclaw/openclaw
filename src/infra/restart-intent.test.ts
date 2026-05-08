import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  consumeGatewayRestartIntentPayloadSync,
  consumeGatewayRestartIntentSync,
  writeGatewayRestartIntentSync,
} from "./restart.js";

const tempDirs: string[] = [];

function createIntentEnv(): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-restart-intent-"));
  tempDirs.push(dir);
  return {
    ...process.env,
    OPENCLAW_STATE_DIR: dir,
  };
}

function intentPath(env: NodeJS.ProcessEnv): string {
  return path.join(env.OPENCLAW_STATE_DIR ?? "", "gateway-restart-intent.json");
}

describe("gateway restart intent", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("consumes a fresh intent for the current process", () => {
    const env = createIntentEnv();

    expect(writeGatewayRestartIntentSync({ env, targetPid: process.pid })).toBe(true);

    expect(consumeGatewayRestartIntentSync(env)).toBe(true);
    expect(fs.existsSync(intentPath(env))).toBe(false);
  });

  it("rejects an intent for a different process", () => {
    const env = createIntentEnv();

    expect(writeGatewayRestartIntentSync({ env, targetPid: process.pid + 1 })).toBe(true);

    expect(consumeGatewayRestartIntentSync(env)).toBe(false);
    expect(fs.existsSync(intentPath(env))).toBe(false);
  });

  it("rejects oversized intent files before parsing", () => {
    const env = createIntentEnv();
    fs.writeFileSync(intentPath(env), "x".repeat(2048), { encoding: "utf8", mode: 0o600 });

    expect(consumeGatewayRestartIntentSync(env)).toBe(false);
    expect(fs.existsSync(intentPath(env))).toBe(true);
  });

  it("stores intents in SQLite instead of a legacy JSON file", () => {
    const env = createIntentEnv();

    expect(writeGatewayRestartIntentSync({ env, targetPid: process.pid })).toBe(true);

    expect(fs.existsSync(intentPath(env))).toBe(false);
    expect(consumeGatewayRestartIntentSync(env)).toBe(true);
  });

  it("round-trips restart force and wait options", () => {
    const env = createIntentEnv();

    expect(
      writeGatewayRestartIntentSync({
        env,
        targetPid: process.pid,
        intent: { force: true, waitMs: 12_345 },
      }),
    ).toBe(true);

    expect(consumeGatewayRestartIntentPayloadSync(env)).toEqual({
      force: true,
      waitMs: 12_345,
    });
    expect(fs.existsSync(intentPath(env))).toBe(false);
  });

  it("does not touch an existing legacy intent-path symlink when writing", () => {
    const env = createIntentEnv();
    const targetPath = path.join(env.OPENCLAW_STATE_DIR ?? "", "attacker-target.txt");
    fs.writeFileSync(targetPath, "keep", "utf8");
    try {
      fs.symlinkSync(targetPath, intentPath(env));
    } catch {
      return;
    }

    expect(writeGatewayRestartIntentSync({ env, targetPid: process.pid })).toBe(true);

    expect(fs.readFileSync(targetPath, "utf8")).toBe("keep");
    expect(fs.lstatSync(intentPath(env)).isSymbolicLink()).toBe(true);
    expect(consumeGatewayRestartIntentSync(env)).toBe(true);
  });
});
