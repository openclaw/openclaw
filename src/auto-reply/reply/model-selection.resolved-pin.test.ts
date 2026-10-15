import { afterEach, expect, test, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
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

test("keeps thinking defaults separate for distinct literal model IDs", async () => {
  await withStateDirEnv("reply-thinking-identities-", async () => {
    const selection = await createModelSelectionState({
      agentId: "main",
      cfg: { plugins: { enabled: false } },
      agentCfg: undefined,
      defaultProvider: "custom",
      defaultModel: "model",
      provider: "custom",
      model: "model",
      hasModelDirective: false,
      preparedModelCatalog: {
        routeVariants: [],
        entries: [
          { provider: "custom", id: "model", name: "Plain", reasoning: false },
          { provider: "custom", id: "custom/model", name: "Namespaced", reasoning: true },
        ],
      },
    });
    expect(
      await selection.resolveDefaultThinkingLevel({
        provider: "custom",
        model: "model",
        agentRuntime: "openclaw",
      }),
    ).toBe("off");
    expect(
      await selection.resolveDefaultThinkingLevel({
        provider: "custom",
        model: "custom/model",
        agentRuntime: "openclaw",
      }),
    ).toBe("medium");
  });
});

const metadataSnapshot = createPluginMetadataSnapshotFixture({
  plugins: [
    {
      id: "fixture",
      providers: ["custom", "demo-cli"],
      modelIdNormalization: {
        providers: { custom: { aliases: { latest: "middle", middle: "final" } } },
      },
    },
  ],
});

type SelectionCase = {
  name: string;
  pin: string;
  expected: string;
  allow?: string[];
  raw?: boolean;
  disallowed?: boolean;
  inherited?: boolean;
  locked?: boolean;
  configuredProvider?: boolean;
  turnOverride?: boolean;
  operatorRestricted?: boolean;
  operatorRejected?: boolean;
};

test.each<SelectionCase>([
  { name: "resolved alias-like model", pin: "middle", expected: "middle" },
  { name: "legacy raw model normalized once", pin: "latest", expected: "middle", raw: true },
  { name: "explicit turn override", pin: "middle", expected: "override", turnOverride: true },
  { name: "role-denied stored pin", pin: "middle", expected: "default", operatorRestricted: true },
  {
    name: "role-denied inherited pin",
    pin: "middle",
    expected: "default",
    inherited: true,
    operatorRestricted: true,
  },
  {
    name: "role-denied locked pin",
    pin: "middle",
    expected: "middle",
    locked: true,
    operatorRestricted: true,
    operatorRejected: true,
  },
  {
    name: "resolved prefix rejected by a colliding exact allowlist",
    pin: "custom/model",
    expected: "default",
    allow: ["custom/default", "custom/model"],
    disallowed: true,
  },
  {
    name: "inherited raw prefix allowed as the plain model",
    pin: "custom/model",
    expected: "model",
    allow: ["custom/default", "custom/model"],
    raw: true,
    inherited: true,
  },
  {
    name: "locked resolved prefix outside the exact allowlist",
    pin: "custom/model",
    expected: "custom/model",
    allow: ["custom/default", "custom/model"],
    locked: true,
  },
  {
    name: "inherited resolved prefix allowed by its namespace wildcard",
    pin: "custom/model",
    expected: "custom/model",
    allow: ["custom/default", "custom/custom/*"],
    inherited: true,
  },
  {
    name: "resolved prefix allowed by its exact configured ref",
    pin: "custom/model",
    expected: "custom/model",
    allow: ["custom/default", "custom/custom/model"],
    configuredProvider: true,
  },
])("selects $name through the reply owner", async (fixture) => {
  await withStateDirEnv("reply-resolved-pin-", async () => {
    const allow = fixture.allow ?? (fixture.disallowed ? ["custom/default"] : undefined);
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      agents: {
        entries: { main: {} },
        defaults: {
          model: "custom/default",
          ...(allow ? { modelPolicy: { allow } } : {}),
        },
      },
      ...(fixture.configuredProvider
        ? {
            models: {
              providers: {
                custom: {
                  api: "openai-responses",
                  baseUrl: "https://custom.example/v1",
                  models: [],
                },
              },
            },
          }
        : {}),
    };
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry);
    const provider = "custom";
    const pinnedEntry: SessionEntry = { sessionId: "resolved-pin", updatedAt: 1 };
    applyModelOverrideToSessionEntry({
      entry: pinnedEntry,
      selection: { provider, model: fixture.pin },
    });
    if (fixture.raw) {
      delete pinnedEntry.modelOverrideRouteResolution;
    }
    const entry: SessionEntry = fixture.inherited
      ? { sessionId: "child", updatedAt: 1 }
      : pinnedEntry;
    if (fixture.locked) {
      entry.modelSelectionLocked = true;
    }
    const sessionKey = "agent:main:resolved-pin";
    const parentSessionKey = "agent:main:parent-pin";
    const sessionStore = {
      [sessionKey]: entry,
      ...(fixture.inherited ? { [parentSessionKey]: pinnedEntry } : {}),
    };
    const entries = [
      "default",
      "model",
      "custom/model",
      "customness/model",
      "team/Reader",
      "middle",
      "final",
      "denied",
      "cli-model",
      "plain-model",
    ].map((id) => ({ provider: "custom", id, name: id }));
    entries.push({ provider: "custom/team", id: "Reader", name: "Other provider" });
    const preparedModelCatalog: ModelCatalogSnapshot = {
      entries,
      routeVariants: entries,
      authoritative: true,
    };
    await withPluginRuntimeGenerationScope(
      { metadataSnapshot, pluginRegistry: registry },
      async () => {
        const pendingSelection = createModelSelectionState({
          cfg,
          agentId: "main",
          agentCfg: cfg.agents?.defaults,
          sessionEntry: entry,
          sessionStore,
          sessionKey,
          parentSessionKey: fixture.inherited ? parentSessionKey : undefined,
          defaultProvider: "custom",
          defaultModel: "default",
          provider: fixture.inherited ? provider : "custom",
          model: fixture.turnOverride ? "override" : fixture.inherited ? fixture.pin : "default",
          hasModelDirective: false,
          hasResolvedTurnModelOverride: fixture.turnOverride,
          preparedModelCatalog,
          ...(fixture.operatorRestricted
            ? {
                operatorAuthority: createAdmittedRunOperatorAuthority({
                  profileId: "limited-operator",
                  scopes: ["operator.write"],
                  assertCurrent: () => {},
                  modelPolicy: prepareOperatorModelPolicy({ cfg, policy: { sourceAgent: "main" } }),
                }),
              }
            : {}),
        });
        if (fixture.operatorRejected) {
          await expect(pendingSelection).rejects.toThrow(
            "Your operator role cannot use this model",
          );
          expect(pinnedEntry.modelOverride).toBe(fixture.pin);
          return;
        }
        const selection = await pendingSelection;
        expect(selection).toMatchObject({
          provider: "custom",
          model: fixture.expected,
          resetModelOverride: fixture.disallowed === true && !fixture.inherited,
        });
        if (fixture.disallowed) {
          expect(selection.resetModelOverrideReason).toBe("disallowed");
        }
        if (fixture.disallowed && !fixture.inherited) {
          expect(entry.modelOverride).toBeUndefined();
        } else {
          expect(pinnedEntry.modelOverride).toBe(fixture.pin);
        }
        if (fixture.inherited) {
          expect(entry.modelOverride).toBeUndefined();
        }
      },
    );
  });
});
