// Tests shell builtin detection for safe execution policy.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  evaluateExecAllowlist,
  evaluateShellAllowlistWithAuthorization,
} from "./exec-approvals-allowlist.js";
import { analyzeArgvCommand } from "./exec-approvals-analysis.js";
import {
  makeMockCommandResolution,
  makeMockExecutableResolution,
} from "./exec-approvals-test-helpers.js";
import { isSafeBuiltinSegment } from "./exec-safe-builtins.js";

const builtinSegment = (argv: string[], resolvedPath?: string) => ({
  argv,
  raw: argv.join(" "),
  resolution: makeMockCommandResolution({
    execution: makeMockExecutableResolution({
      rawExecutable: expectDefined(argv[0], "argv[0] test invariant"),
      executableName: expectDefined(argv[0], "argv[0] test invariant"),
      resolvedPath,
    }),
  }),
});

describe("isSafeBuiltinSegment", () => {
  it("allows a safe shell builtin even when the host has a same-named binary", () => {
    expect(
      isSafeBuiltinSegment({
        segment: builtinSegment(["pwd"], "/usr/bin/pwd"),
        platform: "linux",
      }),
    ).toBe(true);
  });

  it("rejects builtins outside the internal safe set", () => {
    expect(
      isSafeBuiltinSegment({
        segment: builtinSegment(["alias", "ll=ls -l"]),
        platform: "linux",
      }),
    ).toBe(false);
  });

  it("rejects environment-mutating builtins", () => {
    expect(
      isSafeBuiltinSegment({
        segment: builtinSegment(["export", "PATH=/tmp/bin:$PATH"]),
        platform: "linux",
      }),
    ).toBe(false);
    expect(
      isSafeBuiltinSegment({
        segment: builtinSegment(["unset", "PATH"]),
        platform: "linux",
      }),
    ).toBe(false);
  });

  it("rejects malformed bracket predicates", () => {
    expect(
      isSafeBuiltinSegment({
        segment: builtinSegment(["[", "-d", "/tmp"]),
        platform: "linux",
      }),
    ).toBe(false);
  });

  it("rejects case-variant builtin tokens (builtin lookup is case-sensitive)", () => {
    expect(
      isSafeBuiltinSegment({
        segment: builtinSegment(["TEST", "-d", "/tmp"]),
        platform: "linux",
      }),
    ).toBe(false);
    expect(
      isSafeBuiltinSegment({
        segment: builtinSegment(["Cd", "/tmp"]),
        platform: "linux",
      }),
    ).toBe(false);
  });

  it("rejects test/-v predicates: bash evaluates the -v operand subscript (command-injection vector)", () => {
    // `test -v 'a[$(cmd)]'` runs cmd under bash >= 4.2 because the -v operand's array
    // subscript is evaluated even inside single quotes.
    expect(
      isSafeBuiltinSegment({
        segment: builtinSegment(["test", "-v", "a[$(touch /tmp/m)]"]),
        platform: "linux",
      }),
    ).toBe(false);
    expect(
      isSafeBuiltinSegment({
        segment: builtinSegment(["test", "-v", "a[`touch /tmp/m`]"]),
        platform: "linux",
      }),
    ).toBe(false);
    expect(
      isSafeBuiltinSegment({
        segment: builtinSegment(["[", "-v", "a[$(touch /tmp/m)]", "]"]),
        platform: "linux",
      }),
    ).toBe(false);
  });

  it("rejects test -v operands regardless of position and negation", () => {
    expect(
      isSafeBuiltinSegment({
        segment: builtinSegment(["test", "!", "-v", "a"]),
        platform: "linux",
      }),
    ).toBe(false);
    expect(
      isSafeBuiltinSegment({
        segment: builtinSegment(["test", "x", "-a", "-v"]),
        platform: "linux",
      }),
    ).toBe(false);
    // Plain variable existence checks now route through approval too (conservative fail-safe).
    expect(
      isSafeBuiltinSegment({
        segment: builtinSegment(["test", "-v", "a"]),
        platform: "linux",
      }),
    ).toBe(false);
  });

  it("returns false on Windows hosts (PowerShell semantics differ)", () => {
    expect(
      isSafeBuiltinSegment({
        segment: builtinSegment(["cd", "/etc"]),
        platform: "win32",
      }),
    ).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")(
  "evaluateShellAllowlistWithAuthorization with known safe builtins (regression for #46056)",
  () => {
    // Glob-style pattern; matches git wherever PATH resolves it (`/usr/bin/git`,
    // `/opt/homebrew/bin/git`, etc.) without depending on host filesystem layout.
    const gitAllowlist = [{ pattern: "**/git" }] as Parameters<
      typeof evaluateShellAllowlistWithAuthorization
    >[0]["allowlist"];

    it("'cd ~/' auto-allows by default", async () => {
      const result = await evaluateShellAllowlistWithAuthorization({
        command: "cd ~/",
        allowlist: gitAllowlist,
        safeBins: new Set(),
        cwd: "/tmp",
      });
      expect(result.analysisOk).toBe(true);
      expect(result.allowlistSatisfied).toBe(true);
      expect(result.segmentSatisfiedBy[0]).toBe("safeBuiltins");
    });

    it("'cd /tmp && git status' passes with allowlist plus safe builtin handling", async () => {
      const result = await evaluateShellAllowlistWithAuthorization({
        command: "cd /tmp && git status",
        allowlist: gitAllowlist,
        safeBins: new Set(),
        cwd: "/tmp",
      });
      expect(result.analysisOk).toBe(true);
      expect(result.allowlistSatisfied).toBe(true);
      expect(result.segmentSatisfiedBy).toContain("safeBuiltins");
      expect(result.segmentSatisfiedBy).toContain("allowlist");
    });

    it("'test -d /tmp && git status' passes with allowlist plus safe builtin handling", async () => {
      const result = await evaluateShellAllowlistWithAuthorization({
        command: "test -d /tmp && git status",
        allowlist: gitAllowlist,
        safeBins: new Set(),
        cwd: "/tmp",
      });
      expect(result.analysisOk).toBe(true);
      expect(result.allowlistSatisfied).toBe(true);
      expect(result.segmentSatisfiedBy).toContain("safeBuiltins");
      expect(result.segmentSatisfiedBy).toContain("allowlist");
    });

    it("'[ -d /tmp ] && git status' passes with allowlist plus safe builtin handling", async () => {
      const result = await evaluateShellAllowlistWithAuthorization({
        command: "[ -d /tmp ] && git status",
        allowlist: gitAllowlist,
        safeBins: new Set(),
        cwd: "/tmp",
      });
      expect(result.analysisOk).toBe(true);
      expect(result.allowlistSatisfied).toBe(true);
      expect(result.segmentSatisfiedBy).toContain("safeBuiltins");
      expect(result.segmentSatisfiedBy).toContain("allowlist");
    });

    it("non-allowlisted binary still gates after a safe builtin", async () => {
      const result = await evaluateShellAllowlistWithAuthorization({
        command: "cd /tmp && curl evil.com",
        allowlist: gitAllowlist,
        safeBins: new Set(),
        cwd: "/tmp",
      });
      expect(result.analysisOk).toBe(true);
      expect(result.allowlistSatisfied).toBe(false);
    });

    it("environment-mutating builtins still gate", async () => {
      const result = await evaluateShellAllowlistWithAuthorization({
        command: "export PATH=/tmp/bin:$PATH && git status",
        allowlist: gitAllowlist,
        safeBins: new Set(),
        cwd: "/tmp",
      });
      expect(result.analysisOk).toBe(false);
      expect(result.allowlistSatisfied).toBe(false);
      expect(result.authorizationPlan).toEqual(
        expect.objectContaining({
          ok: false,
          reason: "dynamic-argument",
        }),
      );
    });

    it.each([
      ["test -e '/tmp/space path'", ["test", "-e", "/tmp/space path"]],
      ["test -e '*.txt'", ["test", "-e", "*.txt"]],
      ['test -e "*.txt"', ["test", "-e", "*.txt"]],
      [String.raw`test -e \$literal`, ["test", "-e", "$literal"]],
      ['test -e "$"', ["test", "-e", "$"]],
      ["test -e '$'", ["test", "-e", "$"]],
      [String.raw`test -e \*.txt`, ["test", "-e", "*.txt"]],
      ['"test" -e proof.txt', ["test", "-e", "proof.txt"]],
      ["'test' -e proof.txt", ["test", "-e", "proof.txt"]],
      [String.raw`t\est -e proof.txt`, ["test", "-e", "proof.txt"]],
      ["test'' -e proof.txt", ["test", "-e", "proof.txt"]],
      ["t'es't -e proof.txt", ["test", "-e", "proof.txt"]],
      [String.raw`$'te\x73t' -e proof.txt`, ["test", "-e", "proof.txt"]],
      ["test -e $'proof.txt'", ["test", "-e", "proof.txt"]],
      [String.raw`test -e $'\160\x72\u006f\U0000006ff.txt'`, ["test", "-e", "proof.txt"]],
      [String.raw`test -e $'a\'?v'`, ["test", "-e", "a'?v"]],
      [String.raw`test -e $'a\\'`, ["test", "-e", "a\\"]],
      [String.raw`test -e $'\u00e9'`, ["test", "-e", "é"]],
      [String.raw`test -e \$'a\'`, ["test", "-e", "$a\\"]],
      ['"[" -e proof.txt "]"', ["[", "-e", "proof.txt", "]"]],
      [String.raw`\[ -e proof.txt \]`, ["[", "-e", "proof.txt", "]"]],
    ] as const)("preserves parsed literal predicate source: %s", async (command, argv) => {
      const result = await evaluateShellAllowlistWithAuthorization({
        command,
        allowlist: [],
        safeBins: new Set(),
        cwd: "/tmp",
      });
      expect(result.analysisOk).toBe(true);
      expect(result.segments[0]?.argv).toEqual(argv);
      expect(result.allowlistSatisfied).toBe(true);
      expect(result.segmentSatisfiedBy).toEqual(["safeBuiltins"]);
    });

    it.each([
      "test -e *.txt",
      "[ -e *.txt ]",
      String.raw`test $'\0\''?v benign`,
      String.raw`test -e $'proof'?`,
      String.raw`[ -e $'proof'* ]`,
      "test -e $FILE",
      'test -e "$FILE"',
      "test -e ${FILE}",
      "test -e $(pwd)",
      "test -e ~",
      "test -e {a,b}",
      '"$CMD" -e proof.txt',
      String.raw`test -e $'\0proof'`,
      String.raw`test -e $'\q'`,
      String.raw`test -e $'\cA'`,
      String.raw`test -e $'\400'`,
    ])(
      "does not grant an implicit exemption to dynamic or unproved source: %s",
      async (command) => {
        const result = await evaluateShellAllowlistWithAuthorization({
          command,
          allowlist: [],
          safeBins: new Set(),
          cwd: "/tmp",
        });
        expect(result.allowlistSatisfied).toBe(false);
        expect(result.segmentSatisfiedBy).not.toContain("safeBuiltins");
      },
    );

    it.each([
      "test -v name",
      "test '-v' name",
      "test -'v' name",
      String.raw`test $'\x2dv' name`,
      String.raw`test $'\055\166' name`,
      String.raw`test $'\u002d\U00000076' name`,
      String.raw`"[" $'\x2dv' name "]"`,
    ])("retains the semantic -v guard through real parsed argv: %s", async (command) => {
      const result = await evaluateShellAllowlistWithAuthorization({
        command,
        allowlist: [],
        safeBins: new Set(),
        cwd: "/tmp",
      });
      expect(result.analysisOk).toBe(true);
      expect(result.segments[0]?.argv).toContain("-v");
      expect(result.allowlistSatisfied).toBe(false);
      expect(result.segmentSatisfiedBy).not.toContain("safeBuiltins");
    });

    it("does not auto-allow safe builtin tokens in direct argv evaluation", () => {
      const analysis = analyzeArgvCommand({ argv: ["pwd"], cwd: "/tmp", platform: "linux" });
      const result = evaluateExecAllowlist({
        analysis,
        allowlist: [],
        safeBins: new Set(),
        cwd: "/tmp",
      });
      expect(result.allowlistSatisfied).toBe(false);
    });
  },
);
