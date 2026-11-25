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

it("includes session-gated tools like ask_user when a synthetic sessionKey is provided", async () => {
  const askUserTool = makeTool("ask_user");
  const otherTool = makeTool("other_tool");
  mockCreateOpenClawCodingTools.mockReturnValue([askUserTool, otherTool]);

  const findings = await collectAgentRuntimeToolSchemaFindings({
    ...makeFrame(),
    cfg: makeConfig(["ask_user", "other_tool"]),
    toolRegistry: makeRegistry(),
  });

  expect(mockCreateOpenClawCodingTools).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionKey: "doctor-tool-schema-inspection-test-agent",
    }),
  );
  // No schema errors for valid tools
  expect(findings).toEqual([]);
});

it("does not report ask_user as unknown when it is in tools.allow", async () => {
  const askUserTool = makeTool("ask_user");
  mockCreateOpenClawCodingTools.mockReturnValue([askUserTool]);

  const findings = await collectAgentRuntimeToolSchemaFindings({
    ...makeFrame(),
    cfg: makeConfig(["ask_user"]),
    toolRegistry: makeRegistry(),
  });

  // The ask_user tool should be present in the inventory, so no unknown-entry warning
  expect(findings).toEqual([]);
});
