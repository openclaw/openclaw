import { expect, it, vi } from "vitest";
import type { createOpenClawCodingTools } from "../agent-tools.js";
import type * as openClawPluginTools from "../openclaw-plugin-tools.js";

export function createOpenClawOnlyToolConstructionPlan() {
  return {
    includeBaseCodingTools: false,
    includeShellTools: false,
    includeChannelTools: false,
    includeOpenClawTools: true,
    includePluginTools: false,
  };
}

export function createPluginOnlyToolConstructionPlan() {
  return {
    ...createOpenClawOnlyToolConstructionPlan(),
    includeOpenClawTools: false,
    includePluginTools: true,
  };
}

export function createBaseOnlyToolConstructionPlan() {
  return {
    ...createOpenClawOnlyToolConstructionPlan(),
    includeOpenClawTools: false,
    includeBaseCodingTools: true,
  };
}

function createExplicitMediaToolConstructionOptions() {
  return {
    config: {
      agents: {
        defaults: { experimental: { localModelLean: true } },
        entries: {
          artist: {
            tools: {
              alsoAllow: ["video_generate"],
              byProvider: { ollama: { alsoAllow: ["tts"] } },
            },
          },
        },
      },
      tools: {
        alsoAllow: ["pdf"],
        byProvider: { "ollama/qwen3.5:9b": { alsoAllow: ["image_generate"] } },
      },
    },
    agentId: "artist",
    modelProvider: "ollama",
    modelId: "qwen3.5:9b",
    toolConstructionPlan: createOpenClawOnlyToolConstructionPlan(),
  };
}

export function registerExplicitMediaToolConstructionTest(
  expectToolSurface: (
    options: ReturnType<typeof createExplicitMediaToolConstructionOptions>,
    present: string[],
  ) => void,
) {
  it("preserves configured media tools through local model lean filtering", () => {
    expectToolSurface(createExplicitMediaToolConstructionOptions(), [
      "image_generate",
      "pdf",
      "tts",
      "video_generate",
    ]);
  });
}

export function registerManifestProfileToolConstructionTest(
  createTools: typeof createOpenClawCodingTools,
  pluginTools: Pick<typeof openClawPluginTools, "resolveOpenClawPluginToolsForOptions">,
) {
  it("includes plugin tools declared for the active built-in profile", () => {
    const resolvePluginToolsSpy = vi
      .spyOn(pluginTools, "resolveOpenClawPluginToolsForOptions")
      .mockReturnValue([
        {
          name: "profiled_plugin_tool",
          label: "Profiled plugin tool",
          description: "Profiled plugin tool test fixture",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          execute: async () => ({
            content: [{ type: "text" as const, text: "ok" }],
            details: {},
          }),
        },
      ]);
    const preparedModelRuntime = {
      metadataSnapshot: {
        plugins: [
          {
            id: "profiled-plugin",
            contracts: { tools: ["profiled_plugin_tool"] },
            toolMetadata: { profiled_plugin_tool: { profiles: ["coding"] } },
          },
        ],
      },
    } as never;
    try {
      const tools = createTools({
        config: { tools: { profile: "coding" } },
        includeCoreTools: false,
        preparedModelRuntime,
        toolConstructionPlan: createPluginOnlyToolConstructionPlan(),
      });
      expect(tools.map((tool) => tool.name)).toEqual(["profiled_plugin_tool"]);
      expect(resolvePluginToolsSpy.mock.calls[0]?.[0].options?.pluginToolAllowlist).toContain(
        "profiled_plugin_tool",
      );
    } finally {
      resolvePluginToolsSpy.mockRestore();
    }
  });
}
