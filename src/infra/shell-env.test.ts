import fs from "node:fs";
import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  getShellPathFromLoginShell,
  loadShellEnvFallback,
  resetShellPathCacheForTests,
  resolveShellEnvFallbackTimeoutMs,
  shouldEnableShellEnvFallback,
} from "./shell-env.js";

describe("shell env fallback", () => {
  function getShellPathTwice(params: {
    exec: Parameters<typeof getShellPathFromLoginShell>[0]["exec"];
    platform: NodeJS.Platform;
  }) {
    const first = getShellPathFromLoginShell({
      env: {} as NodeJS.ProcessEnv,
      exec: params.exec,
      platform: params.platform,
    });
    const second = getShellPathFromLoginShell({
      env: {} as NodeJS.ProcessEnv,
      exec: params.exec,
      platform: params.platform,
    });
    return { first, second };
  }

  function runShellEnvFallbackForShell(shell: string) {
    const env: NodeJS.ProcessEnv = { SHELL: shell };
    const exec = vi.fn(() => Buffer.from("OPENAI_API_KEY=from-shell\0"));
    const res = loadShellEnvFallback({
      enabled: true,
      env,
      expectedKeys: ["OPENAI_API_KEY"],
      exec: exec as unknown as Parameters<typeof loadShellEnvFallback>[0]["exec"],
    });
    return { res, exec };
  }

  function makeUnsafeStartupEnv(): NodeJS.ProcessEnv {
    return {
      SHELL: "/bin/bash",
      HOME: "/tmp/evil-home",
      ZDOTDIR: "/tmp/evil-zdotdir",
      BASH_ENV: "/tmp/evil-bash-env",
      PS4: "$(touch /tmp/pwned)",
    };
  }

  function expectSanitizedStartupEnv(receivedEnv: NodeJS.ProcessEnv | undefined) {
    expect(receivedEnv).toBeDefined();
    expect(receivedEnv?.BASH_ENV).toBeUndefined();
    expect(receivedEnv?.PS4).toBeUndefined();
    expect(receivedEnv?.ZDOTDIR).toBeUndefined();
    expect(receivedEnv?.SHELL).toBeUndefined();
    expect(receivedEnv?.HOME).toBe(os.homedir());
  }

  it("is disabled by default", () => {
    expect(shouldEnableShellEnvFallback({} as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldEnableShellEnvFallback({ OPENCLAW_LOAD_SHELL_ENV: "0" })).toBe(false);
    expect(shouldEnableShellEnvFallback({ OPENCLAW_LOAD_SHELL_ENV: "1" })).toBe(true);
  });

  it("resolves timeout from env with default fallback", () => {
    expect(resolveShellEnvFallbackTimeoutMs({} as NodeJS.ProcessEnv)).toBe(15000);
    expect(resolveShellEnvFallbackTimeoutMs({ OPENCLAW_SHELL_ENV_TIMEOUT_MS: "42" })).toBe(42);
    expect(
      resolveShellEnvFallbackTimeoutMs({
        OPENCLAW_SHELL_ENV_TIMEOUT_MS: "nope",
      }),
    ).toBe(15000);
  });

  it("skips when already has an expected key", () => {
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "set" };
    const exec = vi.fn(() => Buffer.from(""));

    const res = loadShellEnvFallback({
      enabled: true,
      env,
      expectedKeys: ["OPENAI_API_KEY", "DISCORD_BOT_TOKEN"],
      exec: exec as unknown as Parameters<typeof loadShellEnvFallback>[0]["exec"],
    });

    expect(res.ok).toBe(true);
    expect(res.applied).toEqual([]);
    expect(res.ok && res.skippedReason).toBe("already-has-keys");
    expect(exec).not.toHaveBeenCalled();
  });

  it("imports expected keys without overriding existing env", () => {
    const env: NodeJS.ProcessEnv = {};
    const exec = vi.fn(() => Buffer.from("OPENAI_API_KEY=from-shell\0DISCORD_BOT_TOKEN=discord\0"));

    const res1 = loadShellEnvFallback({
      enabled: true,
      env,
      expectedKeys: ["OPENAI_API_KEY", "DISCORD_BOT_TOKEN"],
      exec: exec as unknown as Parameters<typeof loadShellEnvFallback>[0]["exec"],
    });

    expect(res1.ok).toBe(true);
    expect(env.OPENAI_API_KEY).toBe("from-shell");
    expect(env.DISCORD_BOT_TOKEN).toBe("discord");
    expect(exec).toHaveBeenCalledTimes(1);

    env.OPENAI_API_KEY = "from-parent";
    const exec2 = vi.fn(() =>
      Buffer.from("OPENAI_API_KEY=from-shell\0DISCORD_BOT_TOKEN=discord2\0"),
    );
    const res2 = loadShellEnvFallback({
      enabled: true,
      env,
      expectedKeys: ["OPENAI_API_KEY", "DISCORD_BOT_TOKEN"],
      exec: exec2 as unknown as Parameters<typeof loadShellEnvFallback>[0]["exec"],
    });

    expect(res2.ok).toBe(true);
    expect(env.OPENAI_API_KEY).toBe("from-parent");
    expect(env.DISCORD_BOT_TOKEN).toBe("discord");
    expect(exec2).not.toHaveBeenCalled();
  });

  it("resolves PATH via login shell and caches it", () => {
    resetShellPathCacheForTests();
    const exec = vi.fn(() => Buffer.from("PATH=/usr/local/bin:/usr/bin\0HOME=/tmp\0"));

    const { first, second } = getShellPathTwice({
      exec: exec as unknown as Parameters<typeof getShellPathFromLoginShell>[0]["exec"],
      platform: "linux",
    });

    expect(first).toBe("/usr/local/bin:/usr/bin");
    expect(second).toBe("/usr/local/bin:/usr/bin");
    expect(exec).toHaveBeenCalledOnce();
  });

  it("returns null on shell env read failure and caches null", () => {
    resetShellPathCacheForTests();
    const exec = vi.fn(() => {
      throw new Error("exec failed");
    });

    const { first, second } = getShellPathTwice({
      exec: exec as unknown as Parameters<typeof getShellPathFromLoginShell>[0]["exec"],
      platform: "linux",
    });

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(exec).toHaveBeenCalledOnce();
  });

  it("falls back to /bin/sh when SHELL is non-absolute", () => {
    const { res, exec } = runShellEnvFallbackForShell("zsh");

    expect(res.ok).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("/bin/sh", ["-l", "-c", "env -0"], expect.any(Object));
  });

  it("falls back to /bin/sh when SHELL points to an untrusted path", () => {
    const { res, exec } = runShellEnvFallbackForShell("/tmp/evil-shell");

    expect(res.ok).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("/bin/sh", ["-l", "-c", "env -0"], expect.any(Object));
  });

  it("uses trusted absolute SHELL path when executable on posix-style paths", () => {
    const accessSyncSpy = vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);
    try {
      const trustedShell = "/usr/bin/zsh-trusted";
      const { res, exec } = runShellEnvFallbackForShell(trustedShell);
      const expectedShell = process.platform === "win32" ? "/bin/sh" : trustedShell;

      expect(res.ok).toBe(true);
      expect(exec).toHaveBeenCalledTimes(1);
      expect(exec).toHaveBeenCalledWith(expectedShell, ["-l", "-c", "env -0"], expect.any(Object));
    } finally {
      accessSyncSpy.mockRestore();
    }
  });

  it("sanitizes startup-related env vars before shell fallback exec", () => {
    const env = makeUnsafeStartupEnv();
    let receivedEnv: NodeJS.ProcessEnv | undefined;
    const exec = vi.fn((_shell: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      receivedEnv = options.env;
      return Buffer.from("OPENAI_API_KEY=from-shell\0");
    });

    const res = loadShellEnvFallback({
      enabled: true,
      env,
      expectedKeys: ["OPENAI_API_KEY"],
      exec: exec as unknown as Parameters<typeof loadShellEnvFallback>[0]["exec"],
    });

    expect(res.ok).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
    expectSanitizedStartupEnv(receivedEnv);
  });

  it("sanitizes startup-related env vars before login-shell PATH probe", () => {
    resetShellPathCacheForTests();
    const env = makeUnsafeStartupEnv();
    let receivedEnv: NodeJS.ProcessEnv | undefined;
    const exec = vi.fn((_shell: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      receivedEnv = options.env;
      return Buffer.from("PATH=/usr/local/bin:/usr/bin\0HOME=/tmp\0");
    });

    const result = getShellPathFromLoginShell({
      env,
      exec: exec as unknown as Parameters<typeof getShellPathFromLoginShell>[0]["exec"],
      platform: "linux",
    });

    expect(result).toBe("/usr/local/bin:/usr/bin");
    expect(exec).toHaveBeenCalledTimes(1);
    expectSanitizedStartupEnv(receivedEnv);
  });

  it("returns null without invoking shell on win32", () => {
    resetShellPathCacheForTests();
    const exec = vi.fn(() => Buffer.from("PATH=/usr/local/bin:/usr/bin\0HOME=/tmp\0"));

    const { first, second } = getShellPathTwice({
      exec: exec as unknown as Parameters<typeof getShellPathFromLoginShell>[0]["exec"],
      platform: "win32",
    });

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });
});
