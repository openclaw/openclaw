import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createModelSelectionState } from "./model-selection.js";

export const makeConfiguredModel = (overrides: Record<string, unknown> = {}) => ({
  id: "gpt-5.4",
  name: "GPT-5.4",
  reasoning: true,
  input: ["text"] as Array<"text">,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_384,
  ...overrides,
});

export function createInitialState(
  cfg: OpenClawConfig,
  provider: string,
  model: string,
  options: Partial<Parameters<typeof createModelSelectionState>[0]> = {},
) {
  return createModelSelectionState({
    agentId: "main",
    cfg,
    agentCfg: cfg.agents?.defaults,
    defaultProvider: provider,
    defaultModel: model,
    provider,
    model,
    hasModelDirective: false,
    ...options,
  });
}

export const makeEntry = (overrides: Partial<SessionEntry> = {}): SessionEntry => ({
  sessionId: "session-id",
  updatedAt: Date.now(),
  delivery: { kind: "none" },
  ...overrides,
});
