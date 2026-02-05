import { describe, expect, it } from "vitest";
import { resolveToolDisplay } from "./tool-display.js";

describe("tool display accessibility (plainText mode)", () => {
  it("returns emoji by default", () => {
    const display = resolveToolDisplay({
      name: "read",
      args: { path: "/test.md" },
    });

    expect(display.emoji).toBe("📖");
    expect(display.title).toBe("Read");
  });

  it("returns empty emoji when plainText is true", () => {
    const display = resolveToolDisplay({
      name: "read",
      args: { path: "/test.md" },
      plainText: true,
    });

    expect(display.emoji).toBe("");
    expect(display.title).toBe("Read");
  });

  it("returns empty emoji for exec tool in plainText mode", () => {
    const display = resolveToolDisplay({
      name: "exec",
      args: { command: "ls -la" },
      plainText: true,
    });

    expect(display.emoji).toBe("");
    expect(display.title).toBe("Exec");
  });

  it("returns empty emoji for fallback tools in plainText mode", () => {
    const display = resolveToolDisplay({
      name: "unknown_custom_tool",
      args: {},
      plainText: true,
    });

    expect(display.emoji).toBe("");
  });

  it("preserves all other display properties in plainText mode", () => {
    const display = resolveToolDisplay({
      name: "web_search",
      args: { query: "test query" },
      plainText: true,
    });

    expect(display.emoji).toBe("");
    expect(display.name).toBe("web_search");
    expect(display.title).toBeTruthy();
    expect(display.label).toBeTruthy();
  });

  it("returns normal emoji when plainText is false", () => {
    const display = resolveToolDisplay({
      name: "read",
      args: { path: "/test.md" },
      plainText: false,
    });

    expect(display.emoji).toBe("📖");
  });

  it("returns normal emoji when plainText is undefined", () => {
    const display = resolveToolDisplay({
      name: "write",
      args: { path: "/test.md", content: "hello" },
      plainText: undefined,
    });

    expect(display.emoji).toBe("✍️");
  });
});
