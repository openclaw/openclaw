import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as authStoreRuntime from "../agents/auth-profiles/store-runtime.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import * as authStore from "../agents/auth-profiles/store.js";
import { withEnvOnlyAuthProfileStore } from "../agents/auth-profiles/store.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  applyModelOverrideWithAuthProfileCompatibility,
  prepareUnavailableSessionAuthProfileOverride,
  shouldPreserveSessionAuthProfileOverride,
  shouldPreserveUnavailableSessionAuthProfileOverride,
} from "./auth-profile-preservation.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

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

describe("shouldPreserveSessionAuthProfileOverride", () => {
  it.each(["", " "])("does not read provider metadata for an empty target %j", (provider) => {
    const lookup = vi.spyOn(authStore, "resolveAuthProfileProviderForSelection");
    expect(
      shouldPreserveSessionAuthProfileOverride({
        cfg: {},
        entry,
        currentProvider: "openai",
        provider,
      }),
    ).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    { provider: undefined, configured: "openai", expected: true },
    { provider: "anthropic", configured: "openai", expected: false },
    { provider: "openai", configured: "anthropic", expected: true },
  ])(
    "uses the prepared $provider fact before config without synchronous reads",
    ({ provider, configured, expected }) => {
      const lookup = vi
        .spyOn(authStore, "resolveAuthProfileProviderForSelection")
        .mockImplementation(() => {
          throw new Error("unexpected synchronous provider read");
        });
      expect(
        shouldPreserveUnavailableSessionAuthProfileOverride({
          cfg: {
            auth: { profiles: { "team:account": { provider: configured, mode: "api_key" } } },
          },
          entry: {
            ...entry,
            authProfileOverride: "team:account",
            authProfileOverrideSource: "user",
          },
          currentProvider: "anthropic",
          provider: "openai",
          store: { profiles: {} },
          preparedProfile: { profileId: "team:account", provider },
        }),
      ).toBe(expected);
      expect(lookup).not.toHaveBeenCalled();
    },
  );

  it.each([
    "pin",
    "source",
    "compaction",
    "session",
    "row",
    "distinct-row-pin",
    "distinct-row-source",
  ] as const)(
    "rejects a changed %s after provider preparation without mutating the newer selection",
    async (change) => {
      const started = createDeferredCore();
      const read = createDeferredCore<{ profileId: string; provider: string | undefined }>();
      vi.spyOn(authStoreRuntime, "prepareAuthProfileProviderForSelection").mockImplementation(
        () => {
          started.resolve();
          return read.promise;
        },
      );
      const selected: SessionEntry = { ...entry, authProfileOverrideSource: "user" };
      const sessionStore = {
        selected: change.startsWith("distinct-row") ? { ...selected } : selected,
      };
      const preparing = prepareUnavailableSessionAuthProfileOverride({
        entry: selected,
        store: { profiles: {} },
        sessionStore,
        sessionKey: "selected",
      });
      if (!preparing) {
        throw new Error("expected provider preparation for the missing user pin");
      }
      try {
        await Promise.race([
          started.promise,
          preparing.then(() => {
            throw new Error("provider preparation completed before its read barrier");
          }),
        ]);
        if (change === "pin") {
          selected.authProfileOverride = "openai:new";
        }
        if (change === "source") {
          selected.authProfileOverrideSource = "auto";
        }
        if (change === "compaction") {
          selected.authProfileOverrideCompactionCount = 2;
        }
        if (change === "session") {
          selected.sessionId = "replacement-session";
        }
        if (change === "row") {
          sessionStore.selected = { ...selected, authProfileOverride: "openai:new" };
        }
        if (change === "distinct-row-pin") {
          sessionStore.selected.authProfileOverride = "openai:new";
        }
        if (change === "distinct-row-source") {
          sessionStore.selected.authProfileOverrideSource = "auto";
        }
        const before = { entry: { ...selected }, row: { ...sessionStore.selected } };
        read.resolve({ profileId: entry.authProfileOverride, provider: "openai" });
        await expect(preparing).rejects.toThrow("Session auth profile changed");
        expect(selected).toEqual(before.entry);
        expect(sessionStore.selected).toEqual(before.row);
      } finally {
        read.resolve({ profileId: entry.authProfileOverride, provider: "openai" });
        await Promise.allSettled([preparing]);
      }
    },
  );

  it("does not introduce an async read for existing credentials or automatic pins", () => {
    const read = vi.spyOn(authStoreRuntime, "prepareAuthProfileProviderForSelection");
    expect(
      prepareUnavailableSessionAuthProfileOverride({
        entry: { ...entry, authProfileOverrideSource: "auto" },
        store: { profiles: {} },
      }),
    ).toBeUndefined();
    expect(
      prepareUnavailableSessionAuthProfileOverride({
        entry: { ...entry, authProfileOverrideSource: "user" },
        store: {
          profiles: {
            [entry.authProfileOverride]: { type: "api_key", provider: "openai", key: "fixture" },
          },
        },
      }),
    ).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it("uses shared provider metadata when the agent directory is omitted", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const profileId = "team:account";
      const saveOptions = { filterExternalAuthProfiles: false, syncExternalCli: false };
      saveAuthProfileStore(
        {
          version: 1,
          profiles: { [profileId]: { type: "api_key", provider: "openai", key: "shared" } },
        },
        undefined,
        saveOptions,
      );
      saveAuthProfileStore(
        {
          version: 1,
          profiles: { [profileId]: { type: "api_key", provider: "anthropic", key: "local" } },
        },
        state.agentDir("configured"),
        saveOptions,
      );
      const params = {
        cfg: {},
        entry: { ...entry, authProfileOverride: profileId },
        currentProvider: "openai",
        provider: "openai",
      };
      expect(shouldPreserveSessionAuthProfileOverride(params)).toBe(true);
      expect(
        shouldPreserveSessionAuthProfileOverride({
          ...params,
          agentDir: state.agentDir("configured"),
        }),
      ).toBe(false);
    });
  });

  it.each([
    { profileId: "team:account", configuredProvider: "openai", currentProvider: "anthropic" },
    { profileId: "openai:removed", configuredProvider: undefined, currentProvider: "anthropic" },
    { profileId: "removed-account", configuredProvider: undefined, currentProvider: "openai" },
  ])("keeps unavailable intent from metadata for $profileId", (testCase) => {
    const cfg: OpenClawConfig = testCase.configuredProvider
      ? {
          auth: {
            profiles: {
              [testCase.profileId]: { provider: testCase.configuredProvider, mode: "api_key" },
            },
          },
        }
      : {};
    expect(
      withEnvOnlyAuthProfileStore(() =>
        shouldPreserveUnavailableSessionAuthProfileOverride({
          cfg,
          entry: {
            ...entry,
            authProfileOverride: testCase.profileId,
            authProfileOverrideSource: "user",
          },
          currentProvider: testCase.currentProvider,
          provider: "openai",
          store: { profiles: {} },
          preparedProfile: { profileId: testCase.profileId, provider: undefined },
        }),
      ),
    ).toBe(true);
  });

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
          agentDir: tempDirs.make("openclaw-endpoint-profile-pin-"),
          entry: { ...entry, authProfileOverride: "team:prod" },
          currentProvider: "arcee",
          provider: "arcee",
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
        metadataSnapshot,
      }),
    ).toBe(false);
  });

  it("uses the recorded provider for an arbitrary stored profile id", () => {
    const agentDir = tempDirs.make("openclaw-auth-profile-preservation-");
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "team:prod": { type: "api_key", provider: "openai", key: "test" },
        },
      },
      agentDir,
    );

    expect(
      shouldPreserveSessionAuthProfileOverride({
        cfg: {},
        agentDir,
        entry: { ...entry, authProfileOverride: "team:prod" },
        currentProvider: "openai",
        provider: "openai",
      }),
    ).toBe(true);
    expect(
      shouldPreserveSessionAuthProfileOverride({
        cfg: {},
        agentDir,
        entry: { ...entry, authProfileOverride: "team:prod" },
        currentProvider: "openai",
        provider: "anthropic",
      }),
    ).toBe(false);
  });

  it("uses the configured provider for an arbitrary profile id", () => {
    expect(
      shouldPreserveSessionAuthProfileOverride({
        cfg: {
          auth: { profiles: { "team:prod": { provider: "openai", mode: "api_key" } } },
        },
        agentDir: tempDirs.make("openclaw-auth-profile-config-"),
        entry: { ...entry, authProfileOverride: "team:prod" },
        currentProvider: "openai",
        provider: "openai",
      }),
    ).toBe(true);
  });

  it.each(["openai", "anthropic"])(
    "retains a missing personal pin only when the selected provider %s is compatible",
    async (provider) => {
      await withOpenClawTestState({ layout: "state-only" }, async (state) => {
        const personalId = `personal:${randomUUID()}:${randomUUID()}`;
        const sessionEntry: SessionEntry = {
          ...entry,
          authProfileOverride: personalId,
          authProfileOverrideSource: "user-link",
        };

        applyModelOverrideWithAuthProfileCompatibility({
          cfg: {},
          agentDir: state.agentDir(),
          entry: sessionEntry,
          currentProvider: "openai",
          selection: { provider, model: "another-model" },
        });

        expect(sessionEntry.authProfileOverride).toBe(
          provider === "openai" ? personalId : undefined,
        );
        expect(sessionEntry.authProfileOverrideSource).toBe(
          provider === "openai" ? "user-link" : undefined,
        );
      });
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
      agentDir: tempDirs.make("openclaw-auth-profile-default-"),
      entry: sessionEntry,
      currentProvider: "openai",
      selection: { provider, model, isDefault: true },
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
