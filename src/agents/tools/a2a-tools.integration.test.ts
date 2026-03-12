/**
 * Integration test: verify tools can be imported and created
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: () =>
      ({
        session: { scope: "per-sender", mainKey: "main" },
        tools: { agentToAgent: { enabled: true, allow: ["*"] } },
        agents: { defaults: {} },
      }) as never,
  };
});

vi.mock("../../gateway/call.js", () => ({
  callGateway: vi.fn(),
}));

import { createAgentCallTool } from "./agent-call-tool.js";
import { createDebateCallTool } from "./debate-call-tool.js";

describe("tool integration", () => {
  it("creates agent_call tool with correct schema", () => {
    const tool = createAgentCallTool({ agentSessionKey: "agent:test:main" });

    expect(tool.name).toBe("agent_call");
    expect(tool.label).toBe("Agent Call");
    expect(tool.description).toContain("structured input/output");
    expect(tool.parameters).toBeDefined();
  });

  it("creates debate_call tool with correct schema", () => {
    const tool = createDebateCallTool({ agentSessionKey: "agent:test:main" });

    expect(tool.name).toBe("debate_call");
    expect(tool.label).toBe("Debate");
    expect(tool.description).toContain("multi-agent debate");
    expect(tool.parameters).toBeDefined();
  });

  it("tools have execute function", () => {
    const agentCall = createAgentCallTool({});
    const debateCall = createDebateCallTool({});

    expect(typeof agentCall.execute).toBe("function");
    expect(typeof debateCall.execute).toBe("function");
  });
});
