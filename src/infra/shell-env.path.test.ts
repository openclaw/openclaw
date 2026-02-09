import { afterEach, describe, expect, it, vi } from "vitest";
import { getShellPathFromLoginShell, resetShellPathCacheForTests } from "./shell-env.js";

describe("getShellPathFromLoginShell", () => {
  afterEach(() => resetShellPathCacheForTests());

  it("returns PATH from login shell env", () => {
    if (process.platform === "win32") {
      return;
    }
    const exec = vi
      .fn()
      .mockReturnValue(Buffer.from("PATH=/custom/bin\0HOME=/home/user\0", "utf-8"));
    const result = getShellPathFromLoginShell({ env: { SHELL: "/bin/sh" }, exec });
    expect(result).toBe("/custom/bin");
  });

  it("caches the value", () => {
    if (process.platform === "win32") {
      return;
    }
    const exec = vi.fn().mockReturnValue(Buffer.from("PATH=/custom/bin\0", "utf-8"));
    const env = { SHELL: "/bin/sh" } as NodeJS.ProcessEnv;
    expect(getShellPathFromLoginShell({ env, exec })).toBe("/custom/bin");
    expect(getShellPathFromLoginShell({ env, exec })).toBe("/custom/bin");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("returns null on exec failure", () => {
    if (process.platform === "win32") {
      return;
    }
    const exec = vi.fn(() => {
      throw new Error("boom");
    });
    const result = getShellPathFromLoginShell({ env: { SHELL: "/bin/sh" }, exec });
    expect(result).toBeNull();
  });
});
