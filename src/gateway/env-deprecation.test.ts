import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetLegacyOpenClawEnvWarningForTest,
  warnLegacyOpenClawEnvVars,
} from "./env-deprecation.js";

describe("warnLegacyOpenClawEnvVars", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalVitest = process.env.VITEST;
  let emitWarning: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetLegacyOpenClawEnvWarningForTest();
    emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    delete process.env.NODE_ENV;
    delete process.env.VITEST;
  });

  afterEach(() => {
    emitWarning.mockRestore();
    resetLegacyOpenClawEnvWarningForTest();
    restoreEnv("NODE_ENV", originalNodeEnv);
    restoreEnv("VITEST", originalVitest);
  });

  it("warns with OPENCLAW replacements for legacy prefixes", () => {
    warnLegacyOpenClawEnvVars({
      CLAWDBOT_GATEWAY_TOKEN: "old-token",
      MOLTBOT_GATEWAY_PASSWORD: "old-password", // pragma: allowlist secret
    });

    expect(emitWarning).toHaveBeenCalledOnce();
    const [message, options] = emitWarning.mock.calls[0] as [
      string,
      { code: string; type: string },
    ];
    expect(message).toContain("CLAWDBOT_GATEWAY_TOKEN -> OPENCLAW_GATEWAY_TOKEN");
    expect(message).toContain("MOLTBOT_GATEWAY_PASSWORD -> OPENCLAW_GATEWAY_PASSWORD");
    expect(options).toEqual({
      code: "OPENCLAW_LEGACY_ENV_VARS",
      type: "DeprecationWarning",
    });
  });

  it("does not warn for current OPENCLAW names", () => {
    warnLegacyOpenClawEnvVars({ OPENCLAW_GATEWAY_TOKEN: "token" });

    expect(emitWarning).not.toHaveBeenCalled();
  });

  it("warns only once after a successful emit", () => {
    warnLegacyOpenClawEnvVars({ CLAWDBOT_GATEWAY_TOKEN: "old-token" });
    warnLegacyOpenClawEnvVars({ MOLTBOT_GATEWAY_TOKEN: "old-token" });

    expect(emitWarning).toHaveBeenCalledOnce();
  });

  it("retries if emitWarning throws before the warning is emitted", () => {
    emitWarning
      .mockImplementationOnce(() => {
        throw new Error("warning sink failed");
      })
      .mockImplementationOnce(() => {});

    expect(() => warnLegacyOpenClawEnvVars({ CLAWDBOT_GATEWAY_TOKEN: "old-token" })).toThrow(
      "warning sink failed",
    );
    warnLegacyOpenClawEnvVars({ CLAWDBOT_GATEWAY_TOKEN: "old-token" });

    expect(emitWarning).toHaveBeenCalledTimes(2);
  });

  it("suppresses warning noise in tests", () => {
    process.env.VITEST = "true";

    warnLegacyOpenClawEnvVars({ CLAWDBOT_GATEWAY_TOKEN: "old-token" });

    expect(emitWarning).not.toHaveBeenCalled();
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
