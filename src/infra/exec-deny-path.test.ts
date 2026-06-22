import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateExecDenyPathMatch,
  formatExecDenyPathMessage,
  resolveExecDenyPathPatterns,
  tokenizeShellPayload,
} from "./exec-deny-path.js";

// Build an absolute fake home that is valid on every CI runner (POSIX + win32):
// path.resolve yields a rooted, platform-correct path, and resolveEffectiveHomeDir
// applies the same path.resolve, so the env-driven home matches what the matcher
// expands `~` to. Avoids hardcoded POSIX `/...` literals that are not absolute on
// Windows.
const fakeHome = path.resolve(path.sep, "fake-openclaw-home");

describe("evaluateExecDenyPathMatch", () => {
  it("returns null when no patterns are configured", () => {
    expect(
      evaluateExecDenyPathMatch({
        patterns: [],
        argv: ["cat", "~/.openclaw/secrets/foo.env"],
        homeDir: fakeHome,
      }),
    ).toBeNull();
  });

  it("returns null when no argv element is path-like", () => {
    expect(
      evaluateExecDenyPathMatch({
        patterns: ["**/.env"],
        argv: ["echo", "hello"],
        homeDir: fakeHome,
      }),
    ).toBeNull();
  });

  it("blocks tilde-relative arg matched against tilde pattern", () => {
    const match = evaluateExecDenyPathMatch({
      patterns: ["~/.openclaw/secrets/**"],
      argv: ["cat", "~/.openclaw/secrets/telegram-trader.env"],
      homeDir: fakeHome,
    });
    expect(match).not.toBeNull();
    expect(match?.pattern).toBe("~/.openclaw/secrets/**");
    expect(match?.arg).toBe("~/.openclaw/secrets/telegram-trader.env");
    expect(match?.resolved).toBe(path.join(fakeHome, ".openclaw/secrets/telegram-trader.env"));
  });

  it("blocks absolute arg matched against tilde pattern (resolved form)", () => {
    const absolute = path.join(fakeHome, ".openclaw/secrets/foo.env");
    const match = evaluateExecDenyPathMatch({
      patterns: ["~/.openclaw/secrets/**"],
      argv: ["cat", absolute],
      homeDir: fakeHome,
    });
    expect(match?.pattern).toBe("~/.openclaw/secrets/**");
    expect(match?.arg).toBe(absolute);
    expect(match?.resolved).toBe(absolute);
  });

  it("blocks **/.env style pattern across nested workspaces", () => {
    const match = evaluateExecDenyPathMatch({
      patterns: ["**/.env"],
      argv: ["cat", "/work/projects/web/.env"],
      homeDir: fakeHome,
    });
    expect(match?.pattern).toBe("**/.env");
  });

  it("blocks ssh private keys via ~/.ssh/id_* pattern", () => {
    const match = evaluateExecDenyPathMatch({
      patterns: ["~/.ssh/id_*"],
      argv: ["cat", "~/.ssh/id_rsa"],
      homeDir: fakeHome,
    });
    expect(match?.pattern).toBe("~/.ssh/id_*");
  });

  it("ignores flags that look path-ish like --token=value", () => {
    expect(
      evaluateExecDenyPathMatch({
        patterns: ["**/.env"],
        argv: ["myapp", "--config=foo/.env"],
        homeDir: fakeHome,
      }),
    ).toBeNull();
  });

  it("scans tokens parsed from shellPayload", () => {
    const match = evaluateExecDenyPathMatch({
      patterns: ["~/.openclaw/secrets/**"],
      argv: ["bash", "-c"],
      shellPayload: 'cat "~/.openclaw/secrets/bot.env" >> /tmp/leak',
      homeDir: fakeHome,
    });
    expect(match?.pattern).toBe("~/.openclaw/secrets/**");
  });

  it("resolves cwd-relative args against the cwd before matching", () => {
    const match = evaluateExecDenyPathMatch({
      patterns: ["**/.openclaw/secrets/**"],
      argv: ["cat", "secrets/foo.env"],
      cwd: path.join(fakeHome, ".openclaw"),
      homeDir: fakeHome,
    });
    expect(match?.pattern).toBe("**/.openclaw/secrets/**");
  });

  it("resolves bare cwd-relative sensitive filenames against the cwd before matching", () => {
    const match = evaluateExecDenyPathMatch({
      patterns: ["**/.env"],
      argv: ["cat", ".env"],
      cwd: "/work/project",
      homeDir: fakeHome,
    });
    expect(match?.pattern).toBe("**/.env");
    expect(match?.resolved).toBe("/work/project/.env");
  });

  it("denies a bare relative basename via a globstar pattern even without a cwd", () => {
    // Regression for #74379 review: `**/.env` is documented as a hard-deny
    // example and must block `cat .env` on the no-cwd node-host path, where the
    // gateway forwards no workdir. A globstar matches zero leading segments, so
    // the bare basename is denied without resolving it against any assumed cwd.
    const match = evaluateExecDenyPathMatch({
      patterns: ["**/.env"],
      argv: ["cat", ".env"],
      homeDir: fakeHome,
    });
    expect(match?.pattern).toBe("**/.env");
    expect(match?.arg).toBe(".env");
  });

  it("does not match unrelated files in the same workspace", () => {
    expect(
      evaluateExecDenyPathMatch({
        patterns: ["~/.openclaw/secrets/**"],
        argv: ["cat", "~/work/notes.md"],
        homeDir: fakeHome,
      }),
    ).toBeNull();
  });

  it("ignores empty/whitespace pattern entries", () => {
    expect(
      evaluateExecDenyPathMatch({
        patterns: ["", "  ", "**/.env"],
        argv: ["cat", "/a/b/.env"],
        homeDir: fakeHome,
      })?.pattern,
    ).toBe("**/.env");
  });
});

