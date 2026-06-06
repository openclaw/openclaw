// Daemon diagnostics tests cover service diagnostic collection and formatting.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readLastGatewayErrorLine } from "./diagnostics.js";
import { resolveGatewayLogPaths, resolveGatewaySupervisorLogPaths } from "./restart-logs.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-daemon-diagnostics-"));
  tempDirs.push(dir);
  return dir;
}

describe("readLastGatewayErrorLine", () => {
  it("reads the launchd supervisor stderr now that it is a real log file", async () => {
    const stateDir = makeTempStateDir();
    const homeDir = makeTempStateDir();
    const env = { HOME: homeDir, OPENCLAW_STATE_DIR: stateDir };
    const launchdLogs = resolveGatewaySupervisorLogPaths(env, { platform: "darwin" });
    fs.mkdirSync(launchdLogs.logDir, { recursive: true });
    // launchd now routes the supervised gateway's stderr to gateway.err.log, so
    // the most recent stderr failure must win over older stdout output.
    fs.writeFileSync(launchdLogs.stdoutPath, "gateway stdout current\n", "utf8");
    fs.writeFileSync(
      launchdLogs.stderrPath,
      "refusing to bind gateway to 0.0.0.0:8080 without auth\n",
      "utf8",
    );

    await expect(readLastGatewayErrorLine(env, { platform: "darwin" })).resolves.toBe(
      "refusing to bind gateway to 0.0.0.0:8080 without auth",
    );
  });

  it("prefers the current stderr error over a stale stdout match on linux", async () => {
    const stateDir = makeTempStateDir();
    const homeDir = makeTempStateDir();
    const env = { HOME: homeDir, OPENCLAW_STATE_DIR: stateDir };
    const stateLogs = resolveGatewayLogPaths(env);
    fs.mkdirSync(stateLogs.logDir, { recursive: true });
    // stderr carries the real, current failure; stdout carries an older matching
    // line. On non-darwin platforms stderr is the strongest failure signal, so
    // it must win instead of the stale stdout match.
    fs.writeFileSync(stateLogs.stderrPath, "failed to bind gateway socket EADDRINUSE\n", "utf8");
    fs.writeFileSync(stateLogs.stdoutPath, "gateway start blocked: stale prior reason\n", "utf8");

    await expect(readLastGatewayErrorLine(env, { platform: "linux" })).resolves.toBe(
      "failed to bind gateway socket EADDRINUSE",
    );
  });
});
