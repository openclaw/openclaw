// Covers MCP-specific schema validation behavior.
import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";

describe("MCP server schema validation", () => {
  it("rejects the unsupported disabled field with an actionable message", () => {
    const result = validateConfigObjectRaw({
      mcp: {
        servers: {
          "claude-code": {
            disabled: true,
            command: "claude",
            args: ["mcp", "serve"],
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected disabled field to be rejected");
    }
    const issue = result.issues.find((entry) => entry.path.includes("disabled"));
    expect(issue).toBeDefined();
    expect(issue?.message).toContain('use "enabled: false"');
  });

  it("accepts canonical enabled: false", () => {
    const result = validateConfigObjectRaw({
      mcp: {
        servers: {
          "claude-code": {
            enabled: false,
            command: "claude",
            args: ["mcp", "serve"],
          },
        },
      },
    });

    expect(result.ok).toBe(true);
  });
});
