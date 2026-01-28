import { describe, expect, it } from "vitest";

import type { ClawdbrainConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { createModelSelectionState } from "./model-selection.js";

describe("createModelSelectionState(ignoreStoredOverride)", () => {
  it("does not apply stored session overrides when ignoreStoredOverride is true", async () => {
    const cfg = {} satisfies ClawdbrainConfig;
    const sessionEntry: SessionEntry = {
      sessionId: "s1",
      updatedAt: Date.now(),
      providerOverride: "openai",
      modelOverride: "gpt-4o",
    };
    const state = await createModelSelectionState({
      cfg,
      agentCfg: cfg.agents?.defaults,
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      storePath: undefined,
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-5",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      hasModelDirective: false,
      ignoreStoredOverride: true,
    });

    expect(state.provider).toBe("anthropic");
    expect(state.model).toBe("claude-sonnet-4-5");
  });
});
