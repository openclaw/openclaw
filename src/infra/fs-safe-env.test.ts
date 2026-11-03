import { describe, expect, it } from "vitest";
import { clearFsSafeEnvFallback, fsSafeEnvInput, normalizeFsSafeNativeEnv } from "./fs-safe-env.js";

describe("deprecated fs-safe environment modes", () => {
  it.each(["FS_SAFE_PYTHON_MODE", "OPENCLAW_FS_SAFE_PYTHON_MODE"])(
    "preserves raw %s values and retires its derived fallback",
    (key) => {
      const env: NodeJS.ProcessEnv = { [key]: " Required " };
      normalizeFsSafeNativeEnv(env);
      expect(env.OPENCLAW_FS_SAFE_NATIVE_MODE).toBe(" Required ");
      expect(fsSafeEnvInput(env)).toEqual({ [key]: " Required " });
      delete env[key];
      normalizeFsSafeNativeEnv(env);
      expect(env).toEqual({});
    },
  );

  it.each(["FS_SAFE_NATIVE_MODE", "OPENCLAW_FS_SAFE_NATIVE_MODE"])(
    "matches fs-safe's exact native mode normalization in %s",
    (key) => {
      for (const value of [
        "0",
        "false",
        " OFF ",
        "never",
        "1",
        "true",
        "on",
        "auto",
        "required",
        "require",
      ]) {
        const env = { [key]: value, FS_SAFE_PYTHON_MODE: "require" };
        normalizeFsSafeNativeEnv(env);
        expect(env).toEqual({ [key]: value, FS_SAFE_PYTHON_MODE: "require" });
      }
      const env: NodeJS.ProcessEnv = { [key]: "fal\u017fe", FS_SAFE_PYTHON_MODE: "require" };
      normalizeFsSafeNativeEnv(env);
      expect(env.OPENCLAW_FS_SAFE_NATIVE_MODE).toBe("require");
    },
  );

  it.each(["", "invalid", "off"])("keeps first-defined legacy precedence for %j", (value) => {
    const env: NodeJS.ProcessEnv = {
      FS_SAFE_PYTHON_MODE: value,
      OPENCLAW_FS_SAFE_PYTHON_MODE: "require",
    };
    normalizeFsSafeNativeEnv(env);
    expect(env.OPENCLAW_FS_SAFE_NATIVE_MODE).toBe(value);
  });

  it.each([undefined, "invalid"])(
    "restores an existing native input %j when the legacy fallback disappears",
    (previous) => {
      const env: NodeJS.ProcessEnv = {
        OPENCLAW_FS_SAFE_NATIVE_MODE: previous,
        FS_SAFE_PYTHON_MODE: "off",
      };
      normalizeFsSafeNativeEnv(env);
      expect(env.OPENCLAW_FS_SAFE_NATIVE_MODE).toBe("off");
      delete env.FS_SAFE_PYTHON_MODE;
      normalizeFsSafeNativeEnv(env);
      expect(env).toStrictEqual({ OPENCLAW_FS_SAFE_NATIVE_MODE: previous });
    },
  );

  it("keeps case-sensitive environment slots distinct when deriving a native mode", () => {
    const input = { openclaw_fs_safe_native_mode: "invalid", FS_SAFE_PYTHON_MODE: "require" };
    const env: NodeJS.ProcessEnv = { ...input };
    normalizeFsSafeNativeEnv(env);
    expect(env.OPENCLAW_FS_SAFE_NATIVE_MODE).toBe("require");
    expect(env.openclaw_fs_safe_native_mode).toBe("invalid");
    expect(fsSafeEnvInput(env)).toStrictEqual(input);
    clearFsSafeEnvFallback(env);
    expect(env).toStrictEqual(input);
  });

  it("preserves a later real native write while retiring old fallback provenance", () => {
    const env: NodeJS.ProcessEnv = { FS_SAFE_PYTHON_MODE: "require" };
    normalizeFsSafeNativeEnv(env);
    env.OPENCLAW_FS_SAFE_NATIVE_MODE = "off";
    clearFsSafeEnvFallback(env);
    expect(env.OPENCLAW_FS_SAFE_NATIVE_MODE).toBe("off");
    normalizeFsSafeNativeEnv(env);
    expect(fsSafeEnvInput(env)).toBe(env);
  });
});
