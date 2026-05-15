import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GATEWAY_STARTUP_RUNTIME_STATE_FILENAME,
  createGatewayStartupRuntimeState,
  readGatewayStartupRuntimeState,
  resolveGatewayStartupRuntimeStatePath,
  writeGatewayStartupRuntimeState,
} from "./startup-runtime-state.js";

const tempDirs: string[] = [];

function createTempStateEnv(): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-startup-state-"));
  tempDirs.push(dir);
  return { OPENCLAW_STATE_DIR: dir } as NodeJS.ProcessEnv;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("gateway startup runtime state", () => {
  it("writes sanitized startup diagnostics to OPENCLAW_STATE_DIR", () => {
    const env = createTempStateEnv();
    const longText = "x".repeat(600);
    const state = createGatewayStartupRuntimeState({
      port: 18789,
      safeMode: false,
      startupPhase: "sidecars-ready",
      pluginsLoaded: 2,
      startupStartedAt: Date.now() - 25,
    });
    state.channelsAttempted = 1;
    state.channelsTimedOut = 1;
    state.channelResults = [
      { id: longText, status: "timed_out", durationMs: 1000, error: longText },
    ];
    state.warnings = Array.from({ length: 55 }, (_, index) => `${index}:${longText}`);
    state.errors = [longText];

    writeGatewayStartupRuntimeState(state, env);

    const filePath = resolveGatewayStartupRuntimeStatePath(env);
    expect(filePath).toBe(
      path.join(env.OPENCLAW_STATE_DIR!, GATEWAY_STARTUP_RUNTIME_STATE_FILENAME),
    );
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(raw.channelResults[0].id).toHaveLength(500);
    expect(raw.channelResults[0].error).toHaveLength(500);
    expect(raw.warnings).toHaveLength(50);
    expect(raw.warnings[0]).toHaveLength(500);
    expect(raw.errors[0]).toHaveLength(500);
  });

  it("reads older or partial runtime state files with safe defaults", () => {
    const env = createTempStateEnv();
    fs.writeFileSync(
      resolveGatewayStartupRuntimeStatePath(env),
      JSON.stringify({ pid: 123, safeMode: true, channelResults: "bad", warnings: "bad" }),
      "utf-8",
    );

    expect(readGatewayStartupRuntimeState(env)).toMatchObject({
      pid: 123,
      safeMode: true,
      pluginsLoaded: 0,
      providersSkipped: false,
      channelsSkipped: false,
      channelsAttempted: 0,
      channelsStarted: 0,
      channelsFailed: 0,
      channelsTimedOut: 0,
      channelResults: [],
      startupDurationMs: 0,
      warnings: [],
      errors: [],
    });
  });

  it("returns null for missing or invalid state files", () => {
    const env = createTempStateEnv();
    expect(readGatewayStartupRuntimeState(env)).toBeNull();

    fs.writeFileSync(resolveGatewayStartupRuntimeStatePath(env), JSON.stringify({ pid: "bad" }));
    expect(readGatewayStartupRuntimeState(env)).toBeNull();
  });
});
