import { describe, expect, it } from "vitest";
import {
  isDangerousHostEnvVarName,
  normalizeEnvVarKey,
  sanitizeHostExecEnv,
} from "./host-env-security.js";

describe("isDangerousHostEnvVarName", () => {
  it("matches dangerous keys and prefixes case-insensitively", () => {
    expect(isDangerousHostEnvVarName("BASH_ENV")).toBe(true);
    expect(isDangerousHostEnvVarName("bash_env")).toBe(true);
    expect(isDangerousHostEnvVarName("DYLD_INSERT_LIBRARIES")).toBe(true);
    expect(isDangerousHostEnvVarName("ld_preload")).toBe(true);
    expect(isDangerousHostEnvVarName("BASH_FUNC_echo%%")).toBe(true);
    expect(isDangerousHostEnvVarName("PATH")).toBe(false);
    expect(isDangerousHostEnvVarName("FOO")).toBe(false);
  });
});

describe("sanitizeHostExecEnv", () => {
  it("removes dangerous inherited keys while preserving PATH", () => {
    const env = sanitizeHostExecEnv({
      baseEnv: {
        PATH: "/usr/bin:/bin",
        BASH_ENV: "/tmp/pwn.sh",
        LD_PRELOAD: "/tmp/pwn.so",
        OK: "1",
      },
    });

    expect(env).toEqual({
      PATH: "/usr/bin:/bin",
      OK: "1",
    });
  });

  it("blocks PATH and dangerous override values", () => {
    const env = sanitizeHostExecEnv({
      baseEnv: {
        PATH: "/usr/bin:/bin",
        HOME: "/tmp/home",
      },
      overrides: {
        PATH: "/tmp/evil",
        BASH_ENV: "/tmp/pwn.sh",
        SAFE: "ok",
      },
    });

    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.BASH_ENV).toBeUndefined();
    expect(env.SAFE).toBe("ok");
    expect(env.HOME).toBe("/tmp/home");
  });

  it("drops non-portable env key names", () => {
    const env = sanitizeHostExecEnv({
      baseEnv: {
        PATH: "/usr/bin:/bin",
      },
      overrides: {
        " BAD KEY": "x",
        "NOT-PORTABLE": "x",
        GOOD_KEY: "ok",
      },
    });

    expect(env.GOOD_KEY).toBe("ok");
    expect(env[" BAD KEY"]).toBeUndefined();
    expect(env["NOT-PORTABLE"]).toBeUndefined();
  });
});

describe("normalizeEnvVarKey", () => {
  it("normalizes and validates keys", () => {
    expect(normalizeEnvVarKey(" OPENROUTER_API_KEY ")).toBe("OPENROUTER_API_KEY");
    expect(normalizeEnvVarKey("NOT-PORTABLE", { portable: true })).toBeNull();
    expect(normalizeEnvVarKey(" BASH_FUNC_echo%% ")).toBe("BASH_FUNC_echo%%");
    expect(normalizeEnvVarKey("   ")).toBeNull();
  });
});
