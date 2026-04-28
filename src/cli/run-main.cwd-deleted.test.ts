import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shouldLoadCliDotEnv } from "./run-main.js";

describe("shouldLoadCliDotEnv (#73676)", () => {
  let originalCwd: typeof process.cwd;

  beforeEach(() => {
    originalCwd = process.cwd;
  });

  afterEach(() => {
    process.cwd = originalCwd;
    vi.restoreAllMocks();
  });

  it("does not crash when process.cwd() throws ENOENT (deleted working directory)", () => {
    // Regression for #73676: `process.cwd()` throws
    // `Error: ENOENT: no such file or directory, uv_cwd` when the current
    // working directory has been removed (cd into a directory, delete it
    // from another shell, then run any CLI command). Before this fix the
    // throw escaped through `shouldLoadCliDotEnv` and aborted the entire
    // CLI before any command — including `openclaw tui` — could run.
    //
    // The function must instead treat the throw as "no cwd-local .env"
    // and fall through to the state-dir check.
    process.cwd = () => {
      const error = new Error("ENOENT: no such file or directory, uv_cwd") as Error & {
        code?: string;
      };
      error.code = "ENOENT";
      throw error;
    };

    expect(() =>
      shouldLoadCliDotEnv({ OPENCLAW_STATE_DIR: "/tmp/this-state-dir-does-not-exist-73676" }),
    ).not.toThrow();
    // No state-dir .env either, so result is false but the call returns cleanly.
    expect(
      shouldLoadCliDotEnv({ OPENCLAW_STATE_DIR: "/tmp/this-state-dir-does-not-exist-73676" }),
    ).toBe(false);
  });
});
