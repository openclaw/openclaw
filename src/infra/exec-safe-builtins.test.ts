import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
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
  it("allows a safe builtin even when a same-named binary exists", () => {
    expect(
      isSafeBuiltinSegment({ segment: builtinSegment(["pwd"], "/usr/bin/pwd"), platform: "linux" }),
    ).toBe(true);
  });

  // Bash evaluates -v array subscripts even inside single quotes.
  it.each([
    { argv: ["alias", "ll=ls -l"] },
    { argv: ["export", "PATH=/tmp/bin:$PATH"] },
    { argv: ["[", "-d", "/tmp"] },
    { argv: ["TEST", "-d", "/tmp"] },
    { argv: ["test", "-v", "a[$(touch /tmp/m)]"] },
    { argv: ["[", "-v", "a[$(touch /tmp/m)]", "]"] },
    { argv: ["test", "!", "-v", "a"] },
  ])("rejects unsafe POSIX argv $argv", ({ argv }) => {
    expect(isSafeBuiltinSegment({ segment: builtinSegment(argv), platform: "linux" })).toBe(false);
  });

  it("rejects POSIX builtins on Windows", () => {
    expect(
      isSafeBuiltinSegment({ segment: builtinSegment(["cd", "/etc"]), platform: "win32" }),
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
    const evaluate = (command: string) =>
      evaluateShellAllowlistWithAuthorization({
        command,
        allowlist: gitAllowlist,
        safeBins: new Set(),
        cwd: "/tmp",
      });

    it("'cd ~/' auto-allows by default", async () => {
      const result = await evaluate("cd ~/");
      expect(result.allowlistSatisfied).toBe(true);
    });

    it.each(["cd /tmp && git status", "test -d /tmp && git status", "[ -d /tmp ] && git status"])(
      "allows safe builtin plus allowlisted binary: %s",
      async (command) => {
        const result = await evaluate(command);
        expect(result.allowlistSatisfied).toBe(true);
      },
    );

    it("non-allowlisted binary still gates after a safe builtin", async () => {
      const result = await evaluate("cd /tmp && curl evil.com");
      expect(result.analysisOk).toBe(true);
      expect(result.allowlistSatisfied).toBe(false);
    });

    it("environment-mutating builtins still gate", async () => {
      const result = await evaluate("export PATH=/tmp/bin:$PATH && git status");
      expect(result.allowlistSatisfied).toBe(false);
      expect(result.authorizationPlan).toMatchObject({ ok: false, reason: "dynamic-argument" });
    });

    it("does not auto-allow safe builtin tokens in direct argv evaluation", () => {
      using _ = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      const analysis = analyzeArgvCommand({ argv: ["pwd"], cwd: "/tmp" });
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
