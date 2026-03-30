import { describe, it, expect, vi } from "vitest";
import { adaptTool } from "./tool-adapter";

describe("adaptTool", () => {
  // ✅ Basis: execute wird erzeugt
  it("creates tool with execute()", async () => {
    const tool = {
      name: "test",
      description: "desc",
      parameters: {},
      execute: vi.fn(async () => "ok"),
    } as any;

    const adapted = adaptTool(tool);

    expect(adapted.name).toBe("test");
    expect(typeof adapted.execute).toBe("function");
  });

  // ✅ ruft original execute korrekt auf
  it("calls original tool.execute with correct args", async () => {
    const mockExecute = vi.fn(async () => "ok");

    const tool = {
      name: "test",
      execute: mockExecute,
    } as any;

    const adapted = adaptTool(tool);

    await adapted.execute({ foo: 1 });

    expect(mockExecute).toHaveBeenCalledWith(
      "toolcall",
      { foo: 1 },
      undefined,
      undefined
    );
  });

  // ✅ STRING passthrough
  it("returns string result directly", async () => {
    const tool = {
      name: "test",
      execute: vi.fn(async () => "hello"),
    } as any;

    const adapted = adaptTool(tool);

    const result = await adapted.execute({});

    expect(result).toBe("hello");
  });

  // ✅ content field wird extrahiert
  it("returns result.content if present", async () => {
    const tool = {
      name: "test",
      execute: vi.fn(async () => ({
        content: "from-content",
      })),
    } as any;

    const adapted = adaptTool(tool);

    const result = await adapted.execute({});

    expect(result).toBe("from-content");
  });

  // ✅ output field wird extrahiert
  it("returns result.output if present", async () => {
    const tool = {
      name: "test",
      execute: vi.fn(async () => ({
        output: "from-output",
      })),
    } as any;

    const adapted = adaptTool(tool);

    const result = await adapted.execute({});

    expect(result).toBe("from-output");
  });

  // ✅ fallback → JSON stringify
  it("stringifies unknown object result", async () => {
    const tool = {
      name: "test",
      execute: vi.fn(async () => ({
        foo: "bar",
      })),
    } as any;

    const adapted = adaptTool(tool);

    const result = await adapted.execute({});

    expect(result).toContain('"foo": "bar"');
  });

  // ✅ error handling
  it("returns error message on failure", async () => {
    const tool = {
      name: "test",
      execute: vi.fn(async () => {
        throw new Error("boom");
      }),
    } as any;

    const adapted = adaptTool(tool);

    const result = await adapted.execute({});

    expect(result).toContain("Tool execution failed");
    expect(result).toContain("boom");
  });
});