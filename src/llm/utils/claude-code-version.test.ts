import { afterEach, describe, expect, it } from "vitest";
import {
  claudeCodeUserAgent,
  extractClaudeCodeCliVersionForTest,
  resetClaudeCodeVersionResolverForTest,
  resolveClaudeCodeVersion,
  setClaudeCodeVersionResolverForTest,
} from "./claude-code-version.js";

describe("claude-code-version", () => {
  afterEach(() => {
    resetClaudeCodeVersionResolverForTest();
  });

  it("returns the resolved version", () => {
    setClaudeCodeVersionResolverForTest(() => "2.1.177");
    expect(resolveClaudeCodeVersion()).toBe("2.1.177");
  });

  it("builds the OAuth user-agent header from the resolved version", () => {
    setClaudeCodeVersionResolverForTest(() => "2.1.177");
    expect(claudeCodeUserAgent()).toBe("claude-cli/2.1.177");
  });

  it("throws when the resolver returns an empty string", () => {
    setClaudeCodeVersionResolverForTest(() => "");
    expect(() => resolveClaudeCodeVersion()).toThrow(/invalid/);
  });

  it("throws when the resolver returns a non-string", () => {
    setClaudeCodeVersionResolverForTest(() => 123 as unknown as string);
    expect(() => resolveClaudeCodeVersion()).toThrow(/invalid/);
  });

  it("throws when the resolver returns a non-digit-leading string", () => {
    setClaudeCodeVersionResolverForTest(() => "not-a-version");
    expect(() => resolveClaudeCodeVersion()).toThrow(/invalid/);
  });

  it("surfaces resolver failures instead of falling back to a stale version", () => {
    setClaudeCodeVersionResolverForTest(() => {
      throw new Error("cannot find claude");
    });
    expect(() => claudeCodeUserAgent()).toThrow("cannot find claude");
  });

  it("does not emit a stale fallback under any failure mode", () => {
    setClaudeCodeVersionResolverForTest(() => {
      throw new Error("resolution failed");
    });
    expect(() => claudeCodeUserAgent()).toThrow();
  });

  it("parses a leading semver from claude --version output", () => {
    expect(extractClaudeCodeCliVersionForTest("2.1.177 (Claude Code)\n")).toBe("2.1.177");
  });

  it("parses a leading semver with pre-release suffixes", () => {
    expect(extractClaudeCodeCliVersionForTest("2.1.177-beta.1 (Claude Code)\n")).toBe(
      "2.1.177-beta.1",
    );
  });

  it("returns null for unparseable claude --version output", () => {
    expect(extractClaudeCodeCliVersionForTest("unknown")).toBeNull();
  });
});
