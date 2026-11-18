import { it } from "vitest";

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
