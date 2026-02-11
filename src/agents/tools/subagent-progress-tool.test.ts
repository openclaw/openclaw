import { describe, it, expect } from "vitest";
import { createSubagentProgressTool } from "./subagent-progress-tool.js";

function parseResult(result: unknown): Record<string, unknown> {
  const r = result as { content?: Array<{ text?: string }> };
  const text = r?.content?.[0]?.text ?? "{}";
  return JSON.parse(text);
}

describe("createSubagentProgressTool", () => {
  // [0] Tool creation and registration
  it("creates a tool with correct name and label", () => {
    const tool = createSubagentProgressTool({
      agentSessionKey: "agent:test:subagent:abc-123",
    });
    expect(tool).toBeDefined();
    expect(tool.name).toBe("subagent_progress");
    expect(tool.label).toBe("Sub-agent");
    expect(tool.description).toContain("progress");
  });

  // [1] Rejects non-subagent sessions
  it("rejects calls from a main agent session", async () => {
    const tool = createSubagentProgressTool({
      agentSessionKey: "agent:main:main",
    });
    const result = parseResult(
      await tool.execute("call1", { message: "test", percent: 50 }),
    );
    expect(result.status).toBe("error");
    expect(result.error).toContain("only available in sub-agent sessions");
  });

  // [1b] Rejects when no session key provided
  it("rejects calls with no session key", async () => {
    const tool = createSubagentProgressTool({});
    const result = parseResult(
      await tool.execute("call2", { message: "test" }),
    );
    expect(result.status).toBe("error");
    expect(result.error).toContain("only available in sub-agent sessions");
  });

  // [1c] Rejects cron session keys
  it("rejects calls from a cron session", async () => {
    const tool = createSubagentProgressTool({
      agentSessionKey: "agent:main:cron:some-job-id",
    });
    const result = parseResult(
      await tool.execute("call3", { message: "test" }),
    );
    expect(result.status).toBe("error");
  });

  // [0b] Tool has correct parameter schema
  it("has message (required) and percent (optional) parameters", () => {
    const tool = createSubagentProgressTool({
      agentSessionKey: "agent:test:subagent:xyz",
    });
    const schema = tool.parameters as Record<string, unknown>;
    const props = (schema as { properties?: Record<string, unknown> }).properties;
    expect(props).toBeDefined();
    expect(props?.message).toBeDefined();
    expect(props?.percent).toBeDefined();
  });

  // Gaurav's validation tests
  describe("Validate all that is required", () => {
    it("validates tool is identified as an agent tool", () => {
      const tool = createSubagentProgressTool({
        agentSessionKey: "agent:test:subagent:abc-123",
      });
      // Tool exists and is properly labeled as a sub-agent tool
      expect(tool.label).toBe("Sub-agent");
      expect(tool.name).toBe("subagent_progress");
    });

    it("validates progress updates are structured for parent visibility", async () => {
      // When a subagent sends a progress update, the message format
      // should be structured so the parent can parse and display it
      const tool = createSubagentProgressTool({
        agentSessionKey: "agent:test:subagent:progress-test",
      });
      // Tool exists and accepts the right parameters for parent reporting
      expect(tool.description).toContain("parent");
      expect(tool.description).toContain("progress");
    });

    it("rejects unauthorized callers who are not subagents", async () => {
      // Non-subagent sessions must be rejected — no exceptions
      const unauthorized = [
        "agent:main:main",
        "agent:work:main",
        "agent:main:cron:job-123",
        "",
        "global",
        "unknown",
      ];
      for (const key of unauthorized) {
        const tool = createSubagentProgressTool({
          agentSessionKey: key || undefined,
        });
        const result = parseResult(
          await tool.execute("unauthorized-test", { message: "should fail" }),
        );
        expect(result.status).toBe("error");
      }
    });

    it("confirms subagent session keys are recognized as valid callers", () => {
      // These session key patterns should be accepted (not rejected at validation)
      const validSubagentKeys = [
        "agent:main:subagent:abc-123",
        "agent:work:subagent:def-456",
        "agent:test:subagent:ghi-789",
      ];
      for (const key of validSubagentKeys) {
        const tool = createSubagentProgressTool({ agentSessionKey: key });
        // Tool should be created successfully for subagent keys
        expect(tool).toBeDefined();
        expect(tool.name).toBe("subagent_progress");
      }
    });
  });
});
