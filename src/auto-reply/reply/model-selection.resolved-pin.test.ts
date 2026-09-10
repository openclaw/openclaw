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
  raw?: boolean;
  disallowed?: boolean;
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
])("selects $name through the reply owner", async (fixture) => {
  await withStateDirEnv("reply-resolved-pin-", async () => {
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      agents: {
        entries: { main: {} },
        defaults: {
          model: "custom/default",
          ...(fixture.disallowed ? { modelPolicy: { allow: ["custom/default"] } } : {}),
        },
      },
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
    const provider = fixture.cli ? "demo-cli" : "custom";
    const entry: SessionEntry = { sessionId: "resolved-pin", updatedAt: 1 };
    applyModelOverrideToSessionEntry({
      entry,
      selection: { provider, model: fixture.pin },
      ...(fixture.missingAuthPin ? { profileOverride: "missing-test-profile" } : {}),
    });
    if (fixture.raw) {
      delete entry.modelOverrideRouteResolution;
    }
    if (fixture.cli) {
      entry.cliSessionBindings = { "demo-cli": { sessionId: "fixture-session" } };
    }
    const sessionKey = "agent:main:resolved-pin";
    const entries = [
      "default",
      "custom/model",
      "middle",
      "final",
      "denied",
      "cli-model",
      "plain-model",
    ].map((id) => ({ provider: "custom", id, name: id }));
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
          resolveDirectStoredModelOverride({ sessionEntry: entry, defaultProvider: "custom" }),
        ).toMatchObject({
          provider,
          model: fixture.raw ? "middle" : fixture.pin,
          routeResolution: fixture.raw ? "raw" : "resolved",
        });
        const selection = await createModelSelectionState({
          cfg,
          agentId: "main",
          agentCfg: cfg.agents?.defaults,
          sessionEntry: entry,
          sessionStore: { [sessionKey]: entry },
          sessionKey,
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
          resetModelOverride: fixture.disallowed === true,
        });
        if (fixture.disallowed) {
          expect(selection.resetModelOverrideReason).toBe("disallowed");
          expect(entry.modelOverride).toBeUndefined();
        } else {
          expect(entry.modelOverride).toBe(fixture.pin);
        }
        if (fixture.missingAuthPin) {
          expect(entry.authProfileOverride).toBeUndefined();
        }
      },
    );
  });
});
