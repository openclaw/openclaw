import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createModelSelectionState } from "./model-selection.js";

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
