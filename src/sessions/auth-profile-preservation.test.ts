import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import * as authStore from "../agents/auth-profiles/store.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  applyModelOverrideWithAuthProfileCompatibility,
  shouldPreserveSessionAuthProfileOverride,
} from "./auth-profile-preservation.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeAll(async () => {
  await prepareSharedAuthStoreOwnership();
});

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

function preserves(
  overrides: Partial<Parameters<typeof shouldPreserveSessionAuthProfileOverride>[0]>,
) {
  return shouldPreserveSessionAuthProfileOverride({
    cfg: {},
    agentDir: "/fixture/agent",
    entry,
    currentProvider: "openai",
    provider: "openai",
    ...overrides,
  });
}

describe("shouldPreserveSessionAuthProfileOverride", () => {
  it.each([
    { provider: "openai", configured: "anthropic", expected: true },
    { provider: "anthropic", configured: "openai", expected: false },
    { provider: undefined, configured: "openai", expected: true },
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
        const selectedEntry = { ...entry, authProfileOverride: "openai:missing" };
        const cfg: OpenClawConfig = {
          auth: { profiles: { "openai:missing": { provider: configured, mode: "api_key" } } },
        };
        const params = {
          cfg,
          agentDir: "/fixture/agent",
          entry: selectedEntry,
          currentProvider: "openai",
          recordedProvider: { provider },
        };
        expect(preserves(params)).toBe(expected);
        applyModelOverrideWithAuthProfileCompatibility({
          ...params,
          selection: { provider: "openai", model: "selected-model" },
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
        preserves({
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
    const params = {
      currentProvider: "fixture-provider",
      provider: "fixture-provider-plan",
      metadataSnapshot,
    };
    expect(
      preserves({
        ...params,
        cfg: { plugins: { entries: { "fixture-provider": { enabled: true } } } },
        agentDir: "/tmp/openclaw-auth-profile-preservation-allowed",
      }),
    ).toBe(true);
    expect(
      preserves({ ...params, agentDir: "/tmp/openclaw-auth-profile-preservation-denied" }),
    ).toBe(false);
  });

  it("uses the recorded provider for an arbitrary stored profile id", () => {
    const agentDir = tempDirs.make("openclaw-auth-profile-preservation-");
    saveAuthProfileStore(
      {
        version: 1,
        profiles: { "team:prod": { type: "api_key", provider: "openai", key: "test" } },
      },
      agentDir,
    );

    const params = { agentDir, entry: { ...entry, authProfileOverride: "team:prod" } };
    expect(preserves(params)).toBe(true);
    expect(preserves({ ...params, provider: "anthropic" })).toBe(false);
  });

  it.each(["openai", "anthropic"])(
    "retains a missing personal pin only when the selected provider %s is compatible",
    async (provider) => {
      await withOpenClawTestState({ layout: "state-only" }, async (state) => {
        await prepareSharedAuthStoreOwnership(state.env);
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

  it("clears an incompatible auth profile when resetting to a cross-provider default", () => {
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
      selection: { provider: "anthropic", model: "claude-opus-4-6", isDefault: true },
    });

    expect(result.updated).toBe(true);
    expect(sessionEntry.providerOverride).toBeUndefined();
    expect(sessionEntry.modelOverride).toBeUndefined();
    expect(sessionEntry.modelOverrideSource).toBeUndefined();
    expect(sessionEntry.authProfileOverride).toBeUndefined();
    expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
    expect(sessionEntry.authProfileOverrideCompactionCount).toBeUndefined();
  });
});
