import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as authStore from "../agents/auth-profiles/store.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import * as pluginMetadata from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  applyModelOverrideWithAuthProfileCompatibilityAsync,
  applyModelOverrideWithAuthProfileCompatibilityCore as applyModelOverrideWithAuthProfileCompatibility,
  shouldPreserveSessionAuthProfileOverride,
} from "./auth-profile-preservation.js";

const workspaceAliasPlugin = {
  id: "fixture-provider",
  channels: [],
  providers: ["fixture-provider", "fixture-provider-plan"],
  cliBackends: [],
  skills: [],
  hooks: [],
  origin: "workspace",
  rootDir: "/plugins/fixture-provider",
  source: "test",
  manifestPath: "/plugins/fixture-provider/openclaw.plugin.json",
  providerAuthAliases: { "fixture-provider-plan": "fixture-provider" },
} satisfies PluginManifestRecord;

const metadataSnapshot = {
  plugins: [workspaceAliasPlugin],
} satisfies Pick<PluginMetadataSnapshot, "plugins">;

const entry = {
  sessionId: "session-auth-profile-preservation",
  updatedAt: 1,
  authProfileOverride: "fixture-provider:work",
} satisfies SessionEntry;

beforeEach(async () => {
  await pluginMetadata.resolvePluginMetadataSnapshotAsync({ config: {} });
});

describe("applyModelOverrideWithAuthProfileCompatibilityAsync", () => {
  it.each([false, true])("uses prepared aliases with a supplied snapshot: %s", async (supplied) => {
    const prepared = createPluginMetadataSnapshotFixture({ plugins: [workspaceAliasPlugin] });
    const resolveMetadata = vi
      .spyOn(pluginMetadata, "resolvePluginMetadataSnapshotAsync")
      .mockResolvedValue(prepared);
    const cfg: OpenClawConfig = {
      plugins: { entries: { "fixture-provider": { enabled: true } } },
    };
    const selected = { ...entry };
    try {
      await applyModelOverrideWithAuthProfileCompatibilityAsync({
        cfg,
        agentDir: "/fixture/agent",
        entry: selected,
        currentProvider: "fixture-provider",
        selection: { provider: "fixture-provider-plan", model: "selected-model" },
        recordedProvider: { provider: "fixture-provider" },
        ...(supplied ? { metadataSnapshot: prepared } : {}),
      });
      expect(selected.authProfileOverride).toBe("fixture-provider:work");
      if (supplied) {
        expect(resolveMetadata).not.toHaveBeenCalled();
      } else {
        expect(resolveMetadata).toHaveBeenCalledExactlyOnceWith({
          config: cfg,
          allowWorkspaceScopedCurrent: true,
        });
      }
    } finally {
      resolveMetadata.mockRestore();
    }
  });
});

