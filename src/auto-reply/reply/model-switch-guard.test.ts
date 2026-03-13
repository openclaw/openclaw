import { beforeEach, describe, expect, it, vi } from "vitest";

const { lookupContextTokensMock } = vi.hoisted(() => ({
  lookupContextTokensMock: vi.fn(),
}));

vi.mock("../../agents/context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/context.js")>();
  return {
    ...actual,
    lookupContextTokens: lookupContextTokensMock,
  };
});

import type { OpenClawConfig } from "../../config/config.js";
import { maybeBlockOversizedModelSwitch } from "./model-switch-guard.js";

describe("maybeBlockOversizedModelSwitch", () => {
  beforeEach(() => {
    lookupContextTokensMock.mockReset();
  });

  it("uses the smallest bare-model budget when providers share the same model id", () => {
    lookupContextTokensMock.mockReturnValue(200_000);

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
    expect(lookupContextTokensMock).toHaveBeenCalledWith("shared-budget-model");
  });

  it("does not block when the target model budget is unknown", () => {
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            reserveTokensFloor: 20_000,
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = maybeBlockOversizedModelSwitch({
      cfg,
      sessionEntry: {
        totalTokens: 190_000,
        totalTokensFresh: true,
      },
      currentProvider: "anthropic",
      currentModel: "claude-opus-4-5",
      targetProvider: "openrouter",
      targetModel: "__codex_unknown_context_window_model__",
    });

    expect(result).toBeUndefined();
  });

  it("still blocks when an explicit agent context cap is configured for an unknown model", () => {
    const cfg = {
      agents: {
        defaults: {
          contextTokens: 90_000,
          compaction: {
            reserveTokensFloor: 20_000,
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = maybeBlockOversizedModelSwitch({
      cfg,
      sessionEntry: {
        totalTokens: 80_000,
        totalTokensFresh: true,
      },
      currentProvider: "anthropic",
      currentModel: "claude-opus-4-5",
      targetProvider: "openrouter",
      targetModel: "__codex_unknown_context_window_model_with_cap__",
    });

    expect(result).toContain(
      "Can't switch to openrouter/__codex_unknown_context_window_model_with_cap__ yet.",
    );
    expect(result).toContain("70k/90k");
  });
});
