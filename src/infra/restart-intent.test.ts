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
  });

  it("rejects an intent for a different process", () => {
    const env = createIntentEnv();

    expect(writeGatewayRestartIntentSync({ env, targetPid: process.pid + 1 })).toBe(true);

    expect(consumeGatewayRestartIntentSync(env)).toBe(false);
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
  });
});
