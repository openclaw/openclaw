// Covers MCP server config canonicalization helpers.
import { describe, expect, it } from "vitest";
import { canonicalizeConfiguredMcpServer } from "./mcp-config-normalize.js";

describe("canonicalizeConfiguredMcpServer", () => {
  it("migrates disabled: true to enabled: false", () => {
    const result = canonicalizeConfiguredMcpServer({
      command: "claude",
      args: ["mcp", "serve"],
      disabled: true,
    });
    expect(result).toEqual({
      command: "claude",
      args: ["mcp", "serve"],
      enabled: false,
    });
  });

  it("migrates disabled: false to enabled: true", () => {
    const result = canonicalizeConfiguredMcpServer({
      command: "claude",
      args: ["mcp", "serve"],
      disabled: false,
    });
    expect(result).toEqual({
      command: "claude",
      args: ["mcp", "serve"],
      enabled: true,
    });
  });

  it("preserves explicit enabled when disabled is also present", () => {
    const result = canonicalizeConfiguredMcpServer({
      command: "claude",
      args: ["mcp", "serve"],
      enabled: true,
      disabled: true,
    });
    expect(result).toEqual({
      command: "claude",
      args: ["mcp", "serve"],
      enabled: true,
    });
  });

  it("leaves canonical enabled configs unchanged", () => {
    const result = canonicalizeConfiguredMcpServer({
      command: "claude",
      args: ["mcp", "serve"],
      enabled: false,
    });
    expect(result).toEqual({
      command: "claude",
      args: ["mcp", "serve"],
      enabled: false,
    });
  });
});
