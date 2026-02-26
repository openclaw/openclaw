import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isDangerousHostEnvOverrideVarName,
  isDangerousHostEnvVarName,
  normalizeEnvVarKey,
  sanitizeHostExecEnv,
  sanitizeSystemRunEnvOverrides,
} from "./host-env-security.js";

describe("isDangerousHostEnvVarName", () => {
  it("matches dangerous keys and prefixes case-insensitively", () => {
    expect(isDangerousHostEnvVarName("BASH_ENV")).toBe(true);
    expect(isDangerousHostEnvVarName("bash_env")).toBe(true);
    expect(isDangerousHostEnvVarName("SHELL")).toBe(true);
    expect(isDangerousHostEnvVarName("GIT_EXTERNAL_DIFF")).toBe(true);
    expect(isDangerousHostEnvVarName("SHELLOPTS")).toBe(true);
    expect(isDangerousHostEnvVarName("ps4")).toBe(true);
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
        GIT_EXTERNAL_DIFF: "/tmp/pwn.sh",
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
        HOME: "/tmp/trusted-home",
        ZDOTDIR: "/tmp/trusted-zdotdir",
      },
      overrides: {
        PATH: "/tmp/evil",
        HOME: "/tmp/evil-home",
        ZDOTDIR: "/tmp/evil-zdotdir",
        BASH_ENV: "/tmp/pwn.sh",
        SHELLOPTS: "xtrace",
        PS4: "$(touch /tmp/pwned)",
        SAFE: "ok",
      },
    });

    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.BASH_ENV).toBeUndefined();
    expect(env.SHELLOPTS).toBeUndefined();
    expect(env.PS4).toBeUndefined();
    expect(env.SAFE).toBe("ok");
    expect(env.HOME).toBe("/tmp/trusted-home");
    expect(env.ZDOTDIR).toBe("/tmp/trusted-zdotdir");
  });

  it("drops dangerous inherited shell trace keys", () => {
    const env = sanitizeHostExecEnv({
      baseEnv: {
        PATH: "/usr/bin:/bin",
        SHELLOPTS: "xtrace",
        PS4: "$(touch /tmp/pwned)",
        OK: "1",
      },
    });

    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.OK).toBe("1");
    expect(env.SHELLOPTS).toBeUndefined();
    expect(env.PS4).toBeUndefined();
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

describe("isDangerousHostEnvOverrideVarName", () => {
  it("matches override-only blocked keys case-insensitively", () => {
    expect(isDangerousHostEnvOverrideVarName("HOME")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("zdotdir")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("BASH_ENV")).toBe(false);
    expect(isDangerousHostEnvOverrideVarName("FOO")).toBe(false);
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

describe("sanitizeSystemRunEnvOverrides", () => {
  it("keeps overrides for non-shell commands", () => {
    const overrides = sanitizeSystemRunEnvOverrides({
      shellWrapper: false,
      overrides: {
        OPENCLAW_TEST: "1",
        TOKEN: "abc",
      },
    });
    expect(overrides).toEqual({
      OPENCLAW_TEST: "1",
      TOKEN: "abc",
    });
  });

  it("drops non-allowlisted overrides for shell wrappers", () => {
    const overrides = sanitizeSystemRunEnvOverrides({
      shellWrapper: true,
      overrides: {
        OPENCLAW_TEST: "1",
        TOKEN: "abc",
        LANG: "C",
        LC_ALL: "C",
      },
    });
    expect(overrides).toEqual({
      LANG: "C",
      LC_ALL: "C",
    });
  });
});

describe("shell wrapper exploit regression", () => {
  it("blocks SHELLOPTS/PS4 chain after sanitization", async () => {
    const bashPath = "/bin/bash";
    if (process.platform === "win32" || !fs.existsSync(bashPath)) {
      return;
    }
    const marker = path.join(os.tmpdir(), `openclaw-ps4-marker-${process.pid}-${Date.now()}`);
    try {
      fs.unlinkSync(marker);
    } catch {
      // no-op
    }

    const filteredOverrides = sanitizeSystemRunEnvOverrides({
      shellWrapper: true,
      overrides: {
        SHELLOPTS: "xtrace",
        PS4: `$(touch ${marker})`,
      },
    });
    const env = sanitizeHostExecEnv({
      overrides: filteredOverrides,
      baseEnv: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
      },
    });

    await new Promise<void>((resolve, reject) => {
      const child = spawn(bashPath, ["-lc", "echo SAFE"], { env, stdio: "ignore" });
      child.once("error", reject);
      child.once("close", () => resolve());
    });

    expect(fs.existsSync(marker)).toBe(false);
  });
});
