import { expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import type { DoctorToolSchemaFrame } from "./doctor-tool-schema-frames.js";
import { collectAgentRuntimeToolSchemaFindings } from "./doctor-tool-schema-projection.js";

const mockCreateOpenClawCodingTools = vi.hoisted(() => vi.fn());
vi.mock("../agents/agent-tools.js", () => ({
  createOpenClawCodingTools: mockCreateOpenClawCodingTools,
}));

function makeTool(name: string): AnyAgentTool {
  return {
    name,
    label: name,
    description: `Synthetic ${name}`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [], details: {} }),
  };
}

function makeFrame(): DoctorToolSchemaFrame {
  return {
    agentId: "test-agent",
    agentDir: "/tmp/test-agent",
    workspaceDir: "/tmp/test-workspace",
    modelRef: { provider: "fixture", model: "local" },
    model: {
      provider: "fixture",
      id: "local",
      name: "Local fixture",
      api: "openai-completions",
      contextWindow: 32000,
    },
    capabilityProfile: {
      conversation: { questionInputMode: "buttons" },
      policy: {},
    } as DoctorToolSchemaFrame["capabilityProfile"],
  };
}

function makeConfig(toolsAllow: string[] = []): OpenClawConfig {
  return {
    agents: {
      entries: {
        "test-agent": {
          tools: { allow: toolsAllow },
        },
      },
    },
  } as OpenClawConfig;
}

function makeRegistry(): PluginRegistry {
  return {
    plugins: [],
    tools: [],
    providers: [],
  } as unknown as PluginRegistry;
}

it("passes a synthetic sessionKey to createOpenClawCodingTools so ask_user is included in the projected inventory", async () => {
  const askUserTool = makeTool("ask_user");
  const otherTool = makeTool("other_tool");
  mockCreateOpenClawCodingTools.mockReturnValue([askUserTool, otherTool]);

  const findings = await collectAgentRuntimeToolSchemaFindings({
    ...makeFrame(),
    cfg: makeConfig(["ask_user", "other_tool"]),
    toolRegistry: makeRegistry(),
  });

  // The fix: collectAgentRuntimeToolSchemaFindings must pass sessionKey.
  // Without it, ask_user is excluded from the projected inventory and the
  // policy pipeline warns about an unknown allowlist entry.
  expect(mockCreateOpenClawCodingTools).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionKey: "doctor-tool-schema-inspection-test-agent",
    }),
  );
  expect(findings).toEqual([]);
});

it("does not pass sessionKey when the fix is reverted (regression guard)", async () => {
  const askUserTool = makeTool("ask_user");
  mockCreateOpenClawCodingTools.mockReturnValue([askUserTool]);

  await collectAgentRuntimeToolSchemaFindings({
    ...makeFrame(),
    cfg: makeConfig(["ask_user"]),
    toolRegistry: makeRegistry(),
  });

  // Verify the call always includes sessionKey. If this assertion fails,
  // the fix has been reverted and the false-positive warning will return.
  const callArgs = mockCreateOpenClawCodingTools.mock.calls[0]?.[0];
  expect(callArgs).toBeDefined();
  expect(callArgs.sessionKey).toBe("doctor-tool-schema-inspection-test-agent");
});
