import { afterEach, expect, test, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { prepareOperatorModelPolicy } from "../../agents/operator-model-policy.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { applyModelOverrideToSessionEntry } from "../../sessions/model-overrides.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { createModelSelectionState } from "./model-selection.js";

// mock-isolation: Literal model identity cases use an empty store without discovering host accounts.
vi.mock("../../agents/auth-profiles.runtime.js", () => ({
  ensureAuthProfileStoreAsync: () => ({ version: 1, profiles: {} }),
}));

afterEach(() => resetPluginRuntimeStateForTest());

test.each<[string, string | undefined, string | undefined, boolean, string | undefined]>([
  ["configured selection", "openai", "gpt-x", false, "openai"],
  ["trimmed selection", " openai ", " gpt-x ", false, "openai"],
  ["another provider", "other", "gpt-x", true, "openai"],
  ["incomplete origin", "openai", undefined, true, "openai"],
  ["case-distinct model", "openai", "GPT-X", true, "openai"],
  ["blank override provider", "openai", "gpt-x", true, " "],
])(
  "Codex cleanup preserves only complete self-origin selections: %s",
  async (_name, originProvider, originModel, reset, providerOverride) =>
    withStateDirEnv("reply-codex-self-origin-", async () => {
      const entry: SessionEntry = {
        sessionId: "child",
        updatedAt: 1,
        providerOverride,
        modelOverride: "gpt-x",
        modelOverrideSource: "auto",
        modelOverrideRouteResolution: "resolved",
        modelOverrideFallbackOriginProvider: originProvider,
        modelOverrideFallbackOriginModel: originModel,
      };
      const before = { ...entry };
      const selection = await selectModel({
        cfg: {
          plugins: { enabled: false },
          agents: { defaults: { models: { "openai/gpt-x": { agentRuntime: { id: "codex" } } } } },
        },
        sessionEntry: entry,
        sessionStore: { child: entry },
        sessionKey: "child",
        defaultProvider: "openai",
        defaultModel: "gpt-x",
        provider: "openai",
        model: "gpt-x",
      });
      expect(selection.resetModelOverride).toBe(reset);
      expect(entry.modelOverride).toBe(reset ? undefined : "gpt-x");
      if (!reset) {
        expect(entry).toEqual(before);
      }
      expect(selection).toMatchObject({ provider: "openai", model: "gpt-x" });
    }),
);
function selectModel(params: Partial<Parameters<typeof createModelSelectionState>[0]>) {
  return createModelSelectionState({
    agentId: "main",
    cfg: { plugins: { enabled: false } },
    agentCfg: undefined,
    defaultProvider: "custom",
    defaultModel: "model",
    provider: "custom",
    model: "model",
    hasModelDirective: false,
    ...params,
  });
}

test("keeps thinking defaults separate for distinct literal model IDs", async () =>
  withStateDirEnv("reply-thinking-identities-", async () => {
    const selection = await selectModel({
      preparedModelCatalog: {
        routeVariants: [],
        entries: [
          { provider: "custom", id: "model", name: "Plain", reasoning: false },
          { provider: "custom", id: "custom/model", name: "Namespaced", reasoning: true },
        ],
      },
    });
    const thinking = (model: string) =>
      selection.resolveDefaultThinkingLevel({
        provider: "custom",
        model,
        agentRuntime: "openclaw",
      });
    expect(await thinking("model")).toBe("off");
    expect(await thinking("custom/model")).toBe("medium");
  }));

const metadataSnapshot = createPluginMetadataSnapshotFixture({
  plugins: [
    {
      id: "fixture",
      providers: ["custom"],
      modelIdNormalization: {
        providers: { custom: { aliases: { latest: "middle", middle: "final" } } },
      },
    },
  ],
});

type SelectionOptions = {
  allow?: string[];
  raw?: boolean;
  disallowed?: boolean;
  inherited?: boolean;
  locked?: boolean;
  configuredProvider?: boolean;
  turnOverride?: boolean;
  operator?: "stored" | "inherited" | "locked";
};

const exactAllow = ["custom/default", "custom/model"];
const wildcardAllow = ["custom/default", "custom/custom/*"];
const configuredAllow = ["custom/default", "custom/custom/model"];
const literal = "custom/model";
test.each<[string, string, string, SelectionOptions]>([
  ["resolved alias-like model", "middle", "middle", {}],
  ["legacy normalization once", "latest", "middle", { raw: true }],
  ["scheduled override", "middle", "scheduled", { turnOverride: true }],
  ["role-denied stored pin", "middle", "default", { operator: "stored" }],
  ["role-denied inherited pin", "middle", "default", { operator: "inherited" }],
  ["role-denied locked pin", "middle", "middle", { operator: "locked" }],
  ["colliding exact allowlist", literal, "default", { allow: exactAllow, disallowed: true }],
  ["raw inherited prefix", literal, "model", { allow: exactAllow, raw: true, inherited: true }],
  ["locked resolved prefix", literal, literal, { allow: exactAllow, locked: true }],
  ["inherited namespace wildcard", literal, literal, { allow: wildcardAllow, inherited: true }],
  ["exact configured ref", literal, literal, { allow: configuredAllow, configuredProvider: true }],
])("selects %s through the reply owner", async (_name, pin, expected, fixture) =>
  withStateDirEnv("reply-resolved-pin-", async () => {
    const allow = fixture.allow;
    const inherited = fixture.inherited || fixture.operator === "inherited";
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      agents: {
        entries: { main: {} },
        defaults: {
          model: "custom/default",
          modelPolicy: allow ? { allow } : undefined,
        },
      },
    };
    if (fixture.configuredProvider) {
      cfg.models = {
        providers: {
          custom: { api: "openai-responses", baseUrl: "https://custom.example/v1", models: [] },
        },
      };
    }
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry);
    const pinnedEntry: SessionEntry = { sessionId: "resolved-pin", updatedAt: 1 };
    applyModelOverrideToSessionEntry({
      entry: pinnedEntry,
      selection: { provider: "custom", model: pin },
    });
    if (fixture.raw) {
      delete pinnedEntry.modelOverrideRouteResolution;
    }
    const entry: SessionEntry = inherited ? { sessionId: "child", updatedAt: 1 } : pinnedEntry;
    if (fixture.locked || fixture.operator === "locked") {
      entry.modelSelectionLocked = true;
    }
    const sessionKey = "agent:main:resolved-pin";
    const parentSessionKey = "agent:main:parent-pin";
    const sessionStore = {
      [sessionKey]: entry,
      ...(inherited ? { [parentSessionKey]: pinnedEntry } : {}),
    };
    const entries = ["default", "model", "custom/model", "middle", "final", "scheduled"].map(
      (id) => ({ provider: "custom", id, name: id }),
    );
    await withPluginRuntimeGenerationScope(
      { metadataSnapshot, pluginRegistry: registry },
      async () => {
        const pendingSelection = selectModel({
          cfg,
          agentCfg: cfg.agents?.defaults,
          sessionEntry: entry,
          sessionStore,
          sessionKey,
          parentSessionKey: inherited ? parentSessionKey : undefined,
          defaultModel: "default",
          model: fixture.turnOverride ? "scheduled" : inherited ? pin : "default",
          hasResolvedTurnModelOverride: fixture.turnOverride,
          preparedModelCatalog: { entries, routeVariants: entries, authoritative: true },
          operatorAuthority: fixture.operator
            ? createAdmittedRunOperatorAuthority({
                profileId: "limited-operator",
                scopes: ["operator.write"],
                assertCurrent: () => {},
                modelPolicy: prepareOperatorModelPolicy({ cfg, policy: { sourceAgent: "main" } }),
              })
            : undefined,
        });
        if (fixture.operator === "locked") {
          await expect(pendingSelection).rejects.toThrow(
            "Your operator role cannot use this model",
          );
          expect(pinnedEntry.modelOverride).toBe(pin);
          return;
        }
        const selection = await pendingSelection;
        expect(selection).toMatchObject({
          provider: "custom",
          model: expected,
          resetModelOverride: fixture.disallowed === true && !inherited,
        });
        if (fixture.disallowed) {
          expect(selection.resetModelOverrideReason).toBe("disallowed");
        }
        expect(pinnedEntry.modelOverride).toBe(fixture.disallowed && !inherited ? undefined : pin);
        if (inherited) {
          expect(entry.modelOverride).toBeUndefined();
        }
      },
    );
  }),
);
