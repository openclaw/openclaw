import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GATEWAY_STARTUP_RUNTIME_STATE_FILENAME,
  createGatewayStartupRuntimeState,
  readGatewayStartupRuntimeState,
  resolveGatewayStartupRuntimeStatePath,
  redactStartupRuntimeText,
  resolveGatewayStartupReadiness,
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

  it("redacts secret-bearing startup diagnostics before persisting", () => {
    const env = createTempStateEnv();
    const state = createGatewayStartupRuntimeState({ safeMode: false, startupPhase: "http-ready" });
    state.channelResults = [
      {
        id: "discord",
        status: "failed",
        error:
          "failed https://user:pass@example.com token=abc access_token=def refresh_token=ghi api_key=jkl apikey=mno secret=pqr password=stu passwd=vwx Authorization: Bearer bearer-secret eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature openclaw.json { gateway: { auth: { token: raw } } }" +
          "x".repeat(600),
      },
    ];
    state.warnings = ["postgres://u:p@db.local/app?password=dbpass"];
    state.errors = ["bearer another-secret-value-that-is-long-enough"];

    writeGatewayStartupRuntimeState(state, env);

    const raw = JSON.parse(fs.readFileSync(resolveGatewayStartupRuntimeStatePath(env), "utf-8"));
    const combined = JSON.stringify(raw);
    expect(combined).not.toContain("user:pass");
    expect(combined).not.toContain("bearer-secret");
    expect(combined).not.toContain("another-secret-value");
    expect(combined).not.toContain("abc");
    expect(combined).not.toContain("dbpass");
    expect(combined).toContain("[REDACTED]");
    expect(raw.channelResults[0].error).toHaveLength(500);
  });

  it("redacts individual secret patterns", () => {
    expect(redactStartupRuntimeText("https://user:pass@example.test/path")).not.toContain(
      "user:pass",
    );
    expect(redactStartupRuntimeText("Authorization: Bearer abcdefghijklmnop")).toContain(
      "Authorization: Bearer [REDACTED]",
    );
    expect(
      redactStartupRuntimeText("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature"),
    ).toBe("[REDACTED]");
    expect(redactStartupRuntimeText("api_key=abc token=def password=ghi secret=jkl")).toBe(
      "api_key=[REDACTED] token=[REDACTED] password=[REDACTED] secret=[REDACTED]",
    );
    expect(redactStartupRuntimeText("Server=a;Password=super-secret;User Id=b")).toContain(
      "Password=[REDACTED]",
    );
  });

  it("resolves explicit startup readiness semantics", () => {
    expect(resolveGatewayStartupReadiness(null)).toMatchObject({ fullyReady: false });
    expect(
      resolveGatewayStartupReadiness({
        ...createGatewayStartupRuntimeState({ safeMode: false, startupPhase: "http-ready" }),
        startupPhase: "http-ready",
      }),
    ).toMatchObject({ httpReady: true, fullyReady: false });
    expect(
      resolveGatewayStartupReadiness({
        ...createGatewayStartupRuntimeState({ safeMode: false, startupPhase: "sidecars-ready" }),
        startupPhase: "sidecars-ready",
      }),
    ).toMatchObject({ sidecarsReady: true, fullyReady: true });
    expect(
      resolveGatewayStartupReadiness({
        ...createGatewayStartupRuntimeState({ safeMode: true, startupPhase: "ready" }),
        startupPhase: "ready",
        channelsSkipped: true,
      }),
    ).toMatchObject({ fullyReady: true, message: "Gateway safe mode startup is ready." });
  });

  it("returns null for missing or invalid state files", () => {
    const env = createTempStateEnv();
    expect(readGatewayStartupRuntimeState(env)).toBeNull();

    fs.writeFileSync(resolveGatewayStartupRuntimeStatePath(env), JSON.stringify({ pid: "bad" }));
    expect(readGatewayStartupRuntimeState(env)).toBeNull();
  });
});
