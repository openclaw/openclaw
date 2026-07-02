import { afterEach, describe, expect, it } from "vitest";
import {
  __resetClaudeCodeVersionResolver,
  __setClaudeCodeVersionResolver,
  claudeCodeUserAgent,
  resolveClaudeCodeVersion,
} from "./claude-code-version.js";

describe("claude-code-version resolver", () => {
  afterEach(() => {
    __resetClaudeCodeVersionResolver();
  });

  it("returns the resolved version from the injected resolver", () => {
    __setClaudeCodeVersionResolver(() => "2.1.177");
    expect(resolveClaudeCodeVersion()).toBe("2.1.177");
  });

  it("throws when the resolver returns null", () => {
    __setClaudeCodeVersionResolver(() => null);
    expect(() => resolveClaudeCodeVersion()).toThrow(/invalid value.*null/);
  });

  it("throws when the resolver returns an empty string", () => {
    __setClaudeCodeVersionResolver(() => "");
    expect(() => resolveClaudeCodeVersion()).toThrow(/invalid value/);
  });

  it("throws when the resolver returns a non-digit-leading string", () => {
    __setClaudeCodeVersionResolver(() => "not-a-version");
    expect(() => resolveClaudeCodeVersion()).toThrow(/invalid value/);
  });

  it("throws when the resolver returns a non-string value", () => {
    __setClaudeCodeVersionResolver(() => 123 as unknown as string);
    expect(() => resolveClaudeCodeVersion()).toThrow(/invalid value/);
  });

  it("throws when the resolver throws, surfacing the cause", () => {
    __setClaudeCodeVersionResolver(() => {
      throw new Error("simulated module-resolution failure");
    });
    expect(() => resolveClaudeCodeVersion()).toThrow(/Failed to resolve Claude Code version/);
  });

  it("accepts any digit-leading string from the resolver", () => {
    __setClaudeCodeVersionResolver(() => "2.0.0-beta");
    expect(resolveClaudeCodeVersion()).toBe("2.0.0-beta");
  });

  it("emits the user-agent header from the active resolver, not a frozen constant", () => {
    // Regression for ClawSweeper P2 #94719 review (2026-06-19):
    // `claudeCodeUserAgent()` MUST read the active resolver so tests that
    // swap the resolver see the new header. A module-load frozen constant
    // would silently disagree with the resolver.
    __setClaudeCodeVersionResolver(() => "2.1.177");
    expect(claudeCodeUserAgent()).toBe("claude-cli/2.1.177");
    __setClaudeCodeVersionResolver(() => "9.9.9-test");
    expect(claudeCodeUserAgent()).toBe("claude-cli/9.9.9-test");
  });

  it("does not emit a stale fallback under any failure mode (regression for #94716)", () => {
    // ClawSweeper P1 #94719 review (2026-06-19): the resolver MUST NEVER
    // fall back to a stale `2.1.75`-class version, because that is the
    // exact value Anthropic rejects. The runtime must surface the
    // configuration error instead of preserving the production auth
    // failure.
    __setClaudeCodeVersionResolver(() => null);
    expect(() => claudeCodeUserAgent()).toThrow();
    __setClaudeCodeVersionResolver(() => {
      throw new Error("resolution failed");
    });
    expect(() => claudeCodeUserAgent()).toThrow();
  });
});
