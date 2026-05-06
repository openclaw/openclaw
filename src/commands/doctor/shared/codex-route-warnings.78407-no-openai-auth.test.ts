// Reproduction tests for openclaw/openclaw#78407 — `openclaw doctor --fix`
// rewrites every `openai-codex/*` model ref to `openai/*` and sets
// `agentRuntime.id: "pi"` when the codex CLI plugin isn't installed, leaving
// users who authenticate only via openai-codex OAuth (ChatGPT account) with
// no working auth on first boot.
//
// The first test reproduces the user-visible regression with `it.fails` —
// when the migration learns to skip or compensate for the missing
// `openai/*` auth profile, vitest will start passing the test and force
// removal of the `.fails` marker.
//
// The second test is a generic invariant any future migration should
// satisfy: don't leave the primary model ref pointing at a provider with no
// usable auth profile. It passes today on a clean fixture and is wired up
// to assert post-repair state for additional regressions filed against
// this code path.
//
// Sibling scaffolding for the broader transport-parity gate proposed in
// openclaw/openclaw#78457 lives in `extensions/qa-lab/transport-parity-gate.md`.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  evaluateStoredCredentialEligibility: vi.fn(),
  getInstalledPluginRecord: vi.fn(),
  isInstalledPluginEnabled: vi.fn(),
  loadInstalledPluginIndex: vi.fn(),
  resolveAuthProfileOrder: vi.fn(),
  resolveProfileUnusableUntilForDisplay: vi.fn(),
}));

vi.mock("../../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: mocks.ensureAuthProfileStore,
  resolveAuthProfileOrder: mocks.resolveAuthProfileOrder,
  resolveProfileUnusableUntilForDisplay: mocks.resolveProfileUnusableUntilForDisplay,
}));

vi.mock("../../../agents/auth-profiles/credential-state.js", () => ({
  evaluateStoredCredentialEligibility: mocks.evaluateStoredCredentialEligibility,
}));

vi.mock("../../../plugins/installed-plugin-index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/installed-plugin-index.js")>()),
  getInstalledPluginRecord: mocks.getInstalledPluginRecord,
  isInstalledPluginEnabled: mocks.isInstalledPluginEnabled,
  loadInstalledPluginIndex: mocks.loadInstalledPluginIndex,
}));

import { maybeRepairCodexRoutes } from "./codex-route-warnings.js";

// Mirrors the 5-location footprint observed in the user's openclaw.json
// before/after diff in #78407 — defaults primary + fallbacks, modelCatalog,
// and per-agent + per-channel modelOverride blocks.
function buildOpenAICodexFixture(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: "openai-codex/gpt-5.5",
        modelOverride: {
          primary: "openai-codex/gpt-5.5",
          fallbacks: ["openai-codex/gpt-5.4", "openai-codex/gpt-5.4-mini"],
        },
        modelCatalog: {
          "openai-codex/gpt-5.4": {},
          "openai-codex/gpt-5.4-mini": {},
          "openai-codex/gpt-5.4-pro": {},
          "openai-codex/gpt-5.5": {},
          "openai-codex/gpt-5.5-pro": {},
        },
      },
      list: [
        {
          id: "main",
          modelOverride: {
            primary: "openai-codex/gpt-5.5",
            fallbacks: ["openai-codex/gpt-5.4", "openai-codex/gpt-5.4-mini"],
          },
        },
      ],
    },
    channels: {
      webchat: {
        modelOverride: {
          primary: "openai-codex/gpt-5.5",
          fallbacks: ["openai-codex/gpt-5.4", "openai-codex/gpt-5.4-mini"],
        },
      },
    },
  } as unknown as OpenClawConfig;
}

// Generic invariant any migration should preserve. Returns the list of
// model refs in the post-migration config that point at a provider with no
// usable auth profile in `authProfileProviders`. Empty list = invariant
// holds.
function findModelRefsWithoutAuth(
  cfg: OpenClawConfig,
  authProfileProviders: ReadonlySet<string>,
): string[] {
  const orphans: string[] = [];
  const visit = (ref: unknown, path: string): void => {
    if (typeof ref !== "string") return;
    const slash = ref.indexOf("/");
    if (slash <= 0) return;
    const provider = ref.slice(0, slash);
    if (!authProfileProviders.has(provider)) {
      orphans.push(`${path}=${ref}`);
    }
  };
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((value, index) => walk(value, `${path}[${index}]`));
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        const nextPath = path ? `${path}.${key}` : key;
        if (key === "primary" || key === "model") {
          visit(value, nextPath);
          continue;
        }
        if (key === "fallbacks" && Array.isArray(value)) {
          value.forEach((entry, idx) => visit(entry, `${nextPath}[${idx}]`));
          continue;
        }
        if (key === "modelCatalog" && value && typeof value === "object") {
          for (const catalogKey of Object.keys(value as Record<string, unknown>)) {
            visit(catalogKey, `${nextPath}.${catalogKey}`);
          }
          continue;
        }
        walk(value, nextPath);
      }
    }
  };
  walk(cfg, "");
  return orphans;
}

