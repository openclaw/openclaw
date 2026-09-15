// Self-emitted SIGUSR1 restarts (deferred reload recovery, scheduled restarts)
// never pass through the CLI, so they must leave their own trace in
// gateway-restart.log. Otherwise outages cannot be attributed to an actor.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import {
  requestGatewayRestartWithSignalAdmission,
  resetGatewayRestartStateForInProcessRestart,
} from "./restart.js";

const sigusr1Handler = () => {};
let stateDir: string | undefined;
let previousStateDir: string | undefined;

describe("self-emitted restart audit", () => {
  beforeEach(() => {
    resetGatewayRestartStateForInProcessRestart();
    resetGatewayWorkAdmission();
    // A listener makes restart emission use process.emit instead of process.kill.
    process.on("SIGUSR1", sigusr1Handler);
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-self-restart-audit-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterEach(() => {
    process.removeListener("SIGUSR1", sigusr1Handler);
    resetGatewayRestartStateForInProcessRestart();
    resetGatewayWorkAdmission();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    if (stateDir) {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
    stateDir = undefined;
  });

  it("appends a source=self line to gateway-restart.log on emission", () => {
    const result = requestGatewayRestartWithSignalAdmission("test self restart");
    expect(result.status).toBe("emitted");
    const log = fs.readFileSync(path.join(stateDir!, "logs", "gateway-restart.log"), "utf8");
    expect(log).toContain("source=self");
    expect(log).toContain("action=restart");
    expect(log).toContain("mode=sigusr1");
  });
});
