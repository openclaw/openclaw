import { describe, expect, it } from "vitest";
import {
  mergePluginToolScopes,
  normalizePluginToolMatcher,
  pluginToolMatcherCoversTool,
  pluginToolScopeFromMatchers,
} from "./tool-hook-matcher.js";

describe("normalizePluginToolMatcher", () => {
  it("treats omitted, empty, and blank matchers as match-all", () => {
    expect(normalizePluginToolMatcher(undefined)).toBeUndefined();
    expect(normalizePluginToolMatcher([])).toBeUndefined();
    expect(normalizePluginToolMatcher(["  ", ""])).toBeUndefined();
  });

  it("trims, dedupes, and sorts matcher entries", () => {
    expect(normalizePluginToolMatcher([" message ", "exec", "message"])).toEqual([
      "exec",
      "message",
    ]);
  });

  it("drops non-string entries from hostile input", () => {
    expect(normalizePluginToolMatcher([42, "message"] as unknown as readonly string[])).toEqual([
      "message",
    ]);
  });
});

describe("pluginToolMatcherCoversTool", () => {
  it("matches every tool when the matcher is omitted", () => {
    expect(pluginToolMatcherCoversTool(undefined, "exec")).toBe(true);
  });

  it("matches through policy tool-name normalization", () => {
    expect(pluginToolMatcherCoversTool(["Bash"], "exec")).toBe(true);
    expect(pluginToolMatcherCoversTool(["message"], "Message")).toBe(true);
    expect(pluginToolMatcherCoversTool(["message"], "exec")).toBe(false);
  });
});

describe("pluginToolScopeFromMatchers", () => {
  it("returns an empty scope for no registrations", () => {
    expect(pluginToolScopeFromMatchers([])).toEqual({ matchAll: false, toolNames: [] });
  });

  it("forces match-all when any registration is unscoped", () => {
    expect(pluginToolScopeFromMatchers([["message"], undefined])).toEqual({ matchAll: true });
  });

  it("unions registered and normalized spellings deterministically", () => {
    expect(pluginToolScopeFromMatchers([["Bash"], ["message"]])).toEqual({
      matchAll: false,
      toolNames: ["Bash", "exec", "message"],
    });
  });
});

describe("mergePluginToolScopes", () => {
  it("forces match-all when any scope is match-all", () => {
    expect(
      mergePluginToolScopes([{ matchAll: false, toolNames: ["message"] }, { matchAll: true }]),
    ).toEqual({ matchAll: true });
  });

  it("unions scoped tool names", () => {
    expect(
      mergePluginToolScopes([
        { matchAll: false, toolNames: ["message"] },
        { matchAll: false, toolNames: ["exec"] },
      ]),
    ).toEqual({ matchAll: false, toolNames: ["exec", "message"] });
  });
});
