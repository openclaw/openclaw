import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { maybeBlockOversizedModelSwitch } from "./model-switch-guard.js";

describe("maybeBlockOversizedModelSwitch", () => {
  it("uses the smallest bare-model budget when providers share the same model id", () => {
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            reserveTokensFloor: 20_000,
          },
        },
      },
      models: {
        providers: {
          anthropic: {
            models: [{ id: "shared-budget-model", contextWindow: 200_000 }],
          },
          openrouter: {
            models: [{ id: "shared-budget-model", contextWindow: 128_000 }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = maybeBlockOversizedModelSwitch({
      cfg,
      sessionEntry: {
        totalTokens: 150_000,
        totalTokensFresh: true,
      },
      currentProvider: "anthropic",
      currentModel: "shared-budget-model",
      targetProvider: "openrouter",
      targetModel: "shared-budget-model",
    });

    expect(result).toContain("Can't switch to openrouter/shared-budget-model yet.");
    expect(result).toContain("108k/128k");
  });
});