describe("maybeRepairCodexRoutes — issue #78407 no-openai-auth regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // The user has only an openai-codex OAuth profile (ChatGPT account).
    mocks.ensureAuthProfileStore.mockReturnValue({
      profiles: {
        "openai-codex:user@example.com": {
          type: "oauth",
          provider: "openai-codex",
          access: "stub",
          refresh: "stub",
          expires: Date.now() + 86_400_000,
          email: "user@example.com",
        },
      },
      usageStats: {},
    });
    mocks.resolveAuthProfileOrder.mockImplementation(
      ({ provider }: { provider: string }) =>
        provider === "openai-codex" ? ["openai-codex:user@example.com"] : [],
    );
    mocks.evaluateStoredCredentialEligibility.mockReturnValue({
      eligible: true,
      reasonCode: "ok",
    });
    mocks.resolveProfileUnusableUntilForDisplay.mockReturnValue(null);

    // The codex CLI plugin is not installed (the mainstream OAuth-only
    // user shape — they auth via ChatGPT OAuth, not the codex CLI
    // subprocess wrapper).
    mocks.getInstalledPluginRecord.mockReturnValue(undefined);
    mocks.isInstalledPluginEnabled.mockReturnValue(false);
    mocks.loadInstalledPluginIndex.mockReturnValue({ plugins: [] });
  });

  // EXPECTED FAILURE — reproduces #78407. The migration currently rewrites
  // every `openai-codex/*` ref to `openai/*` and sets `agentRuntime.id:
  // "pi"`, even though the user has no `openai:*` auth profile and no
  // codex CLI plugin installed. Once the migration learns to either (a)
  // skip rewriting when no compensating auth exists, (b) alias the
  // openai-codex profile under openai, or (c) keep the openai-codex
  // transport via `agentRuntime.id: "codex"` when only OAuth is present,
  // this test should pass and the `.fails` marker must be removed.
  it.fails(
    "preserves auth-resolvable model refs after the legacy openai-codex repair",
    () => {
      const cfg = buildOpenAICodexFixture();
      const result = maybeRepairCodexRoutes({ cfg, shouldRepair: true });

      const orphans = findModelRefsWithoutAuth(
        result.cfg,
        new Set(["openai-codex", "anthropic"]),
      );

      // Today this fails: every `openai-codex/*` ref was rewritten to
      // `openai/*`, but the user has no `openai:*` auth profile, so every
      // rewritten ref is an orphan.
      expect(orphans).toEqual([]);
    },
  );

  // GENERIC INVARIANT — any migration that mutates model refs must leave
  // every primary/fallback/catalog ref pointing at a provider for which
  // the user has at least one usable auth profile. This test passes today
  // on a no-op input and is wired up so future regressions of the same
  // shape (e.g. a renamed-provider migration that forgets to map auth)
  // can extend it cheaply.
  it("invariant holds when the fixture matches available auth providers", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: "openai-codex/gpt-5.5",
          modelOverride: { primary: "openai-codex/gpt-5.5" },
        },
      },
    } as unknown as OpenClawConfig;

    const orphans = findModelRefsWithoutAuth(
      cfg,
      new Set(["openai-codex", "anthropic"]),
    );

    expect(orphans).toEqual([]);
  });

  it("invariant detects orphan refs after a hypothetical bad migration", () => {
    const corruptedCfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          modelOverride: {
            primary: "openai/gpt-5.5",
            fallbacks: ["openai/gpt-5.4"],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const orphans = findModelRefsWithoutAuth(
      corruptedCfg,
      new Set(["openai-codex", "anthropic"]),
    );

    expect(orphans).toEqual(
      expect.arrayContaining([
        expect.stringContaining("openai/gpt-5.5"),
        expect.stringContaining("openai/gpt-5.4"),
      ]),
    );
  });
});
