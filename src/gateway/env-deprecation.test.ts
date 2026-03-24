import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetLegacyEnvWarning, warnLegacyEnvVars } from "./env-deprecation.js";

describe("warnLegacyEnvVars", () => {
  let emitWarningSpy: ReturnType<typeof vi.spyOn>;
  const savedVitest = process.env.VITEST;
  const savedNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    _resetLegacyEnvWarning();
    emitWarningSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    // Disable test-env suppression so we can exercise the warning path.
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    emitWarningSpy.mockRestore();
    // Restore env.
    if (savedVitest !== undefined) {
      process.env.VITEST = savedVitest;
    }
    if (savedNodeEnv !== undefined) {
      process.env.NODE_ENV = savedNodeEnv;
    }
  });

  it("emits warning when CLAWDBOT_GATEWAY_TOKEN is present", () => {
    const env: NodeJS.ProcessEnv = { CLAWDBOT_GATEWAY_TOKEN: "tok123" };
    warnLegacyEnvVars(env);

    expect(emitWarningSpy).toHaveBeenCalledOnce();
    const [message, opts] = emitWarningSpy.mock.calls[0] as [
      string,
      { code: string; type: string },
    ];
    expect(message).toContain("CLAWDBOT_GATEWAY_TOKEN");
    expect(message).toContain("OPENCLAW_GATEWAY_TOKEN");
    expect(opts.code).toBe("OPENCLAW_LEGACY_ENV_VARS");
    expect(opts.type).toBe("DeprecationWarning");
  });

  it("emits warning when MOLTBOT_GATEWAY_PASSWORD is present", () => {
    const env: NodeJS.ProcessEnv = { MOLTBOT_GATEWAY_PASSWORD: "pw" }; // pragma: allowlist secret
    warnLegacyEnvVars(env);

    expect(emitWarningSpy).toHaveBeenCalledOnce();
    const [message] = emitWarningSpy.mock.calls[0] as [string];
    expect(message).toContain("MOLTBOT_GATEWAY_PASSWORD");
    expect(message).toContain("OPENCLAW_GATEWAY_PASSWORD");
  });

  it("does not warn when only OPENCLAW_* vars are present", () => {
    const env: NodeJS.ProcessEnv = { OPENCLAW_GATEWAY_TOKEN: "tok" };
    warnLegacyEnvVars(env);

    expect(emitWarningSpy).not.toHaveBeenCalled();
  });

  it("includes correct OPENCLAW_* replacement in warning message", () => {
    const env: NodeJS.ProcessEnv = {
      CLAWDBOT_STATE_DIR: "/old",
      MOLTBOT_CONFIG_PATH: "/cfg",
    };
    warnLegacyEnvVars(env);

    expect(emitWarningSpy).toHaveBeenCalledOnce();
    const [message] = emitWarningSpy.mock.calls[0] as [string];
    expect(message).toContain("CLAWDBOT_STATE_DIR -> OPENCLAW_STATE_DIR");
    expect(message).toContain("MOLTBOT_CONFIG_PATH -> OPENCLAW_CONFIG_PATH");
  });

  it("only warns once per process (deduplication)", () => {
    const env: NodeJS.ProcessEnv = { CLAWDBOT_GATEWAY_TOKEN: "tok" };
    warnLegacyEnvVars(env);
    warnLegacyEnvVars(env);
    warnLegacyEnvVars(env);

    expect(emitWarningSpy).toHaveBeenCalledOnce();
  });

  it("suppresses warning in test environment (VITEST=true)", () => {
    process.env.VITEST = "true";
    const env: NodeJS.ProcessEnv = { CLAWDBOT_GATEWAY_TOKEN: "tok" };
    warnLegacyEnvVars(env);

    expect(emitWarningSpy).not.toHaveBeenCalled();
  });

  it("suppresses warning in test environment (NODE_ENV=test)", () => {
    process.env.NODE_ENV = "test";
    const env: NodeJS.ProcessEnv = { CLAWDBOT_GATEWAY_TOKEN: "tok" };
    warnLegacyEnvVars(env);

    expect(emitWarningSpy).not.toHaveBeenCalled();
  });
});
