import { describe, expect, it, vi } from "vitest";
import type { ResolvedToolApprovalPolicy } from "../../infra/tool-approval-policy.js";
import type { AnyAgentTool } from "./common.js";
import { withToolApprovalGate } from "./mcp-tool-approval.js";

// Stub callGatewayTool so we never reach a real gateway.
vi.mock("./gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

function makeTool(name: string): AnyAgentTool {
  return {
    label: name,
    name,
    description: `test tool ${name}`,
    parameters: {},
    execute: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
  } as unknown as AnyAgentTool;
}

function permissivePolicy(): ResolvedToolApprovalPolicy {
  return { security: "full", ask: "off", askFallback: "full", allowlist: [] };
}

function askPolicy(): ResolvedToolApprovalPolicy {
  return { security: "full", ask: "always", askFallback: "full", allowlist: [] };
}

function denyPolicy(): ResolvedToolApprovalPolicy {
  return { security: "deny", ask: "off", askFallback: "full", allowlist: [] };
}

describe("withToolApprovalGate", () => {
  describe("allow-always cache scoping", () => {
    it("does not share allow-always cache between different agents", async () => {
      // Use callGatewayTool mock to simulate allow-always for agent-a.
      const { callGatewayTool } = await import("./gateway.js");
      const mockCallGateway = vi.mocked(callGatewayTool);

      // First call: agent-a gets allow-always via gateway.
      mockCallGateway
        .mockResolvedValueOnce({ decision: "allow-always" }) // registration
        .mockResolvedValueOnce({ decision: "allow-always" }); // waitDecision (fallback)

      const toolA = makeTool("mcp-read");
      const policy = askPolicy();
      const wrappedA = withToolApprovalGate(toolA, {
        agentId: "agent-a",
        policy,
      });
      await wrappedA.execute("call-1", {});
      expect(toolA.execute).toHaveBeenCalledTimes(1);

      // Second call from agent-a should hit cache (no gateway call).
      mockCallGateway.mockClear();
      await wrappedA.execute("call-2", {});
      expect(toolA.execute).toHaveBeenCalledTimes(2);
      // No gateway calls because cache hit.
      expect(mockCallGateway).not.toHaveBeenCalled();

      // Third call from agent-b for same tool name should NOT hit cache.
      const toolB = makeTool("mcp-read");
      mockCallGateway
        .mockResolvedValueOnce({ decision: "allow-once" }) // registration
        .mockResolvedValueOnce({ decision: "allow-once" }); // waitDecision
      const wrappedB = withToolApprovalGate(toolB, {
        agentId: "agent-b",
        policy,
      });
      await wrappedB.execute("call-3", {});
      // agent-b had to go through gateway because cache is scoped.
      expect(mockCallGateway).toHaveBeenCalled();
    });

    it("does not share allow-always cache between different policy contexts", async () => {
      const { callGatewayTool } = await import("./gateway.js");
      const mockCallGateway = vi.mocked(callGatewayTool);

      // Grant allow-always under ask=always policy.
      mockCallGateway.mockResolvedValueOnce({ decision: "allow-always" });
      const tool1 = makeTool("mcp-write");
      const wrapped1 = withToolApprovalGate(tool1, {
        agentId: "agent-x",
        policy: askPolicy(),
      });
      await wrapped1.execute("call-1", {});
      expect(tool1.execute).toHaveBeenCalledTimes(1);

      // Same agent, same tool, but different security policy: should not hit cache.
      mockCallGateway.mockClear();
      const tool2 = makeTool("mcp-write");
      const allowlistPolicy: ResolvedToolApprovalPolicy = {
        security: "allowlist",
        ask: "always",
        askFallback: "full",
        allowlist: [],
      };
      mockCallGateway.mockResolvedValueOnce({ decision: "allow-once" });
      const wrapped2 = withToolApprovalGate(tool2, {
        agentId: "agent-x",
        policy: allowlistPolicy,
      });
      await wrapped2.execute("call-2", {});
      // Should have gone through gateway.
      expect(mockCallGateway).toHaveBeenCalled();
    });
  });

  describe("deny policy blocks cached allow-always", () => {
    it("denies when policy changes to deny even if allow-always was cached", async () => {
      const { callGatewayTool } = await import("./gateway.js");
      const mockCallGateway = vi.mocked(callGatewayTool);

      // Grant allow-always under deny policy context (hypothetical stale entry).
      // We test the re-evaluation path: cache a tool under ask policy,
      // then wrap it with deny policy using same agent/security combo.
      mockCallGateway.mockResolvedValueOnce({ decision: "allow-always" });
      const tool = makeTool("mcp-danger");
      const wrapped = withToolApprovalGate(tool, {
        agentId: "agent-z",
        policy: askPolicy(),
      });
      await wrapped.execute("call-1", {});
      expect(tool.execute).toHaveBeenCalledTimes(1);

      // Wrap same tool name with deny policy and same agent.
      // The cache key differs because policy.security differs, so it goes
      // through the normal evaluateToolApprovalPolicy path and gets denied.
      const tool2 = makeTool("mcp-danger");
      const wrappedDeny = withToolApprovalGate(tool2, {
        agentId: "agent-z",
        policy: denyPolicy(),
      });
      const result = await wrappedDeny.execute("call-2", {});
      expect(tool2.execute).not.toHaveBeenCalled();
      expect(
        JSON.parse((result as { content: Array<{ text: string }> }).content[0].text),
      ).toMatchObject({
        error: expect.stringContaining("TOOL_CALL_DENIED"),
      });
    });
  });

  describe("permissive policy skips approval", () => {
    it("executes directly when security=full and ask=off", async () => {
      const tool = makeTool("mcp-safe");
      const wrapped = withToolApprovalGate(tool, {
        agentId: "agent-a",
        policy: permissivePolicy(),
      });
      await wrapped.execute("call-1", {});
      expect(tool.execute).toHaveBeenCalledTimes(1);
    });
  });
});
