import { afterEach, describe, expect, it } from "vitest";
import {
  claudeCodeUserAgent,
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

  it("surfaces resolver failures instead of falling back to a stale version", () => {
    setClaudeCodeVersionResolverForTest(() => {
      throw new Error("cannot find @anthropic-ai/claude-code");
    });
    expect(() => claudeCodeUserAgent()).toThrow("cannot find @anthropic-ai/claude-code");
  });
});
