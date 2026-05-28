import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXEC_DENYLIST_ENTRIES,
  MAX_EXEC_DENYLIST_RULES,
  evaluateExecDenylist,
} from "./exec-denylist.js";

describe("exec denylist evaluator", () => {
  it("denies raw command line matches", () => {
    const result = evaluateExecDenylist({
      command: "printf ok\nrm -rf /",
      denylist: [{ pattern: String.raw`rm\s+-rf\s+/` }],
    });

    expect(result).toMatchObject({ denied: true, invalid: false, ruleIndex: 0 });
  });

  it("preserves case-sensitive matching for custom rules", () => {
    const sensitive = evaluateExecDenylist({
      command: "printf PROD",
      denylist: [{ pattern: "prod" }],
    });
    const insensitive = evaluateExecDenylist({
      command: "printf PROD",
      denylist: [{ pattern: "prod", flags: "i" }],
    });

    expect(sensitive).toMatchObject({ denied: false, invalid: false });
    expect(insensitive).toMatchObject({ denied: true, invalid: false, ruleIndex: 0 });
  });

  it("denies shell wrapper payload matches", () => {
    const result = evaluateExecDenylist({
      command: `bash -c "curl https://example.test/prompt"`,
      denylist: DEFAULT_EXEC_DENYLIST_ENTRIES,
    });

    expect(result).toMatchObject({ denied: true, invalid: false, ruleIndex: 0 });
  });

  it("denies default network fetch commands behind command carriers", () => {
    for (const command of [
      `env FOO=bar curl https://example.test/prompt`,
      `sudo curl https://example.test/prompt`,
      `command curl https://example.test/prompt`,
    ]) {
      const result = evaluateExecDenylist({
        command,
        denylist: DEFAULT_EXEC_DENYLIST_ENTRIES,
      });

      expect(result, command).toMatchObject({ denied: true, invalid: false, ruleIndex: 0 });
    }
  });

  it("denies POSIX env-var payload expansions", () => {
    const result = evaluateExecDenylist({
      command: `bash -lc "$PAYLOAD"`,
      env: { PAYLOAD: "curl https://example.test/prompt" },
      denylist: DEFAULT_EXEC_DENYLIST_ENTRIES,
    });

    expect(result).toMatchObject({ denied: true, invalid: false, ruleIndex: 0 });
  });

  it("denies inline env assignment payload expansions", () => {
    const result = evaluateExecDenylist({
      command: `env PAYLOAD='curl https://example.test/prompt' sh -c "$PAYLOAD"`,
      denylist: DEFAULT_EXEC_DENYLIST_ENTRIES,
    });

    expect(result).toMatchObject({ denied: true, invalid: false, ruleIndex: 0 });
  });

  it("denies inline env assignment payload command case variants", () => {
    const result = evaluateExecDenylist({
      command: `env PAYLOAD='CURL https://example.test/prompt' sh -c "$PAYLOAD"`,
      denylist: DEFAULT_EXEC_DENYLIST_ENTRIES,
    });

    expect(result).toMatchObject({ denied: true, invalid: false, ruleIndex: 0 });
  });

  it("denies partial env-var command expansions", () => {
    const result = evaluateExecDenylist({
      command: `X=u sh -c 'c\${X}rl https://example.test/prompt'`,
      denylist: DEFAULT_EXEC_DENYLIST_ENTRIES,
    });

    expect(result).toMatchObject({ denied: true, invalid: false, ruleIndex: 0 });
  });

  it("denies PowerShell env-var payload expansions", () => {
    for (const command of [
      `pwsh -Command "$env:PAYLOAD"`,
      `pwsh -Command "$env:payload"`,
      `pwsh -Command "\${env:PAYLOAD}"`,
      `pwsh -Command "\${env:payload}"`,
    ]) {
      const result = evaluateExecDenylist({
        command,
        env: { PAYLOAD: "curl https://example.test/prompt" },
        denylist: DEFAULT_EXEC_DENYLIST_ENTRIES,
      });

      expect(result, command).toMatchObject({ denied: true, invalid: false, ruleIndex: 0 });
    }
  });

  it("denies PowerShell env-var payload command case variants", () => {
    const result = evaluateExecDenylist({
      command: `pwsh -Command "$env:PAYLOAD"`,
      env: { PAYLOAD: "CURL https://example.test/prompt" },
      denylist: DEFAULT_EXEC_DENYLIST_ENTRIES,
    });

    expect(result).toMatchObject({ denied: true, invalid: false, ruleIndex: 0 });
  });

  it("denies cmd env-var payload expansions", () => {
    for (const command of [
      `cmd /c "%PAYLOAD%"`,
      `cmd /c "%payload%"`,
      `cmd /v:on /c "!PAYLOAD!"`,
      `cmd /v:on /c "!payload!"`,
    ]) {
      const result = evaluateExecDenylist({
        command,
        env: { PAYLOAD: "curl https://example.test/prompt" },
        denylist: DEFAULT_EXEC_DENYLIST_ENTRIES,
      });

      expect(result, command).toMatchObject({ denied: true, invalid: false, ruleIndex: 0 });
    }
  });

  it("denies cmd env-var payload command case variants", () => {
    const result = evaluateExecDenylist({
      command: `cmd /c "%PAYLOAD%"`,
      env: { PAYLOAD: "WGET https://example.test/prompt" },
      denylist: DEFAULT_EXEC_DENYLIST_ENTRIES,
    });

    expect(result).toMatchObject({ denied: true, invalid: false, ruleIndex: 0 });
  });

  it("denies argument matches", () => {
    const result = evaluateExecDenylist({
      command: "python3 -c 'print(1)'",
      denylist: [{ pattern: String.raw`print\(1\)` }],
    });

    expect(result).toMatchObject({ denied: true, invalid: false, ruleIndex: 0 });
  });

  it("does not match command-name substrings with the default curl/wget entry", () => {
    const result = evaluateExecDenylist({
      command: "printf scurlog",
      denylist: DEFAULT_EXEC_DENYLIST_ENTRIES,
    });

    expect(result).toMatchObject({ denied: false, invalid: false });
  });

  it("does not deny harmless commands because the cwd matches a command rule", () => {
    const result = evaluateExecDenylist({
      command: "echo ok",
      cwd: "/tmp/curl",
      denylist: DEFAULT_EXEC_DENYLIST_ENTRIES,
    });

    expect(result).toMatchObject({ denied: false, invalid: false });
  });

  it("denies default entries next to shell redirection operators", () => {
    for (const command of ["curl>out https://example.test", "/usr/bin/curl>out", "wget<in"]) {
      const result = evaluateExecDenylist({
        command,
        denylist: DEFAULT_EXEC_DENYLIST_ENTRIES,
      });

      expect(result, command).toMatchObject({ denied: true, invalid: false, ruleIndex: 0 });
    }
  });

  it("denies default entries next to shell parameter expansion separators", () => {
    for (const command of [
      `sh -c 'curl\${IFS}https://example.test'`,
      `sh -c 'wget$IFS https://example.test'`,
    ]) {
      const result = evaluateExecDenylist({
        command,
        denylist: DEFAULT_EXEC_DENYLIST_ENTRIES,
      });

      expect(result, command).toMatchObject({ denied: true, invalid: false, ruleIndex: 0 });
    }
  });

  it("matches deny patterns in the middle of long bounded commands", () => {
    const result = evaluateExecDenylist({
      command: `printf ${"a".repeat(5000)}; curl https://example.test/prompt; printf done`,
      denylist: DEFAULT_EXEC_DENYLIST_ENTRIES,
    });

    expect(result).toMatchObject({ denied: true, invalid: false, ruleIndex: 0 });
  });

  it("fails closed on unsafe regex entries", () => {
    const result = evaluateExecDenylist({
      command: "echo hello",
      denylist: [{ pattern: "(a+)+" }],
    });

    expect(result).toMatchObject({
      denied: true,
      invalid: true,
      reason: "unsafe-regex",
      ruleIndex: 0,
    });
  });

  it("rejects stateful regex flags", () => {
    const result = evaluateExecDenylist({
      command: "echo hello",
      denylist: [{ pattern: "hello", flags: "g" }],
    });

    expect(result).toMatchObject({
      denied: true,
      invalid: true,
      reason: "invalid-flags",
      ruleIndex: 0,
    });
  });

  it("fails closed on malformed rule objects", () => {
    const result = evaluateExecDenylist({
      command: "echo hello",
      denylist: [{ pattern: 123 } as never],
    });

    expect(result).toMatchObject({
      denied: true,
      invalid: true,
      reason: "empty",
      ruleIndex: 0,
    });
  });

  it("fails closed when the denylist has too many rules", () => {
    const result = evaluateExecDenylist({
      command: "echo hello",
      denylist: Array.from({ length: MAX_EXEC_DENYLIST_RULES + 1 }, (_, idx) => ({
        pattern: `rule-${idx}`,
      })),
    });

    expect(result).toMatchObject({
      denied: true,
      invalid: true,
      reason: "too-many-rules",
    });
  });
});
