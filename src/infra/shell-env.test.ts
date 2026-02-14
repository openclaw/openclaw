import { describe, expect, it, vi } from "vitest";
import {
  buildEnvDumpCommand,
  loadShellEnvFallback,
  resolveShellEnvFallbackTimeoutMs,
  shouldEnableShellEnvFallback,
} from "./shell-env.js";

describe("shell env fallback", () => {
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
});

describe("buildEnvDumpCommand", () => {
  it("returns zshrc-sourcing command for zsh", () => {
    const cmd = buildEnvDumpCommand("/bin/zsh");
    expect(cmd).toBe('{ . "$HOME/.zshrc"; } >/dev/null 2>&1 || true; env -0');
  });

  it("returns bashrc-sourcing command for bash", () => {
    const cmd = buildEnvDumpCommand("/bin/bash");
    expect(cmd).toBe('{ . "$HOME/.bashrc"; } >/dev/null 2>&1 || true; env -0');
  });

  it("returns config.fish-sourcing command for fish", () => {
    const cmd = buildEnvDumpCommand("/usr/bin/fish");
    expect(cmd).toBe(
      'set -q XDG_CONFIG_HOME; or set -l XDG_CONFIG_HOME "$HOME/.config"; source "$XDG_CONFIG_HOME/fish/config.fish" 2>/dev/null; env -0',
    );
  });

  it("returns kshrc-sourcing command for ksh variants", () => {
    const expected = '{ . "$HOME/.kshrc"; } >/dev/null 2>&1 || true; env -0';
    expect(buildEnvDumpCommand("/bin/ksh")).toBe(expected);
    expect(buildEnvDumpCommand("/usr/bin/ksh93")).toBe(expected);
    expect(buildEnvDumpCommand("/usr/local/bin/mksh")).toBe(expected);
  });

  it("returns csh-family sourcing commands for tcsh and csh", () => {
    expect(buildEnvDumpCommand("/bin/tcsh")).toBe(
      "source ~/.tcshrc >& /dev/null; source ~/.cshrc >& /dev/null; env -0",
    );
    expect(buildEnvDumpCommand("/bin/csh")).toBe("source ~/.cshrc >& /dev/null; env -0");
  });

  it("falls through to default for dash and ash", () => {
    const expected =
      'for f in "$HOME/.bashrc" "$HOME/.zshrc"; do [ -f "$f" ] && . "$f" >/dev/null 2>&1 || true; done; env -0';
    expect(buildEnvDumpCommand("/bin/dash")).toBe(expected);
    expect(buildEnvDumpCommand("/bin/ash")).toBe(expected);
  });

  it("returns external env call for nushell", () => {
    expect(buildEnvDumpCommand("/usr/bin/nu")).toBe("^env -0");
  });

  it("returns rc.elv-sourcing command for elvish", () => {
    expect(buildEnvDumpCommand("/usr/local/bin/elvish")).toBe(
      "try { eval (slurp < ~/.config/elvish/rc.elv) } catch e { nop }; env -0",
    );
  });

  it("returns plain env -0 for xonsh (login sources xonshrc)", () => {
    expect(buildEnvDumpCommand("/usr/bin/xonsh")).toBe("env -0");
  });

  it("returns profile-sourcing command for pwsh/powershell", () => {
    const expected = "try { . $PROFILE } catch {}; & env -0";
    expect(buildEnvDumpCommand("/usr/local/bin/pwsh")).toBe(expected);
    expect(buildEnvDumpCommand("/usr/bin/powershell")).toBe(expected);
  });

  it("returns both RC files for unknown shells", () => {
    const cmd = buildEnvDumpCommand("/bin/sh");
    expect(cmd).toBe(
      'for f in "$HOME/.bashrc" "$HOME/.zshrc"; do [ -f "$f" ] && . "$f" >/dev/null 2>&1 || true; done; env -0',
    );
  });

  it("handles full paths with nested directories", () => {
    expect(buildEnvDumpCommand("/usr/local/bin/zsh")).toBe(
      '{ . "$HOME/.zshrc"; } >/dev/null 2>&1 || true; env -0',
    );
    expect(buildEnvDumpCommand("/opt/homebrew/bin/bash")).toBe(
      '{ . "$HOME/.bashrc"; } >/dev/null 2>&1 || true; env -0',
    );
  });
});

describe("loadShellEnvFallback sources RC files", () => {
  it("passes zshrc-sourcing command to exec for zsh shell", () => {
    const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh" };
    const exec = vi.fn(() => Buffer.from("MY_KEY=val\0"));

    loadShellEnvFallback({
      enabled: true,
      env,
      expectedKeys: ["MY_KEY"],
      exec: exec as unknown as Parameters<typeof loadShellEnvFallback>[0]["exec"],
    });

    expect(exec).toHaveBeenCalledTimes(1);
    const args = exec.mock.calls[0];
    expect(args[0]).toBe("/bin/zsh");
    expect(args[1]).toEqual(["-l", "-c", '{ . "$HOME/.zshrc"; } >/dev/null 2>&1 || true; env -0']);
  });

  it("passes bashrc-sourcing command to exec for bash shell", () => {
    const env: NodeJS.ProcessEnv = { SHELL: "/bin/bash" };
    const exec = vi.fn(() => Buffer.from("MY_KEY=val\0"));

    loadShellEnvFallback({
      enabled: true,
      env,
      expectedKeys: ["MY_KEY"],
      exec: exec as unknown as Parameters<typeof loadShellEnvFallback>[0]["exec"],
    });

    expect(exec).toHaveBeenCalledTimes(1);
    const args = exec.mock.calls[0];
    expect(args[0]).toBe("/bin/bash");
    expect(args[1]).toEqual(["-l", "-c", '{ . "$HOME/.bashrc"; } >/dev/null 2>&1 || true; env -0']);
  });
});
