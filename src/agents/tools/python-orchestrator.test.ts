import { describe, it, expect } from "vitest";
import { createPythonOrchestratorTool } from "./python-orchestrator.js";

describe("python_orchestrator tool", () => {
  it("creates the tool with correct name and schema", () => {
    const tool = createPythonOrchestratorTool({
      availableTools: [],
      maxToolCalls: 10,
    });

    expect(tool.name).toBe("python_orchestrator");
    expect(tool.label).toBe("Python Orchestrator");
    expect(tool.parameters).toBeDefined();
    expect(tool.execute).toBeDefined();
  });

  it("throws error when code is empty", async () => {
    const tool = createPythonOrchestratorTool({
      availableTools: [],
      maxToolCalls: 10,
    });

    await expect(
      tool.execute("test-1", {
        code: "",
        timeout_seconds: 30,
      }),
    ).rejects.toThrow("code required");
  });

  it("executes simple Python code", async () => {
    const tool = createPythonOrchestratorTool({
      availableTools: [],
      maxToolCalls: 10,
    });

    const result = await tool.execute("test-2", {
      code: "print('Hello from Python')",
      timeout_seconds: 30,
    });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain("Hello from Python");
    expect(result.details).toBeDefined();
    expect(result.details.exit_code).toBe(0);
  });

  it("handles Python errors", async () => {
    const tool = createPythonOrchestratorTool({
      availableTools: [],
      maxToolCalls: 10,
    });

    const result = await tool.execute("test-3", {
      code: "raise ValueError('Test error')",
      timeout_seconds: 30,
    });

    expect(result.content[0].text).toContain("failed");
    expect(result.details.exit_code).not.toBe(0);
  });

  it("respects timeout", async () => {
    const tool = createPythonOrchestratorTool({
      availableTools: [],
      maxToolCalls: 10,
    });

    const result = await tool.execute("test-4", {
      code: "import time; time.sleep(10)",
      timeout_seconds: 1, // Very short timeout
    });

    expect(result.content[0].text).toContain("Error");
  });
});