// Win32-specific behavior is exercised here on POSIX hosts by passing
// pre-normalized paths and patterns that exercise the cross-platform
// matcher; full mocking of process.platform requires environment setup
// outside the scope of this unit test file.
describe("evaluateExecDenyPathMatch (cross-platform shape)", () => {
  it("matches paths regardless of forward/backward slashes via normalization", () => {
    // Mixed-style pattern + path: the matcher normalizes both sides to
    // forward slashes, so a Linux-style pattern still catches a Windows-style
    // candidate path on POSIX hosts.
    const match = evaluateExecDenyPathMatch({
      patterns: ["**/secrets/**"],
      argv: ["type", "/c/users/alice/secrets/foo.env"],
      homeDir: "/c/users/alice",
    });
    expect(match?.pattern).toBe("**/secrets/**");
  });

  it("matches a Windows-style argv path token against a POSIX deny pattern", () => {
    // A discrete argv token carrying backslashes (e.g. forwarded from a Windows
    // node) is normalized `\`->`/` and caught by a POSIX-style pattern even when
    // this code runs on a POSIX host. Argv tokens skip the shell tokenizer, so
    // the backslashes are never consumed as escapes (#74379 P1).
    const match = evaluateExecDenyPathMatch({
      patterns: ["**/.ssh/*"],
      argv: ["type", "C:\\Users\\alice\\.ssh\\id_rsa"],
      homeDir: "/c/users/alice",
    });
    expect(match?.pattern).toBe("**/.ssh/*");
  });
});

describe("formatExecDenyPathMessage", () => {
  it("renders a stable SYSTEM_RUN_DENIED format", () => {
    const message = formatExecDenyPathMessage({
      pattern: "**/.env",
      arg: "/work/.env",
      resolved: "/work/.env",
    });
    expect(message).toBe(
      'SYSTEM_RUN_DENIED: argument matches tools.exec.denyPathPatterns (pattern="**/.env", arg="/work/.env")',
    );
  });
});

describe("resolveExecDenyPathPatterns", () => {
  it("merges global and agent patterns as a deduped union", () => {
    expect(
      resolveExecDenyPathPatterns({
        global: ["**/.env", "~/.ssh/id_*"],
        agent: ["**/.env", "**/credentials.json"],
      }),
    ).toEqual(["**/.env", "~/.ssh/id_*", "**/credentials.json"]);
  });

  it("ignores non-string and empty entries on both sides", () => {
    expect(
      resolveExecDenyPathPatterns({
        global: ["**/.env", "  ", undefined as unknown as string],
        agent: [42 as unknown as string, ""],
      }),
    ).toEqual(["**/.env"]);
  });

  it("returns [] when no patterns are configured anywhere", () => {
    expect(resolveExecDenyPathPatterns({})).toEqual([]);
  });
});

describe("tokenizeShellPayload", () => {
  it("respects single and double quotes", () => {
    expect(tokenizeShellPayload(`cat "~/.openclaw/secrets/foo.env" 'with space.txt'`)).toEqual([
      "cat",
      "~/.openclaw/secrets/foo.env",
      "with space.txt",
    ]);
  });

  it("handles backslash escapes outside single quotes", () => {
    expect(tokenizeShellPayload("cat foo\\ bar.env")).toEqual(["cat", "foo bar.env"]);
  });

  it("splits unquoted shell operators away from adjacent path tokens", () => {
    expect(
      tokenizeShellPayload("cat ~/.openclaw/secrets/foo.env; echo ok && cat .env>/tmp/leak"),
    ).toEqual(["cat", "~/.openclaw/secrets/foo.env", "echo", "ok", "cat", ".env", "/tmp/leak"]);
  });

  it("returns [] for empty payload", () => {
    expect(tokenizeShellPayload("")).toEqual([]);
  });
});

// Smoke checks for the home-dir resolver integration.
describe("evaluateExecDenyPathMatch (home dir resolution)", () => {
  // resolveEffectiveHomeDir runs path.resolve on the env value, so the argv
  // candidate is built with path.join from the same resolved base. This stays
  // cross-platform (the home is an absolute, rooted path on POSIX and win32)
  // without touching the filesystem — resolveEffectiveHomeDir honors the env
  // var without any fs existence check.
  const isolatedHome = path.resolve(path.sep, "fake-openclaw-home-12345");

  it("resolves env.HOME via the shared home-dir resolver", () => {
    const match = evaluateExecDenyPathMatch({
      patterns: ["~/openclaw-deny-test-marker/**"],
      argv: ["cat", path.join(isolatedHome, "openclaw-deny-test-marker", "x")],
      env: { HOME: isolatedHome } as NodeJS.ProcessEnv,
    });
    expect(match?.pattern).toBe("~/openclaw-deny-test-marker/**");
  });

  it("honors OPENCLAW_HOME via the shared home-dir resolver", () => {
    const match = evaluateExecDenyPathMatch({
      patterns: ["~/.openclaw/secrets/**"],
      argv: ["cat", path.join(isolatedHome, ".openclaw", "secrets", "foo.env")],
      env: { OPENCLAW_HOME: isolatedHome } as NodeJS.ProcessEnv,
    });
    expect(match?.pattern).toBe("~/.openclaw/secrets/**");
  });
});
