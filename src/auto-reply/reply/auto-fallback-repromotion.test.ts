// Tests the production wiring that builds the auto-fallback re-promotion resolver
// from live config + per-model auth-profile cooldown state.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";

const hoisted = vi.hoisted(() => ({
  resolveAuthProfileOrder: vi.fn(),
  isProfileInCooldown: vi.fn(),
  ensureAuthProfileStore: vi.fn(),
}));

vi.mock("../../agents/model-fallback-auth.runtime.js", () => ({
  resolveAuthProfileOrder: (...args: unknown[]) => hoisted.resolveAuthProfileOrder(...args),
  isProfileInCooldown: (...args: unknown[]) => hoisted.isProfileInCooldown(...args),
  ensureAuthProfileStore: (...args: unknown[]) => hoisted.ensureAuthProfileStore(...args),
}));

const {
  buildAutoFallbackChain,
  resolveAutoFallbackRepromotionTarget,
  selectAutoFallbackRepromotionTarget,
} = await import("./auto-fallback-repromotion.js");

const DEFAULT_PROVIDER = "openai";
const store = { fake: "store" } as never;

// Mirrors the live stuck-on-spark chain: gpt-5.5 primary, sonnet middle tier, then
// spark and grok fallbacks.
function cfgWithChain(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: {
          primary: "openai/gpt-5.5",
          fallbacks: ["claude-cli/claude-sonnet-5", "openai/gpt-5.3-codex-spark", "xai/grok-4.3"],
        },
      },
    },
  } as unknown as OpenClawConfig;
}

// One auth profile per provider so availability is decided purely by the per-model
// cooldown lookup.
function stubOrderByProvider(): void {
  hoisted.resolveAuthProfileOrder.mockImplementation((params: { provider: string }) => [
    `${params.provider}:profile`,
  ]);
}

describe("buildAutoFallbackChain", () => {
  it("orders primary first then configured fallbacks, deduped", () => {
    const chain = buildAutoFallbackChain({
      cfg: cfgWithChain(),
      defaultProvider: DEFAULT_PROVIDER,
    });
    expect(chain.map((ref) => `${ref.provider}/${ref.model}`)).toEqual([
      "openai/gpt-5.5",
      "claude-cli/claude-sonnet-5",
      "openai/gpt-5.3-codex-spark",
      "xai/grok-4.3",
    ]);
  });

  it("returns an empty chain when no default model is configured", () => {
    const chain = buildAutoFallbackChain({
      cfg: {} as OpenClawConfig,
      defaultProvider: DEFAULT_PROVIDER,
    });
    expect(chain).toEqual([]);
  });
});

describe("selectAutoFallbackRepromotionTarget", () => {
  it("re-promotes a session stuck on spark to the recovered middle tier while the primary stays limited", () => {
    stubOrderByProvider();
    // gpt-5.5 still rate-limited; every other tier available.
    hoisted.isProfileInCooldown.mockImplementation(
      (_store: unknown, _profileId: string, _reason: unknown, modelId: string) =>
        modelId === "gpt-5.5",
    );

    const target = selectAutoFallbackRepromotionTarget({
      cfg: cfgWithChain(),
      defaultProvider: DEFAULT_PROVIDER,
      current: { provider: "openai", model: "gpt-5.3-codex-spark" },
      store,
    });

    expect(target).toEqual({ provider: "claude-cli", model: "claude-sonnet-5" });
  });

  it("scopes the cooldown check to the candidate model (per-model, not provider-wide)", () => {
    stubOrderByProvider();
    hoisted.isProfileInCooldown.mockReturnValue(false);

    selectAutoFallbackRepromotionTarget({
      cfg: cfgWithChain(),
      defaultProvider: DEFAULT_PROVIDER,
      current: { provider: "openai", model: "gpt-5.3-codex-spark" },
      store,
    });

    // The 4th arg is the per-model scope introduced to stop a primary rate-limit
    // from suspending sibling models on the same profile.
    expect(hoisted.isProfileInCooldown).toHaveBeenCalledWith(
      store,
      "openai:profile",
      undefined,
      "gpt-5.5",
    );
  });

  it("climbs to the highest available tier once the primary recovers", () => {
    stubOrderByProvider();
    hoisted.isProfileInCooldown.mockReturnValue(false);

    const target = selectAutoFallbackRepromotionTarget({
      cfg: cfgWithChain(),
      defaultProvider: DEFAULT_PROVIDER,
      current: { provider: "openai", model: "gpt-5.3-codex-spark" },
      store,
    });

    expect(target).toEqual({ provider: "openai", model: "gpt-5.5" });
  });

  it("stays put when nothing above the current tier is available", () => {
    stubOrderByProvider();
    // Everything above spark still limited.
    hoisted.isProfileInCooldown.mockImplementation(
      (_store: unknown, _profileId: string, _reason: unknown, modelId: string) =>
        modelId !== "gpt-5.3-codex-spark" && modelId !== "grok-4.3",
    );

    const target = selectAutoFallbackRepromotionTarget({
      cfg: cfgWithChain(),
      defaultProvider: DEFAULT_PROVIDER,
      current: { provider: "openai", model: "gpt-5.3-codex-spark" },
      store,
    });

    expect(target).toBeUndefined();
  });

  it("treats providers with no auth profiles as available so the climb is not blocked", () => {
    // CLI-style provider tracks no auth profiles -> empty order.
    hoisted.resolveAuthProfileOrder.mockImplementation((params: { provider: string }) =>
      params.provider === "claude-cli" ? [] : [`${params.provider}:profile`],
    );
    // Real primary gpt-5.5 still limited; sonnet has no profiles.
    hoisted.isProfileInCooldown.mockImplementation(
      (_store: unknown, _profileId: string, _reason: unknown, modelId: string) =>
        modelId === "gpt-5.5",
    );

    const target = selectAutoFallbackRepromotionTarget({
      cfg: cfgWithChain(),
      defaultProvider: DEFAULT_PROVIDER,
      current: { provider: "openai", model: "gpt-5.3-codex-spark" },
      store,
    });

    expect(target).toEqual({ provider: "claude-cli", model: "claude-sonnet-5" });
  });
});

