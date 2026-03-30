import { describe, it, expect, vi } from "vitest";
import { ToolRuntime, type ToolDefinition } from "./tool-runtime";

describe("ToolRuntime", () => {
  it("should execute a tool successfully", async () => {
    const mockExecute = vi.fn().mockResolvedValue("ok");

    const tools: ToolDefinition[] = [
      { name: "test", execute: mockExecute },
    ];

    const runtime = new ToolRuntime(tools);

    const result = await runtime.run("test", { foo: "bar" });

    expect(mockExecute).toHaveBeenCalledWith({ foo: "bar" });
    expect(result).toBe("ok");
  });

  it("should pass empty object if args are undefined", async () => {
    const mockExecute = vi.fn().mockResolvedValue("ok");

    const tools: ToolDefinition[] = [
      { name: "test", execute: mockExecute },
    ];

    const runtime = new ToolRuntime(tools);

    const result = await runtime.run("test", undefined);

    expect(mockExecute).toHaveBeenCalledWith({});
    expect(result).toBe("ok");
  });

  it("should throw if tool is not found", async () => {
    const runtime = new ToolRuntime([]);

    await expect(runtime.run("missing", {})).rejects.toThrow(
      "Tool not found: missing"
    );
  });

  it("should catch errors from tool and return error object", async () => {
    const mockExecute = vi.fn().mockRejectedValue(new Error("boom"));

    const tools: ToolDefinition[] = [
      { name: "fail", execute: mockExecute },
    ];

    const runtime = new ToolRuntime(tools);

    const result = await runtime.run("fail", {});

    expect(result).toEqual({
      error: true,
      message: "Error: boom",
    });
  });

  it("should handle non-Error throws", async () => {
    const mockExecute = vi.fn().mockRejectedValue("string error");

    const tools: ToolDefinition[] = [
      { name: "fail", execute: mockExecute },
    ];

    const runtime = new ToolRuntime(tools);

    const result = await runtime.run("fail", {});

    expect(result).toEqual({
      error: true,
      message: "string error",
    });
  });

  it("should register multiple tools correctly", async () => {
    const toolA = vi.fn().mockResolvedValue("A");
    const toolB = vi.fn().mockResolvedValue("B");

    const runtime = new ToolRuntime([
      { name: "a", execute: toolA },
      { name: "b", execute: toolB },
    ]);

    const resA = await runtime.run("a", {});
    const resB = await runtime.run("b", {});

    expect(resA).toBe("A");
    expect(resB).toBe("B");
  });
});