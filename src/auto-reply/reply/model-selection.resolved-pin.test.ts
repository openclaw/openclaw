import { afterEach, expect, test, vi } from "vitest";
import { resolveCliRuntimeCanonicalProvider } from "../../agents/cli-backends.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { applyModelOverrideToSessionEntry } from "../../sessions/model-overrides.js";
import { resolveDirectStoredModelOverride } from "../../sessions/stored-model-overrides.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { createModelSelectionState } from "./model-selection.js";

vi.mock("../../agents/auth-profiles.runtime.js", () => ({
  ensureAuthProfileStore: () => ({ version: 1, profiles: {} }),
}));

afterEach(() => resetPluginRuntimeStateForTest());

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
  provider?: string;
  allow?: string[];
  readerModel?: string;
  raw?: boolean;
  disallowed?: boolean;
  inherited?: boolean;
  locked?: boolean;
  configuredProvider?: boolean;
  heartbeat?: boolean;
  oneTurn?: boolean;
  cli?: boolean;
  missingAuthPin?: boolean;
};

test.each<SelectionCase>([
  { name: "resolved provider-prefixed model", pin: "custom/model", expected: "custom/model" },
  { name: "resolved alias-like model", pin: "middle", expected: "middle" },
  { name: "legacy raw model", pin: "latest", expected: "final", raw: true },
  { name: "disallowed pin", pin: "denied", expected: "default", disallowed: true },
  { name: "explicit heartbeat override", pin: "middle", expected: "heartbeat", heartbeat: true },
  { name: "one-turn override", pin: "middle", expected: "once", oneTurn: true },
  { name: "bound CLI provider", pin: "cli-model", expected: "cli-model", cli: true },
  { name: "missing auth pin", pin: "plain-model", expected: "plain-model", missingAuthPin: true },
  {
    name: "resolved prefix rejected by a colliding exact allowlist",
    pin: "custom/model",
    expected: "default",
    allow: ["custom/default", "custom/model"],
    disallowed: true,
  },
  {
    name: "inherited resolved prefix rejected by a colliding exact allowlist",
    pin: "custom/model",
    expected: "default",
    allow: ["custom/default", "custom/model"],
    disallowed: true,
    inherited: true,
  },
  {
    name: "raw prefix allowed as the plain model",
    pin: "custom/model",
    expected: "model",
    readerModel: "model",
    allow: ["custom/default", "custom/model"],
    raw: true,
  },
  {
    name: "locked resolved prefix outside the exact allowlist",
    pin: "custom/model",
    expected: "custom/model",
    allow: ["custom/default", "custom/model"],
    locked: true,
  },
  {
    name: "resolved prefix allowed by the provider wildcard",
    pin: "custom/model",
    expected: "custom/model",
    allow: ["custom/*"],
  },
  {
    name: "inherited resolved prefix allowed by its namespace wildcard",
    pin: "custom/model",
    expected: "custom/model",
    allow: ["custom/default", "custom/custom/*"],
    inherited: true,
  },
  {
    name: "namespace wildcard rejects a different model prefix",
    pin: "customness/model",
    expected: "default",
    allow: ["custom/default", "custom/custom/*"],
    disallowed: true,
  },
  {
    name: "exact model namespace does not authorize another provider",
    provider: "custom/team",
    pin: "Reader",
    expected: "default",
    allow: ["custom/default", "custom/team/Reader"],
    disallowed: true,
  },
  {
    name: "provider wildcard does not authorize another provider",
    provider: "custom/team",
    pin: "Reader",
    expected: "default",
    allow: ["custom/*"],
    disallowed: true,
  },
  {
    name: "resolved prefix allowed by its exact configured ref",
    pin: "custom/model",
    expected: "custom/model",
    allow: ["custom/default", "custom/custom/model"],
    configuredProvider: true,
  },
  {
    name: "exact configured prefix does not authorize the plain model",
    pin: "model",
    expected: "default",
    allow: ["custom/default", "custom/custom/model"],
    configuredProvider: true,
    disallowed: true,
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
    registry.cliBackends.push({
      pluginId: "fixture",
      source: "fixture",
      backend: {
        id: "demo-cli",
        modelProvider: "custom",
        config: { command: "false", input: "arg", output: "text" },
      },
    });
    setActivePluginRegistry(registry);
    if (fixture.cli) {
      expect(
        resolveCliRuntimeCanonicalProvider({
          runtime: "demo-cli",
          config: cfg,
          includeSetupRegistry: true,
        }),
      ).toBe("custom");
    }
    const provider = fixture.provider ?? (fixture.cli ? "demo-cli" : "custom");
    const pinnedEntry: SessionEntry = { sessionId: "resolved-pin", updatedAt: 1 };
    applyModelOverrideToSessionEntry({
      entry: pinnedEntry,
      selection: { provider, model: fixture.pin },
      ...(fixture.missingAuthPin ? { profileOverride: "missing-test-profile" } : {}),
    });
    if (fixture.raw) {
      delete pinnedEntry.modelOverrideRouteResolution;
    }
    if (fixture.cli) {
      pinnedEntry.cliSessionBindings = { "demo-cli": { sessionId: "fixture-session" } };
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
        // A failure here belongs to the reader dependency, before this owner's live-turn path.
        expect(
          resolveDirectStoredModelOverride({
            sessionEntry: pinnedEntry,
            defaultProvider: "custom",
          }),
        ).toMatchObject({
          provider,
          model: fixture.readerModel ?? (fixture.raw ? "middle" : fixture.pin),
          routeResolution: fixture.raw ? "raw" : "resolved",
        });
        const selection = await createModelSelectionState({
          cfg,
          agentId: "main",
          agentCfg: cfg.agents?.defaults,
          sessionEntry: entry,
          sessionStore,
          sessionKey,
          parentSessionKey: fixture.inherited ? parentSessionKey : undefined,
          defaultProvider: "custom",
          defaultModel: "default",
          provider: "custom",
          model: fixture.oneTurn ? "once" : fixture.heartbeat ? "heartbeat" : "default",
          hasModelDirective: false,
          hasOneTurnModelOverride: fixture.oneTurn,
          isHeartbeat: fixture.heartbeat,
          hasResolvedHeartbeatModelOverride: fixture.heartbeat,
          preparedModelCatalog,
        });
        expect(selection).toMatchObject({
          provider: "custom",
          model: fixture.expected,
          resetModelOverride: fixture.disallowed === true && !fixture.inherited,
        });
        if (fixture.disallowed && !fixture.inherited) {
          expect(selection.resetModelOverrideReason).toBe("disallowed");
          expect(entry.modelOverride).toBeUndefined();
        } else {
          expect(pinnedEntry.modelOverride).toBe(fixture.pin);
        }
        if (fixture.inherited) {
          expect(entry.modelOverride).toBeUndefined();
        }
        if (fixture.missingAuthPin) {
          expect(entry.authProfileOverride).toBeUndefined();
        }
      },
    );
  });
});
