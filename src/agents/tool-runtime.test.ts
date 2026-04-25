import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolRuntime } from "./tool-runtime.js";

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  promises: {
    writeFile: vi.fn(),
    readFile: vi.fn(),
    readdir: vi.fn(),
    unlink: vi.fn(),
  },
}));

vi.mock("child_process", () => ({
  exec: vi.fn(),
}));

describe("ToolRuntime", () => {
  let runtime: ToolRuntime;

  beforeEach(() => {
    runtime = new ToolRuntime([{ name: "shell" }, { name: "write" }, { name: "read" }]);
  });

  it("getAllTools() returns tools", () => {
    const allTools = (runtime as unknown as { getAllTools: () => unknown[] }).getAllTools();
    expect(allTools.length).toBe(3);
  });

  it("run() throws for unknown tool", async () => {
    await expect(runtime.run("nonsense", {}, "id1")).rejects.toThrow("Unbekanntes Werkzeug");
  });
});