describe("shouldPreserveSessionAuthProfileOverride", () => {
  it.each([
    { provider: "openai", configured: "anthropic", expected: true },
    { provider: "anthropic", configured: "openai", expected: false },
    { provider: undefined, configured: "openai", expected: true },
    { provider: undefined, configured: undefined, expected: true },
  ])(
    "consumes prepared provider $provider before config $configured without synchronous reads",
    ({ provider, configured, expected }) => {
      const persisted = vi
        .spyOn(authStore, "findPersistedAuthProfileCredential")
        .mockImplementation(() => {
          throw new Error("synchronous credential read");
        });
      const snapshot = vi
        .spyOn(authStore, "getRuntimeAuthProfileStoreSnapshot")
        .mockImplementation(() => {
          throw new Error("unprepared snapshot read");
        });
      try {
        const cfg: OpenClawConfig = configured
          ? {
              auth: {
                profiles: { "openai:missing": { provider: configured, mode: "api_key" } },
              },
            }
          : {};
        expect(
          shouldPreserveSessionAuthProfileOverride({
            cfg,
            agentDir: "/fixture/agent",
            entry: { ...entry, authProfileOverride: "openai:missing" },
            currentProvider: "openai",
            provider: "openai",
            recordedProvider: { provider },
          }),
        ).toBe(expected);
        const selectedEntry = { ...entry, authProfileOverride: "openai:missing" };
        applyModelOverrideWithAuthProfileCompatibility({
          cfg,
          agentDir: "/fixture/agent",
          entry: selectedEntry,
          currentProvider: "openai",
          selection: { provider: "openai", model: "selected-model" },
          recordedProvider: { provider },
        });
        expect(selectedEntry.authProfileOverride).toBe(expected ? "openai:missing" : undefined);
        expect(persisted).not.toHaveBeenCalled();
        expect(snapshot).not.toHaveBeenCalled();
      } finally {
        persisted.mockRestore();
        snapshot.mockRestore();
      }
    },
  );
  it.each([
    { credentialProvider: "arcee", expected: false },
    { credentialProvider: "openrouter", expected: true },
  ])(
    "checks a pin's stored $credentialProvider realm against the configured endpoint",
    ({ credentialProvider, expected }) => {
      const plugin: PluginManifestRecord = {
        ...workspaceAliasPlugin,
        id: "arcee",
        origin: "bundled",
        providers: ["arcee"],
        providerAuthAliases: {
          arcee: { provider: "openrouter", baseUrls: ["https://openrouter.ai/api/v1"] },
        },
      };
      expect(
        shouldPreserveSessionAuthProfileOverride({
          cfg: {
            models: {
              providers: { arcee: { baseUrl: "https://openrouter.ai/api/v1", models: [] } },
            },
            auth: { profiles: { "team:prod": { provider: credentialProvider, mode: "api_key" } } },
          },
          agentDir: "/fixture/agent",
          entry: { ...entry, authProfileOverride: "team:prod" },
          currentProvider: "arcee",
          provider: "arcee",
          recordedProvider: { provider: undefined },
          metadataSnapshot: { plugins: [plugin] },
        }),
      ).toBe(expected);
    },
  );

  it("uses config trust when resolving workspace provider aliases", () => {
    const allowedConfig = {
      plugins: { entries: { "fixture-provider": { enabled: true } } },
    } satisfies OpenClawConfig;

    expect(
      shouldPreserveSessionAuthProfileOverride({
        cfg: allowedConfig,
        agentDir: "/tmp/openclaw-auth-profile-preservation-allowed",
        entry,
        currentProvider: "fixture-provider",
        provider: "fixture-provider-plan",
        recordedProvider: { provider: undefined },
        metadataSnapshot,
      }),
    ).toBe(true);
    expect(
      shouldPreserveSessionAuthProfileOverride({
        cfg: {},
        agentDir: "/tmp/openclaw-auth-profile-preservation-denied",
        entry,
        currentProvider: "fixture-provider",
        provider: "fixture-provider-plan",
        recordedProvider: { provider: undefined },
        metadataSnapshot,
      }),
    ).toBe(false);
  });

  it("uses the recorded provider for an arbitrary stored profile id", () => {
    const agentDir = "/fixture/agent";
    expect(
      shouldPreserveSessionAuthProfileOverride({
        cfg: {},
        agentDir,
        entry: { ...entry, authProfileOverride: "team:prod" },
        currentProvider: "openai",
        provider: "openai",
        recordedProvider: { provider: "openai" },
      }),
    ).toBe(true);
    expect(
      shouldPreserveSessionAuthProfileOverride({
        cfg: {},
        agentDir,
        entry: { ...entry, authProfileOverride: "team:prod" },
        currentProvider: "openai",
        provider: "anthropic",
        recordedProvider: { provider: "openai" },
      }),
    ).toBe(false);
  });

  it.each(["openai", "anthropic"])(
    "retains a missing personal pin only when the selected provider %s is compatible",
    (provider) => {
      const personalId = `personal:${randomUUID()}:${randomUUID()}`;
      const sessionEntry: SessionEntry = {
        ...entry,
        authProfileOverride: personalId,
        authProfileOverrideSource: "user-link",
      };

      applyModelOverrideWithAuthProfileCompatibility({
        cfg: {},
        agentDir: "/fixture/agent",
        entry: sessionEntry,
        currentProvider: "openai",
        selection: { provider, model: "another-model" },
        recordedProvider: { provider: undefined },
      });

      expect(sessionEntry.authProfileOverride).toBe(provider === "openai" ? personalId : undefined);
      expect(sessionEntry.authProfileOverrideSource).toBe(
        provider === "openai" ? "user-link" : undefined,
      );
    },
  );

  it.each([
    {
      name: "retains a compatible auth profile when resetting to a same-provider default",
      provider: "openai",
      model: "gpt-5",
      expectedProfile: "team:prod",
      expectedSource: "user" as const,
      expectedCompactionCount: 2,
    },
    {
      name: "clears an incompatible auth profile when resetting to a cross-provider default",
      provider: "anthropic",
      model: "claude-opus-4-6",
      expectedProfile: undefined,
      expectedSource: undefined,
      expectedCompactionCount: undefined,
    },
  ])("$name", ({ provider, model, expectedProfile, expectedSource, expectedCompactionCount }) => {
    const sessionEntry = {
      ...entry,
      providerOverride: "openai",
      modelOverride: "gpt-4.1",
      modelOverrideSource: "user" as const,
      authProfileOverride: "team:prod",
      authProfileOverrideSource: "user" as const,
      authProfileOverrideCompactionCount: 2,
    };

    const result = applyModelOverrideWithAuthProfileCompatibility({
      cfg: {
        auth: { profiles: { "team:prod": { provider: "openai", mode: "api_key" } } },
      },
      agentDir: "/fixture/agent",
      entry: sessionEntry,
      currentProvider: "openai",
      selection: { provider, model, isDefault: true },
      recordedProvider: { provider: undefined },
    });

    expect(result.updated).toBe(true);
    expect(sessionEntry.providerOverride).toBeUndefined();
    expect(sessionEntry.modelOverride).toBeUndefined();
    expect(sessionEntry.modelOverrideSource).toBeUndefined();
    expect(sessionEntry.authProfileOverride).toBe(expectedProfile);
    expect(sessionEntry.authProfileOverrideSource).toBe(expectedSource);
    expect(sessionEntry.authProfileOverrideCompactionCount).toBe(expectedCompactionCount);
  });
});
