/**
 * Model capability registry for the meta-router.
 * Maps providers/models to the task types they excel at.
 * Inspired by Perplexity Computer's model routing approach.
 */

export const MODEL_TASK_TYPES = [
  "code",
  "math",
  "research",
  "creative",
  "vision",
  "video",
  "audio",
  "long-context",
  "fast",
  "reasoning",
  "data-analysis",
  "general",
] as const;

export type ModelTaskType = (typeof MODEL_TASK_TYPES)[number];

export type ModelCapabilityEntry = {
  provider: string;
  model: string;
  /** Primary strengths — router prefers this model for these task types. */
  strengths: ModelTaskType[];
  /** Rough context window size in tokens. */
  contextWindow?: number;
  /** Relative latency: 1 = fastest, 3 = slowest. */
  latencyTier?: 1 | 2 | 3;
  /** Whether the model supports image inputs. */
  vision?: boolean;
  /** Whether the model supports extended reasoning/thinking. */
  reasoning?: boolean;
};

/**
 * Built-in capability registry.  Users can override/extend this via config
 * (agents.router.capabilities).
 *
 * Entries are matched by prefix so "claude-opus" covers "claude-opus-4-6" etc.
 * When multiple entries match a task, the router picks the first match.
 */
export const BUILTIN_MODEL_CAPABILITIES: readonly ModelCapabilityEntry[] = [
  // --- Anthropic ---
  {
    provider: "anthropic",
    model: "claude-opus-4",
    strengths: ["reasoning", "code", "long-context", "general"],
    contextWindow: 200_000,
    latencyTier: 3,
    vision: true,
    reasoning: true,
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4",
    strengths: ["code", "general", "data-analysis", "creative"],
    contextWindow: 200_000,
    latencyTier: 2,
    vision: true,
    reasoning: true,
  },
  {
    provider: "anthropic",
    model: "claude-haiku-4",
    strengths: ["fast", "general"],
    contextWindow: 200_000,
    latencyTier: 1,
    vision: true,
  },
  // --- OpenAI ---
  {
    provider: "openai",
    model: "gpt-5",
    strengths: ["long-context", "general", "research", "data-analysis"],
    contextWindow: 200_000,
    latencyTier: 3,
    vision: true,
    reasoning: true,
  },
  {
    provider: "openai",
    model: "gpt-4o",
    strengths: ["general", "vision", "fast"],
    contextWindow: 128_000,
    latencyTier: 2,
    vision: true,
  },
  {
    provider: "openai",
    model: "o3",
    strengths: ["reasoning", "math", "code"],
    contextWindow: 200_000,
    latencyTier: 3,
    reasoning: true,
  },
  {
    provider: "openai",
    model: "o4-mini",
    strengths: ["fast", "math", "code"],
    contextWindow: 128_000,
    latencyTier: 1,
    reasoning: true,
  },
  // --- Google ---
  {
    provider: "google",
    model: "gemini-2.5-pro",
    strengths: ["research", "long-context", "vision", "data-analysis"],
    contextWindow: 1_000_000,
    latencyTier: 2,
    vision: true,
    reasoning: true,
  },
  {
    provider: "google",
    model: "gemini-2.5-flash",
    strengths: ["fast", "research", "vision"],
    contextWindow: 1_000_000,
    latencyTier: 1,
    vision: true,
  },
  // --- xAI / Grok ---
  {
    provider: "xai",
    model: "grok-3",
    strengths: ["fast", "general", "creative"],
    contextWindow: 131_000,
    latencyTier: 1,
  },
  {
    provider: "xai",
    model: "grok-3-mini",
    strengths: ["fast", "math", "code"],
    contextWindow: 131_000,
    latencyTier: 1,
    reasoning: true,
  },
  // --- Ollama (local models) ---
  {
    provider: "ollama",
    model: "llama3",
    strengths: ["fast", "general"],
    contextWindow: 128_000,
    latencyTier: 1,
  },
  {
    provider: "ollama",
    model: "codellama",
    strengths: ["code", "fast"],
    contextWindow: 16_000,
    latencyTier: 1,
  },
];

/**
 * Returns the best capability entry for a given task type from the registry.
 * Merges built-in registry with any user-configured overrides.
 */
export function resolveModelForTask(params: {
  taskType: ModelTaskType;
  capabilities?: readonly ModelCapabilityEntry[];
  latencyBudget?: "fast" | "normal" | "thorough";
  requireVision?: boolean;
}): ModelCapabilityEntry | undefined {
  const registry = [
    ...(params.capabilities ?? []),
    ...BUILTIN_MODEL_CAPABILITIES,
  ];

  const maxLatencyTier = params.latencyBudget === "fast" ? 1 : params.latencyBudget === "thorough" ? 3 : 2;

  const candidates = registry.filter((entry) => {
    if (!entry.strengths.includes(params.taskType)) return false;
    if (params.requireVision && !entry.vision) return false;
    if ((entry.latencyTier ?? 2) > maxLatencyTier) return false;
    return true;
  });

  return candidates[0];
}

/**
 * Returns all models that support a given task type.
 */
export function listModelsForTask(params: {
  taskType: ModelTaskType;
  capabilities?: readonly ModelCapabilityEntry[];
}): ModelCapabilityEntry[] {
  const registry = [...(params.capabilities ?? []), ...BUILTIN_MODEL_CAPABILITIES];
  return registry.filter((entry) => entry.strengths.includes(params.taskType));
}
