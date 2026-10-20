// Tests shell builtin detection for safe execution policy.
import { describe, expect, it } from "vitest";
import {
  evaluateExecAllowlist,
  evaluateShellAllowlistWithAuthorization,
} from "./exec-approvals-allowlist.js";
import { analyzeArgvCommand } from "./exec-approvals-analysis.js";
import { isSafeBuiltinSegment } from "./exec-safe-builtins.js";

const builtinSegment = (argv: string[]) => ({
  argv,
  raw: argv.join(" "),
  resolution: null,
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
    const evaluate = (command: string) =>
      evaluateShellAllowlistWithAuthorization({
        command,
        allowlist: [{ pattern: "**/git" }],
        safeBins: new Set(),
        cwd: "/tmp",
      });

    it("'cd ~/' auto-allows by default", async () => {
      const result = await evaluate("cd ~/");
      expect(result).toMatchObject({ analysisOk: true, allowlistSatisfied: true });
      expect(result.segmentSatisfiedBy[0]).toBe("safeBuiltins");
    });

    it("'cd /tmp && git status' passes with allowlist plus safe builtin handling", async () => {
      const result = await evaluate("cd /tmp && git status");
      expect(result).toMatchObject({ analysisOk: true, allowlistSatisfied: true });
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
      const result = await evaluate("[ -d /tmp ] && git status");
      expect(result).toMatchObject({ analysisOk: true, allowlistSatisfied: true });
      expect(result.segmentSatisfiedBy).toContain("safeBuiltins");
      expect(result.segmentSatisfiedBy).toContain("allowlist");
    });

    it("non-allowlisted binary still gates after a safe builtin", async () => {
      expect(await evaluate("cd /tmp && curl evil.com")).toMatchObject({
        analysisOk: true,
        allowlistSatisfied: false,
      });
    });

    it("environment-mutating builtins still gate", async () => {
      expect(await evaluate("export PATH=/tmp/bin:$PATH && git status")).toMatchObject({
        analysisOk: false,
        allowlistSatisfied: false,
        authorizationPlan: { ok: false, reason: "dynamic-argument" },
      });
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
