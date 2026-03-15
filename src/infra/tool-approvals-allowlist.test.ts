import { describe, expect, it } from "vitest";
import { evaluateToolAllowlist, matchToolAllowlist } from "./tool-approvals-allowlist.js";

describe("matchToolAllowlist", () => {
  it("returns null for empty allowlist", () => {
    expect(matchToolAllowlist([], "github__list_repos")).toBeNull();
  });

  it("returns null for empty tool name", () => {
    expect(matchToolAllowlist([{ pattern: "*" }], "")).toBeNull();
    expect(matchToolAllowlist([{ pattern: "*" }], "  ")).toBeNull();
  });

  it("matches exact tool name pattern", () => {
    const entry = { pattern: "github__list_repos" };
    expect(matchToolAllowlist([entry], "github__list_repos")).toBe(entry);
    expect(matchToolAllowlist([entry], "github__delete_repos")).toBeNull();
  });

  it("matches wildcard suffix", () => {
    const entry = { pattern: "github__list_*" };
    expect(matchToolAllowlist([entry], "github__list_repos")).toBe(entry);
    expect(matchToolAllowlist([entry], "github__list_issues")).toBe(entry);
    expect(matchToolAllowlist([entry], "github__delete_repos")).toBeNull();
  });

  it("matches wildcard prefix", () => {
    const entry = { pattern: "*__list_repos" };
    expect(matchToolAllowlist([entry], "github__list_repos")).toBe(entry);
    expect(matchToolAllowlist([entry], "gitlab__list_repos")).toBe(entry);
    expect(matchToolAllowlist([entry], "github__delete_repos")).toBeNull();
  });

  it("matches server-level wildcard", () => {
    const entry = { pattern: "github__*" };
    expect(matchToolAllowlist([entry], "github__list_repos")).toBe(entry);
    expect(matchToolAllowlist([entry], "github__delete_issue")).toBe(entry);
    expect(matchToolAllowlist([entry], "slack__send_message")).toBeNull();
  });

  it("matches bare wildcard for any tool", () => {
    const entry = { pattern: "*" };
    expect(matchToolAllowlist([entry], "github__list_repos")).toBe(entry);
    expect(matchToolAllowlist([entry], "any_tool_name")).toBe(entry);
  });

  it("matches double-star wildcard for any tool", () => {
    const entry = { pattern: "**" };
    expect(matchToolAllowlist([entry], "some_tool")).toBe(entry);
  });

  it("matching is case-insensitive", () => {
    const entry = { pattern: "GitHub__List_*" };
    expect(matchToolAllowlist([entry], "github__list_repos")).toBe(entry);
  });

  it("matches ? as single-character wildcard", () => {
    const entry = { pattern: "tool_v?" };
    expect(matchToolAllowlist([entry], "tool_v1")).toBe(entry);
    expect(matchToolAllowlist([entry], "tool_v2")).toBe(entry);
    expect(matchToolAllowlist([entry], "tool_v10")).toBeNull();
  });

  it("returns first matching entry", () => {
    const first = { pattern: "github__list_*" };
    const second = { pattern: "github__*" };
    expect(matchToolAllowlist([first, second], "github__list_repos")).toBe(first);
  });

  it("skips entries with empty patterns", () => {
    const empty = { pattern: "" };
    const valid = { pattern: "github__*" };
    expect(matchToolAllowlist([empty, valid], "github__list_repos")).toBe(valid);
  });
});

describe("evaluateToolAllowlist", () => {
  it("returns not satisfied for no match", () => {
    const result = evaluateToolAllowlist({
      toolName: "blocked_tool",
      allowlist: [{ pattern: "allowed_*" }],
    });
    expect(result.allowlistSatisfied).toBe(false);
    expect(result.matchedEntry).toBeNull();
  });

  it("returns satisfied with matching entry", () => {
    const entry = { pattern: "github__*" };
    const result = evaluateToolAllowlist({
      toolName: "github__list_repos",
      allowlist: [entry],
    });
    expect(result.allowlistSatisfied).toBe(true);
    expect(result.matchedEntry).toBe(entry);
  });
});
