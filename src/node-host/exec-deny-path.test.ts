import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateExecDenyPathMatch,
  formatExecDenyPathMessage,
  resolveExecDenyPathPatterns,
  tokenizeShellPayload,
} from "./exec-deny-path.js";

const fakeHome = "/Users/hani";
const homedir = () => fakeHome;

describe("evaluateExecDenyPathMatch", () => {
  it("returns null when no patterns are configured", () => {
    expect(
      evaluateExecDenyPathMatch({
        patterns: [],
        argv: ["cat", "~/.openclaw/secrets/foo.env"],
        homedir,
      }),
    ).toBeNull();
  });

  it("returns null when no argv element is path-like", () => {
    expect(
      evaluateExecDenyPathMatch({
        patterns: ["**/.env"],
        argv: ["echo", "hello"],
        homedir,
      }),
    ).toBeNull();
  });

  it("blocks tilde-relative arg matched against tilde pattern", () => {
    const match = evaluateExecDenyPathMatch({
      patterns: ["~/.openclaw/secrets/**"],
      argv: ["cat", "~/.openclaw/secrets/telegram-trader.env"],
      homedir,
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
      homedir,
    });
    expect(match?.pattern).toBe("~/.openclaw/secrets/**");
    expect(match?.arg).toBe(absolute);
    expect(match?.resolved).toBe(absolute);
  });

  it("blocks **/.env style pattern across nested workspaces", () => {
    const match = evaluateExecDenyPathMatch({
      patterns: ["**/.env"],
      argv: ["cat", "/work/projects/web/.env"],
      homedir,
    });
    expect(match?.pattern).toBe("**/.env");
  });

  it("blocks ssh private keys via ~/.ssh/id_* pattern", () => {
    const match = evaluateExecDenyPathMatch({
      patterns: ["~/.ssh/id_*"],
      argv: ["cat", "~/.ssh/id_rsa"],
      homedir,
    });
    expect(match?.pattern).toBe("~/.ssh/id_*");
  });

  it("ignores flags that look path-ish like --token=value", () => {
    expect(
      evaluateExecDenyPathMatch({
        patterns: ["**/.env"],
        argv: ["myapp", "--config=foo/.env"],
        homedir,
      }),
    ).toBeNull();
  });

  it("scans tokens parsed from shellPayload", () => {
    const match = evaluateExecDenyPathMatch({
      patterns: ["~/.openclaw/secrets/**"],
      argv: ["bash", "-c"],
      shellPayload: 'cat "~/.openclaw/secrets/bot.env" >> /tmp/leak',
      homedir,
    });
    expect(match?.pattern).toBe("~/.openclaw/secrets/**");
  });

  it("resolves cwd-relative args against the cwd before matching", () => {
    const match = evaluateExecDenyPathMatch({
      patterns: ["**/.openclaw/secrets/**"],
      argv: ["cat", "secrets/foo.env"],
      cwd: path.join(fakeHome, ".openclaw"),
      homedir,
    });
    expect(match?.pattern).toBe("**/.openclaw/secrets/**");
  });

  it("does not match unrelated files in the same workspace", () => {
    expect(
      evaluateExecDenyPathMatch({
        patterns: ["~/.openclaw/secrets/**"],
        argv: ["cat", "~/work/notes.md"],
        homedir,
      }),
    ).toBeNull();
  });

  it("ignores empty/whitespace pattern entries", () => {
    expect(
      evaluateExecDenyPathMatch({
        patterns: ["", "  ", "**/.env"],
        argv: ["cat", "/a/b/.env"],
        homedir,
      })?.pattern,
    ).toBe("**/.env");
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

  it("returns [] for empty payload", () => {
    expect(tokenizeShellPayload("")).toEqual([]);
  });
});

// Smoke check that os.homedir() default works (no specific path expectation).
describe("evaluateExecDenyPathMatch (default homedir)", () => {
  it("uses os.homedir when not explicitly passed", () => {
    const real = os.homedir();
    const match = evaluateExecDenyPathMatch({
      patterns: ["~/openclaw-deny-test-marker/**"],
      argv: ["cat", path.join(real, "openclaw-deny-test-marker", "x")],
    });
    expect(match?.pattern).toBe("~/openclaw-deny-test-marker/**");
  });
});
