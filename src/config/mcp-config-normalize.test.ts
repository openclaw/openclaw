import { describe, expect, it } from "vitest";
import { canonicalizeConfiguredMcpServer } from "./mcp-config-normalize.js";

describe("canonicalizeConfiguredMcpServer", () => {
  it("normalizes disabled: true to enabled: false", () => {
    const result = canonicalizeConfiguredMcpServer({
      disabled: true,
      command: "claude",
      args: ["mcp", "serve"],
    });
    expect(result).toEqual({
      enabled: false,
      command: "claude",
      args: ["mcp", "serve"],
    });
    expect(result).not.toHaveProperty("disabled");
  });

  it("leaves enabled: false unchanged", () => {
    const result = canonicalizeConfiguredMcpServer({
      enabled: false,
      command: "claude",
      args: ["mcp", "serve"],
    });
    expect(result).toEqual({
      enabled: false,
      command: "claude",
      args: ["mcp", "serve"],
    });
  });

  it("does not overwrite existing enabled with disabled: true", () => {
    const result = canonicalizeConfiguredMcpServer({
      enabled: true,
      disabled: true,
      command: "echo",
      args: ["hello"],
    });
    expect(result).toEqual({
      enabled: true,
      disabled: true,
      command: "echo",
      args: ["hello"],
    });
  });

  it("ignores disabled: false", () => {
    const result = canonicalizeConfiguredMcpServer({
      disabled: false,
      command: "claude",
      args: ["mcp", "serve"],
    });
    expect(result).toEqual({
      disabled: false,
      command: "claude",
      args: ["mcp", "serve"],
    });
  });

  it("passes through servers without disabled", () => {
    const result = canonicalizeConfiguredMcpServer({
      command: "node",
      args: ["server.js"],
      url: "http://localhost:3000",
    });
    expect(result).toEqual({
      command: "node",
      args: ["server.js"],
      url: "http://localhost:3000",
    });
  });
});
