import { describe, expect, it } from "vitest";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { wrapToolWithToonEncoding } from "./tool-result-wrapper.js";

describe("wrapToolWithToonEncoding", () => {
  it("should encode details object as TOON in content", async () => {
    const mockTool: AnyAgentTool = {
      name: "test_tool",
      description: "Test tool",
      parameters: {} as any,
      execute: async () => ({
        content: [{ type: "text" as const, text: "Original text" }],
        details: {
          status: "completed",
          exitCode: 0,
          count: 42,
        },
      }),
    };

    const wrapped = wrapToolWithToonEncoding(mockTool);
    const result = await wrapped.execute("test-id", {});

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");

    const toonText = result.content[0].text;

    expect(toonText).toContain("status: completed");
    expect(toonText).toContain("exitCode: 0");
    expect(toonText).toContain("count: 42");

    expect(toonText).not.toContain("{");
    expect(toonText).not.toContain("}");

    expect(result.details).toEqual({
      status: "completed",
      exitCode: 0,
      count: 42,
    });
  });

  it("should not re-encode already TOON-formatted content", async () => {
    const mockTool: AnyAgentTool = {
      name: "test_tool",
      description: "Test tool",
      parameters: {} as any,
      execute: async () => ({
        content: [
          {
            type: "text" as const,
            text: "status: ok\ncount: 5",
          },
        ],
        details: { status: "ok", count: 5 },
      }),
    };

    const wrapped = wrapToolWithToonEncoding(mockTool);
    const result = await wrapped.execute("test-id", {});

    expect(result.content[0].text).toBe("# toon\nstatus: ok\ncount: 5");
  });

  it("should pass through results without details", async () => {
    const mockTool: AnyAgentTool = {
      name: "test_tool",
      description: "Test tool",
      parameters: {} as any,
      execute: async () => ({
        content: [{ type: "text" as const, text: "Simple text result" }],
      }),
    };

    const wrapped = wrapToolWithToonEncoding(mockTool);
    const result = await wrapped.execute("test-id", {});

    expect(result.content[0].text).toBe("Simple text result");
  });

  it("should return tool unchanged if it has no execute function", () => {
    const mockTool: AnyAgentTool = {
      name: "test_tool",
      description: "Test tool",
      parameters: {} as any,
    };

    const wrapped = wrapToolWithToonEncoding(mockTool);
    expect(wrapped).toBe(mockTool);
  });

  it("should encode nested objects in TOON format", async () => {
    const mockTool: AnyAgentTool = {
      name: "test_tool",
      description: "Test tool",
      parameters: {} as any,
      execute: async () => ({
        content: [{ type: "text" as const, text: "Original" }],
        details: {
          user: {
            name: "Alice",
            age: 30,
          },
          items: ["apple", "banana"],
        },
      }),
    };

    const wrapped = wrapToolWithToonEncoding(mockTool);
    const result = await wrapped.execute("test-id", {});

    const toonText = result.content[0].text;

    expect(toonText).toContain("user:");
    expect(toonText).toContain("name: Alice");
    expect(toonText).toContain("age: 30");
    expect(toonText).toContain("items[2]:");
    expect(toonText).toContain("apple");
    expect(toonText).toContain("banana");
  });
});
