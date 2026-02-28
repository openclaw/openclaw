import type { ModelDefinitionConfig } from "../config/types.js";

export type VolcModelCatalogEntry = {
  id: string;
  name: string;
  reasoning: boolean;
  input: ReadonlyArray<ModelDefinitionConfig["input"][number]>;
  contextWindow: number;
  maxTokens: number;
};

export const VOLC_MODEL_KIMI_K2_5 = {
  id: "kimi-k2-5-260127",
  name: "Kimi K2.5",
  reasoning: false,
  input: ["text", "image"] as const,
  contextWindow: 256000,
  maxTokens: 4096,
} as const;

export const VOLC_MODEL_GLM_4_7 = {
  id: "glm-4-7-251222",
  name: "GLM 4.7",
  reasoning: false,
  input: ["text", "image"] as const,
  contextWindow: 200000,
  maxTokens: 4096,
} as const;

export const VOLC_SHARED_CODING_MODEL_CATALOG = [
  {
    id: "ark-code-latest",
    name: "Ark Coding Plan",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 256000,
    maxTokens: 4096,
  },
  {
    id: "doubao-seed-code",
    name: "Doubao Seed Code",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 256000,
    maxTokens: 4096,
  },
  {
    id: "glm-4.7",
    name: "GLM 4.7 Coding",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 200000,
    maxTokens: 4096,
  },
  {
    id: "kimi-k2-thinking",
    name: "Kimi K2 Thinking",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 256000,
    maxTokens: 4096,
  },
  {
    id: "kimi-k2.5",
    name: "Kimi K2.5 Coding",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 256000,
    maxTokens: 4096,
  },
] as const;

export function buildVolcModelDefinition(
  entry: VolcModelCatalogEntry,
  cost: ModelDefinitionConfig["cost"],
): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: [...entry.input],
    cost,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
  };
}
