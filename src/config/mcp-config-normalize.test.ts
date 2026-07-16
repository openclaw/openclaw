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

  it("normalizes disabled: false to enabled: true", () => {
    const result = canonicalizeConfiguredMcpServer({
      disabled: false,
      command: "claude",
      args: ["mcp", "serve"],
    });
    expect(result).toEqual({
      enabled: true,
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

  it("removes disabled and keeps existing enabled when disabled: true", () => {
    const result = canonicalizeConfiguredMcpServer({
      enabled: true,
      disabled: true,
      command: "echo",
      args: ["hello"],
    });
    expect(result).toEqual({
      enabled: true,
      command: "echo",
      args: ["hello"],
    });
    expect(result).not.toHaveProperty("disabled");
  });

  it("removes disabled and keeps existing enabled when disabled: false", () => {
    const result = canonicalizeConfiguredMcpServer({
      enabled: false,
      disabled: false,
      command: "echo",
      args: ["hello"],
    });
    expect(result).toEqual({
      enabled: false,
      command: "echo",
      args: ["hello"],
    });
    expect(result).not.toHaveProperty("disabled");
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