describe("resolveAutoFallbackRepromotionTarget", () => {
  const chain = [
    { provider: "openai", model: "gpt-5.5" },
    { provider: "claude-cli", model: "claude-sonnet-5" },
    { provider: "openai", model: "gpt-5.3-codex-spark" },
    { provider: "xai", model: "grok-4.3" },
  ];

  it("re-promotes past a rate-limited primary to the highest available tier", () => {
    const cooled = new Set(["openai/gpt-5.5"]);
    expect(
      resolveAutoFallbackRepromotionTarget({
        chain,
        current: { provider: "openai", model: "gpt-5.3-codex-spark" },
        isAvailable: (ref) => !cooled.has(`${ref.provider}/${ref.model}`),
      }),
    ).toStrictEqual({ provider: "claude-cli", model: "claude-sonnet-5" });
  });

  it("jumps straight back to the primary once it recovers", () => {
    expect(
      resolveAutoFallbackRepromotionTarget({
        chain,
        current: { provider: "openai", model: "gpt-5.3-codex-spark" },
        isAvailable: () => true,
      }),
    ).toStrictEqual({ provider: "openai", model: "gpt-5.5" });
  });

  it("stays put when only lower tiers are available (no downward move, no thrash)", () => {
    const cooled = new Set(["openai/gpt-5.5"]);
    expect(
      resolveAutoFallbackRepromotionTarget({
        chain,
        current: { provider: "claude-cli", model: "claude-sonnet-5" },
        isAvailable: (ref) => !cooled.has(`${ref.provider}/${ref.model}`),
      }),
    ).toBeUndefined();
  });

  it("skips a rate-limited higher tier and picks the next available one above current", () => {
    const cooled = new Set(["openai/gpt-5.5", "claude-cli/claude-sonnet-5"]);
    expect(
      resolveAutoFallbackRepromotionTarget({
        chain,
        current: { provider: "xai", model: "grok-4.3" },
        isAvailable: (ref) => !cooled.has(`${ref.provider}/${ref.model}`),
      }),
    ).toStrictEqual({ provider: "openai", model: "gpt-5.3-codex-spark" });
  });

  it("returns undefined when already on the primary", () => {
    expect(
      resolveAutoFallbackRepromotionTarget({
        chain,
        current: { provider: "openai", model: "gpt-5.5" },
        isAvailable: () => true,
      }),
    ).toBeUndefined();
  });

  it("trims surrounding whitespace on the current selection when matching the chain", () => {
    expect(
      resolveAutoFallbackRepromotionTarget({
        chain,
        current: { provider: " openai ", model: " gpt-5.3-codex-spark " },
        isAvailable: (ref) => ref.model !== "gpt-5.5",
      }),
    ).toStrictEqual({ provider: "claude-cli", model: "claude-sonnet-5" });
  });
});
