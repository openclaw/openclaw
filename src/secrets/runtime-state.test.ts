import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { cloneAuthProfileStore } from "../agents/auth-profiles/clone.js";
import { createAuthProfileStoreFixture } from "../agents/auth-profiles/credential-fixtures.test-support.js";
import {
  observeCanonicalAuthProfileCredentials,
  withCanonicalAuthProfileCredentialObserver,
  type CanonicalAuthProfileCredentialObservation,
} from "../agents/auth-profiles/credential-observation.js";
import { noteCommittedSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreSnapshotCore as getAuthStore,
  getRuntimeAuthProfileStoreSnapshotsRevision,
  noteRuntimeAuthProfileStorePersistedMutation as noteAuthMutation,
  prepareRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot as setAuthStore,
} from "../agents/auth-profiles/runtime-snapshots.js";
import { testing as runtimeSnapshotsTesting } from "../agents/auth-profiles/runtime-snapshots.test-support.js";
import { resolveAuthProfileDatabasePath } from "../agents/auth-profiles/sqlite.js";
import {
  ensureAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileStore, RuntimeAuthProfileStore } from "../agents/auth-profiles/types.js";
import {
  createConfigResolutionFacts,
  getAuthoredConfigSecretRef,
  getConfigResolutionFacts,
  setConfigResolutionFacts,
} from "../config/resolution-facts.js";
import {
  getRuntimeConfigSnapshotMetadata,
  getRuntimeConfigSourceSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretRef } from "../config/types.secrets.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { captureEnv } from "../test-utils/env.js";
import {
  listActiveDegradedSecretOwners,
  setActiveCredentialDegradedOwner,
} from "./runtime-degraded-state.js";
import {
  activateSecretsRuntimeSnapshotState,
  activateSecretsRuntimeSnapshotStateIfCurrent,
  clearSecretsRuntimeSnapshotState,
  getActiveSecretsRuntimeConfigSnapshot,
  getActiveSecretsRuntimeSnapshotState as getSnapshot,
  getActiveSecretsRuntimeSnapshotRevisionState as getRevision,
  restoreSecretsRuntimeSourceSnapshotIfLineageCurrent,
  prepareSecretsRuntimeSnapshotRestoreState,
  setSecretsRuntimeSourceSnapshotIfCurrent,
  type PreparedSecretsRuntimeSnapshot,
} from "./runtime-state.js";

function noteCredentialMutation(agentDir: string | undefined, ...profileIds: string[]) {
  noteAuthMutation(agentDir, { credentialsChanged: true, stateChanged: false, profileIds });
}

function apiKeyProfile(provider: string, key: string, keyRef?: SecretRef) {
  return { type: "api_key" as const, provider, key, ...(keyRef ? { keyRef } : {}) };
}

function providerConfig(
  port: number,
  apiKey: string | SecretRef,
  source: OpenClawConfig = {},
): OpenClawConfig {
  return {
    ...source,
    gateway: { port },
    models: {
      providers: { openai: { baseUrl: "https://api.openai.com/v1", apiKey, models: [] } },
    },
  };
}

function fileProviderConfig(port: number, providerPath: string): OpenClawConfig {
  return {
    gateway: { port },
    ...fileSource(providerPath),
  };
}

function fileSource(providerPath: string, stable = false): OpenClawConfig {
  return {
    secrets: {
      providers: {
        ...(stable
          ? { stable: { source: "file" as const, path: "/tmp/stable-secrets.json" } }
          : {}),
        vault: { source: "file", path: providerPath },
      },
    },
  };
}

function pluginSource(enabled: boolean): OpenClawConfig {
  return {
    secrets: {
      providers: {
        "plugin-vault": {
          source: "exec",
          pluginIntegration: { pluginId: "secret-plugin", integrationId: "vault" },
        },
      },
    },
    plugins: { entries: { "secret-plugin": { enabled } } },
  };
}

function ownedProfileSnapshot(agentDir: string, includeStable = false) {
  return (key: string | null, owner: "external" | "inherited" | "local", port: number) =>
    preparedGatewayAuthSnapshot(agentDir, port, {
      version: 1,
      profiles: {
        ...(key === null ? {} : { "openai:x": apiKeyProfile("openai", key) }),
        ...(includeStable ? { "anthropic:stable": apiKeyProfile("anthropic", "sk-stable") } : {}),
      },
      runtimeExternalProfileIds: owner === "external" ? ["openai:x"] : [],
      runtimeLocalProfileIds: [
        ...(includeStable ? ["anthropic:stable"] : []),
        ...(owner === "local" ? ["openai:x"] : []),
      ],
    });
}

type PreparedSnapshotOverrides = Omit<
  Partial<PreparedSecretsRuntimeSnapshot>,
  "authStoreCredentialsRevision" | "webTools" | "authStores"
> & { authStores?: Array<{ agentDir: string; store: RuntimeAuthProfileStore }> };

function preparedSnapshot(
  overrides: PreparedSnapshotOverrides = {},
): PreparedSecretsRuntimeSnapshot {
  return {
    sourceConfig: {},
    config: {},
    authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
    authStoreSnapshotsRevision: getRuntimeAuthProfileStoreSnapshotsRevision(),
    warnings: [],
    webTools: {
      search: { providerSource: "none", diagnostics: [] },
      fetch: { providerSource: "none", diagnostics: [] },
      diagnostics: [],
    },
    ...overrides,
    authStores: prepareRuntimeAuthProfileStoreSnapshots(overrides.authStores ?? []),
  };
}

function preparedGatewayAuthSnapshot(
  agentDir: string,
  port: number,
  store: RuntimeAuthProfileStore | undefined,
  sourceConfig?: OpenClawConfig,
): PreparedSecretsRuntimeSnapshot {
  return preparedSnapshot({
    ...(sourceConfig ? { sourceConfig } : {}),
    config: { gateway: { port } },
    authStores: store ? [{ agentDir, store }] : [],
  });
}

function singleProfileSnapshot(
  agentDir: string,
  metadata: Omit<Partial<RuntimeAuthProfileStore>, "version"> = {},
  profileId = "openai:default",
) {
  const { profiles, ...state } = metadata;
  return (key: string, port: number, keyRef?: SecretRef, sourceConfig?: OpenClawConfig) =>
    preparedGatewayAuthSnapshot(
      agentDir,
      port,
      {
        version: 1,
        profiles: { ...profiles, [profileId]: apiKeyProfile("openai", key, keyRef) },
        ...state,
      },
      sourceConfig,
    );
}

type ActivateOptions = Omit<
  Parameters<typeof activateSecretsRuntimeSnapshotState>[0],
  "snapshot" | "refreshContext" | "refreshHandler"
>;

function activateSnapshot(
  snapshot: PreparedSecretsRuntimeSnapshot,
  options: ActivateOptions = {},
): void {
  activateSecretsRuntimeSnapshotState({
    snapshot,
    refreshContext: null,
    refreshHandler: null,
    ...options,
  });
}

function activateBaseline(snapshot: PreparedSecretsRuntimeSnapshot) {
  activateSnapshot(snapshot);
  return getSnapshot()!;
}

type ActivateIfCurrentOptions = Omit<
  Parameters<typeof activateSecretsRuntimeSnapshotStateIfCurrent>[0],
  "snapshot" | "expectedRevision" | "refreshContext" | "refreshHandler"
> & { expectedRevision?: number };

function activateSnapshotIfCurrent(
  snapshot: PreparedSecretsRuntimeSnapshot,
  options: ActivateIfCurrentOptions = {},
): boolean {
  return activateSecretsRuntimeSnapshotStateIfCurrent({
    snapshot,
    expectedRevision: options.expectedRevision ?? getRevision(),
    refreshContext: null,
    refreshHandler: null,
    ...options,
  });
}

function restoreSnapshotIfCurrent(
  snapshot: PreparedSecretsRuntimeSnapshot,
  ownedSnapshot: PreparedSecretsRuntimeSnapshot,
  options: ActivateIfCurrentOptions = {},
): boolean {
  const restoration = prepareSecretsRuntimeSnapshotRestoreState({
    snapshot,
    ownedSnapshot,
    expectedRevision: options.expectedRevision ?? getRevision(),
    refreshContext: null,
    refreshHandler: null,
    ...options,
  });
  return restoration !== null && activateSecretsRuntimeSnapshotStateIfCurrent(restoration);
}

describe("secrets runtime state", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  const autoCleanupTempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    noteCommittedSharedAuthStoreOwnership({ location: "legacy-main" });
  });

  afterEach(() => {
    clearSecretsRuntimeSnapshotState();
    runtimeSnapshotsTesting.resetPersistedMutationLineage();
    envSnapshot.restore();
  });

  it("preserves exact canonical credential observations through rollback without claiming runtime secrets", async () => {
    const agentDir = "/tmp/openclaw-auth-observation-clones";
    const databasePath = resolveAuthProfileDatabasePath(agentDir);
    const canonical: AuthProfileStore = {
      version: 1,
      profiles: {
        inline: apiKeyProfile("fixture", "canonical"),
        ref: {
          type: "api_key",
          provider: "fixture",
          keyRef: { source: "env", provider: "default", id: "OBSERVATION_TEST_KEY" },
        },
      },
    };
    observeCanonicalAuthProfileCredentials(databasePath, canonical.profiles);
    const materialized = cloneAuthProfileStore(canonical);
    materialized.profiles.ref = {
      type: "api_key",
      provider: "fixture",
      keyRef: { source: "env", provider: "default", id: "OBSERVATION_TEST_KEY" },
      key: "resolved-only",
    };
    materialized.profiles.external = { type: "token", provider: "fixture", token: "external-only" };
    materialized.runtimeExternalProfileIds = ["external"];
    const previous = activateBaseline(preparedGatewayAuthSnapshot(agentDir, 19_001, materialized));
    const rotated = cloneAuthProfileStore(materialized);
    rotated.profiles.inline = apiKeyProfile("fixture", "rotated");
    observeCanonicalAuthProfileCredentials(databasePath, { inline: rotated.profiles.inline });
    const candidate = preparedGatewayAuthSnapshot(agentDir, 19_002, rotated);
    expect(activateSnapshotIfCurrent(candidate)).toBe(true);
    expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
    const observations: CanonicalAuthProfileCredentialObservation[] = [];
    await withCanonicalAuthProfileCredentialObserver(
      (value) => observations.push(value),
      async () => {
        const cached = getAuthStore(agentDir);
        expect(cached?.profiles.inline).toEqual(canonical.profiles.inline);
        expect(cached?.profiles.ref).toMatchObject({ key: "resolved-only" });
        expect(cached?.profiles.external).toMatchObject({ token: "external-only" });
      },
    );
    expect(observations).toEqual([
      { databasePath, profiles: { inline: canonical.profiles.inline! } },
    ]);
  });

  it("preserves independent credential owners through snapshot replacement and rollback until teardown", () => {
    const previous = preparedSnapshot({
      degradedOwners: [
        {
          ownerKind: "provider",
          ownerId: "openai",
          state: "unavailable",
          degradationState: "stale",
          paths: ["models.providers.openai.apiKey"],
          refKeys: ["env:default:OPENAI_API_KEY"],
          reason: "secret provider failed",
        },
      ],
    });
    activateSnapshot(previous);
    setActiveCredentialDegradedOwner({
      ownerKind: "account",
      ownerId: "telegram:work",
      state: "unavailable",
      paths: ["channels.telegram.accounts.work.tokenFile"],
      refKeys: [],
      reason: "credential file is unavailable",
    });
    const candidate = preparedSnapshot({ config: { gateway: { port: 19_041 } } });

    activateSnapshot(candidate);

    expect(listActiveDegradedSecretOwners()).toMatchObject([
      { ownerKind: "account", ownerId: "telegram:work" },
    ]);
    expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
    expect(listActiveDegradedSecretOwners()).toMatchObject([
      { ownerKind: "provider", ownerId: "openai", degradationState: "stale" },
      { ownerKind: "account", ownerId: "telegram:work" },
    ]);

    clearSecretsRuntimeSnapshotState();

    expect(listActiveDegradedSecretOwners()).toEqual([]);
  });

  it("rejects a source-only secrets write after runtime config ownership changes", () => {
    const initialConfig = { gateway: { port: 19_030 } } satisfies OpenClawConfig;
    const concurrentConfig = { gateway: { port: 19_031 } } satisfies OpenClawConfig;
    activateSnapshot(
      preparedSnapshot({ sourceConfig: initialConfig, config: initialConfig, authStores: [] }),
    );
    const staleMetadata = getRuntimeConfigSnapshotMetadata();
    if (!staleMetadata) {
      throw new Error("expected runtime config metadata");
    }
    setRuntimeConfigSnapshot(concurrentConfig, concurrentConfig);

    expect(
      setSecretsRuntimeSourceSnapshotIfCurrent({
        expectedSecretsRevision: getRevision(),
        expectedRuntimeConfigRevision: staleMetadata.revision,
        runtimeSourceConfig: initialConfig,
        secretsSourceConfig: initialConfig,
      }),
    ).toBe(false);
    expect(getRuntimeConfigSourceSnapshot()).toEqual(concurrentConfig);
    expect(getSnapshot()?.sourceConfig).toEqual(initialConfig);
  });

  it("restores source-only ownership through a scoped descendant", () => {
    const initialSource = { logging: { level: "info" as const } };
    const nextSource = { logging: { level: "debug" as const } };
    setConfigResolutionFacts(
      initialSource,
      createConfigResolutionFacts(
        [{ configPath: "gateway.auth.token", varName: "GATEWAY_TOKEN" }],
        new Map([["gateway.auth.token", "GATEWAY_TOKEN"]]),
      ),
    );
    setConfigResolutionFacts(nextSource, createConfigResolutionFacts([]));
    const runtimeConfig = {
      models: {
        providers: {
          openai: { baseUrl: "https://initial.example.invalid/v1", models: [] },
        },
      },
    } satisfies OpenClawConfig;
    activateSnapshot(
      preparedSnapshot({ sourceConfig: initialSource, config: runtimeConfig, authStores: [] }),
      { runtimeSourceConfig: initialSource },
    );
    const runtimeMetadata = getRuntimeConfigSnapshotMetadata();
    if (!runtimeMetadata) {
      throw new Error("expected runtime config metadata");
    }
    expect(
      setSecretsRuntimeSourceSnapshotIfCurrent({
        expectedSecretsRevision: getRevision(),
        expectedRuntimeConfigRevision: runtimeMetadata.revision,
        runtimeSourceConfig: nextSource,
        secretsSourceConfig: nextSource,
      }),
    ).toBe(true);
    expect(getConfigResolutionFacts(getActiveSecretsRuntimeConfigSnapshot()?.config)?.size).toBe(0);
    const committedRevision = getRevision();
    const active = getSnapshot()!;
    const descendant = structuredClone(active);
    descendant.config.models!.providers!.openai!.baseUrl = "https://refreshed.example.invalid/v1";
    expect(
      activateSnapshotIfCurrent(descendant, {
        expectedRevision: committedRevision,
        runtimeSourceConfig: nextSource,
        preserveActivationLineage: true,
      }),
    ).toBe(true);

    expect(
      restoreSecretsRuntimeSourceSnapshotIfLineageCurrent({
        expectedLineageRevision: committedRevision,
        runtimeSourceConfig: initialSource,
        secretsSourceConfig: initialSource,
      }),
    ).toBe(true);
    expect(getRuntimeConfigSourceSnapshot()).toEqual(initialSource);
    expect(
      getConfigResolutionFacts(getActiveSecretsRuntimeConfigSnapshot()?.config)?.has(
        "gateway.auth.token",
      ),
    ).toBe(true);
    expect(
      getAuthoredConfigSecretRef(
        getActiveSecretsRuntimeConfigSnapshot()?.config,
        "gateway.auth.token",
      )?.id,
    ).toBe("GATEWAY_TOKEN");
    expect(getSnapshot()?.sourceConfig).toEqual(initialSource);
    expect(getSnapshot()?.config.models?.providers?.openai?.baseUrl).toBe(
      "https://refreshed.example.invalid/v1",
    );
  });

  it.each(["save", "clear"])("preserves live auth bookkeeping after order %s", (action) => {
    const agentDir = "/tmp/openclaw-auth-bookkeeping-merge";
    const order = { openai: ["openai:default"] };
    const saved = action === "save";
    const credential = apiKeyProfile("openai", "sk-current");
    const baseline = {
      version: 1 as const,
      profiles: { "openai:default": credential },
      order: saved ? undefined : order,
      runtimeLocalOrderProviderIds: saved ? [] : ["openai"],
      usageStats: { "openai:default": { lastUsed: 1 } },
    };
    setAuthStore(baseline, agentDir);
    const snapshot = preparedSnapshot({ authStores: [{ agentDir, store: baseline }] });
    setAuthStore(
      {
        version: 1,
        profiles: { "openai:default": credential },
        order: saved ? order : undefined,
        runtimeLocalOrderProviderIds: saved ? ["openai"] : [],
        lastGood: { openai: "openai:default" },
        usageStats: {
          "openai:default": { lastUsed: 2, cooldownUntil: Date.now() + 60_000 },
        },
      },
      agentDir,
    );

    activateSnapshot(snapshot);

    expect(getAuthStore(agentDir)?.usageStats?.["openai:default"]).toMatchObject({
      lastUsed: 2,
      cooldownUntil: expect.any(Number),
    });
    expect(getAuthStore(agentDir)?.order).toEqual(saved ? order : undefined);
    expect(getAuthStore(agentDir)?.runtimeLocalOrderProviderIds).toEqual(saved ? ["openai"] : []);
    expect(getAuthStore(agentDir)?.lastGood?.openai).toBe("openai:default");
  });

  it("rolls back candidate credentials against the activation-time auth baseline", () => {
    const agentDir = "/tmp/openclaw-auth-activation-baseline";
    const snapshot = (
      profiles: AuthProfileStore["profiles"],
      port: number,
      state: Pick<AuthProfileStore, "order" | "lastGood" | "usageStats"> = {},
    ) =>
      preparedSnapshot({
        config: { gateway: { port } },
        authStores: [{ agentDir, store: { version: 1, profiles, ...state } }],
      });
    const predecessorProfiles = {
      "provider-a:default": apiKeyProfile("provider-a", "a-old"),
      "provider-b:default": apiKeyProfile("provider-b", "b-old"),
    };
    const predecessorState = {
      order: { provider: ["provider-a:default", "provider-b:default"] },
      lastGood: { provider: "provider-a:default" },
      usageStats: { "provider-b:default": { lastUsed: 1 } },
    };
    const previous = activateBaseline(snapshot(predecessorProfiles, 19_001, predecessorState));
    const previousRevision = getRevision();
    const activationProfiles = {
      ...predecessorProfiles,
      "provider-b:default": apiKeyProfile("provider-b", "b-external"),
      "provider-q:login": apiKeyProfile("provider-q", "q-external"),
    };
    const activationState = {
      order: { provider: ["provider-b:default", "provider-a:default"] },
      lastGood: { provider: "provider-b:default" },
      usageStats: {
        "provider-b:default": { lastUsed: 2, cooldownUntil: 30_000 },
      },
    };
    setAuthStore({ version: 1, profiles: activationProfiles, ...activationState }, agentDir);
    const preparedState = {
      order: { provider: ["provider-a:default"] },
      lastGood: { provider: "provider-a:default" },
      usageStats: { "provider-b:default": { lastUsed: 3 } },
    };
    const candidate = snapshot(
      {
        ...activationProfiles,
        "provider-a:default": apiKeyProfile("provider-a", "a-candidate"),
        "provider-x:candidate": apiKeyProfile("provider-x", "x-candidate"),
      },
      19_002,
      preparedState,
    );
    expect(activateSnapshotIfCurrent(candidate, { expectedRevision: previousRevision })).toBe(true);
    const liveAfterActivation = getAuthStore(agentDir)!;
    liveAfterActivation.order = { provider: ["provider-q:login", "provider-b:default"] };
    liveAfterActivation.lastGood = { provider: "provider-q:login" };
    liveAfterActivation.usageStats = {
      "provider-b:default": { lastUsed: 4, cooldownUntil: 40_000 },
    };
    setAuthStore(liveAfterActivation, agentDir);

    expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
    const restoredStore = getAuthStore(agentDir);
    expect(restoredStore?.profiles).toMatchObject({
      "provider-a:default": { key: "a-old" },
      "provider-b:default": { key: "b-external" },
      "provider-q:login": { key: "q-external" },
    });
    expect(restoredStore?.profiles["provider-x:candidate"]).toBeUndefined();
    expect(restoredStore?.order?.provider).toEqual(["provider-q:login", "provider-b:default"]);
    expect(restoredStore?.lastGood?.provider).toBe("provider-q:login");
    expect(restoredStore?.usageStats?.["provider-b:default"]).toMatchObject({
      lastUsed: 4,
      cooldownUntil: 40_000,
    });
  });

  it.each([
    ["triple rotation", "a-old", "a-candidate", "a-external", true, "a-external"],
    ["external logout", "a-old", "a-candidate", null, false, null],
  ])(
    "resolves per-profile ownership for %s while preserving post-activation profile B",
    (label, baselineAKey, candidateAKey, currentAKey, currentAExternal, expectedAKey) => {
      const agentDir = `/tmp/openclaw-auth-post-activation-${label}`;
      const snapshot = (aKey: string | null, bKey: string, port: number, aExternal = false) =>
        preparedGatewayAuthSnapshot(agentDir, port, {
          version: 1,
          profiles: {
            ...(aKey === null ? {} : { "provider-a:default": apiKeyProfile("provider-a", aKey) }),
            "provider-b:default": apiKeyProfile("provider-b", bKey),
          },
          runtimeExternalProfileIds: aExternal ? ["provider-a:default"] : undefined,
        });
      const previous = activateBaseline(snapshot(baselineAKey, "b-old", 19_001));
      const candidate = snapshot(candidateAKey, "b-old", 19_002);
      expect(activateSnapshotIfCurrent(candidate)).toBe(true);
      setAuthStore(
        snapshot(currentAKey, "b-external", 19_002, currentAExternal).authStores[0]!.store,
        agentDir,
      );
      noteCredentialMutation(agentDir, "provider-b:default");

      expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
      const restored = getAuthStore(agentDir)?.profiles;
      if (expectedAKey === null) {
        expect(restored?.["provider-a:default"]).toBeUndefined();
      } else {
        expect(restored?.["provider-a:default"]).toMatchObject({ key: expectedAKey });
      }
      expect(restored?.["provider-b:default"]).toMatchObject({ key: "b-external" });
      if (currentAExternal) {
        expect(getAuthStore(agentDir)?.runtimeExternalProfileIds).toContain("provider-a:default");
      }
    },
  );

  it.each([
    ["local override", ["openai:default"], "sk-old"],
    ["inherited profile", [], "sk-candidate"],
  ])("uses the effective owner token for %s", (_label, runtimeLocalProfileIds, expected) => {
    const agentDir = `/tmp/openclaw-auth-effective-owner-${runtimeLocalProfileIds.length}`;
    const snapshot = singleProfileSnapshot(agentDir, { runtimeLocalProfileIds });
    const previous = activateBaseline(snapshot("sk-old", 19_001));
    const candidate = snapshot("sk-candidate", 19_002);
    expect(activateSnapshotIfCurrent(candidate)).toBe(true);
    noteCredentialMutation(undefined, "openai:default");
    setAuthStore(candidate.authStores[0]!.store, agentDir);

    expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
    expect(getAuthStore(agentDir)?.profiles["openai:default"]).toMatchObject({ key: expected });
  });

  it("invalidates a partial store when an omitted candidate owner mutates", () => {
    const agentDir = "/tmp/openclaw-auth-external-omission";
    const snapshot = (
      profiles: AuthProfileStore["profiles"],
      externalProfileIds: string[],
      port: number,
    ) =>
      preparedGatewayAuthSnapshot(agentDir, port, {
        version: 1,
        profiles,
        runtimeExternalProfileIds: externalProfileIds,
      });
    const profileX = apiKeyProfile("openai", "sk-external-x");
    const profileY = apiKeyProfile("openai", "sk-external-y");
    const previous = activateBaseline(
      snapshot({ "openai:x": profileX, "openai:y": profileY }, ["openai:x", "openai:y"], 19_001),
    );
    const candidate = snapshot({ "openai:y": profileY }, ["openai:y"], 19_002);
    expect(activateSnapshotIfCurrent(candidate)).toBe(true);
    noteCredentialMutation(undefined, "openai:x");
    setAuthStore(candidate.authStores[0]!.store, agentDir);

    expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
    expect(getAuthStore(agentDir)).toBeUndefined();
  });

  it.each([
    ["external", "inherited", true, "candidate", null, "inherited"],
    ["external", "inherited", false, "refreshed", "old", "inherited"],
    ["inherited", "external", true, "candidate", null, "external"],
    ["inherited", "external", false, "refreshed", "old", "external"],
    ["local", "local", false, "candidate", "candidate", "external"],
  ] as const)(
    "rolls back %s to %s with mutation=%s and current key=%s",
    (baselineOwner, candidateOwner, mutated, currentKey, expectedKey, currentOwner) => {
      const agentDir = `/tmp/openclaw-auth-ownership-${baselineOwner}-${candidateOwner}-${mutated}`;
      const snapshot = ownedProfileSnapshot(agentDir, baselineOwner === "inherited");
      const previous = activateBaseline(snapshot("old", baselineOwner, 19_001));
      const candidate = snapshot("candidate", candidateOwner, 19_002);
      expect(activateSnapshotIfCurrent(candidate)).toBe(true);
      if (mutated) {
        noteCredentialMutation(undefined, "openai:x");
      }
      setAuthStore(snapshot(currentKey, currentOwner, 19_002).authStores[0]!.store, agentDir);
      expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
      const restored = getAuthStore(agentDir);
      if (expectedKey === null) {
        expect(restored).toBeUndefined();
      } else {
        expect(restored?.profiles["openai:x"]).toMatchObject({ key: expectedKey });
        expect((restored?.runtimeExternalProfileIds ?? []).includes("openai:x")).toBe(
          expectedKey === "candidate" || baselineOwner === "external",
        );
        expect(restored?.runtimeLocalProfileIds ?? []).not.toContain("openai:x");
      }
    },
  );

  it("preserves an authoritative empty external overlay on rollback", () => {
    const agentDir = "/tmp/openclaw-auth-authoritative-empty-external";
    const snapshot = (authoritative: boolean, port: number) =>
      preparedGatewayAuthSnapshot(agentDir, port, {
        version: 1,
        profiles: {},
        runtimeExternalProfileIds: [],
        runtimeExternalProfileIdsAuthoritative: authoritative ? true : undefined,
      });
    const previous = activateBaseline(snapshot(true, 19_001));
    const candidate = snapshot(false, 19_002);
    expect(activateSnapshotIfCurrent(candidate)).toBe(true);

    expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
    expect(getAuthStore(agentDir)).toMatchObject({
      runtimeExternalProfileIds: [],
      runtimeExternalProfileIdsAuthoritative: true,
    });
  });

  it("does not import rejected external authority from a selected current credential", () => {
    const agentDir = "/tmp/openclaw-auth-rejected-external-authority";
    const snapshot = (key: string, authoritative: boolean, port: number) =>
      preparedGatewayAuthSnapshot(agentDir, port, {
        version: 1,
        profiles: {
          "openai:x": { type: "api_key", provider: "openai", key },
        },
        runtimeLocalProfileIds: ["openai:x"],
        runtimeExternalProfileIds: [],
        runtimeExternalProfileIdsAuthoritative: authoritative ? true : undefined,
      });
    const previous = activateBaseline(snapshot("sk-old", false, 19_001));
    const candidate = snapshot("sk-old", true, 19_002);
    expect(activateSnapshotIfCurrent(candidate)).toBe(true);
    setAuthStore(snapshot("sk-current", true, 19_002).authStores[0]!.store, agentDir);

    expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
    const restored = getAuthStore(agentDir);
    expect(restored?.profiles["openai:x"]).toMatchObject({ key: "sk-current" });
    expect(restored?.runtimeExternalProfileIdsAuthoritative).toBeUndefined();
  });

  it("keeps external profile ownership separate from main mutations", () => {
    const agentDir = "/tmp/openclaw-auth-external-owner-sk-candidate";
    const snapshot = singleProfileSnapshot(
      agentDir,
      { runtimeExternalProfileIds: ["openai:external"] },
      "openai:external",
    );
    const previous = activateBaseline(snapshot("sk-old", 19_001));
    const candidate = snapshot("sk-candidate", 19_002);
    expect(activateSnapshotIfCurrent(candidate)).toBe(true);
    noteCredentialMutation(undefined, "openai:external");
    setAuthStore(snapshot("sk-candidate", 19_002).authStores[0]!.store, agentDir);

    expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
    expect(getAuthStore(agentDir)?.profiles["openai:external"]).toMatchObject({ key: "sk-old" });
  });

  it("removes a rejected candidate credential when its bounded lineage was evicted", () => {
    const agentDir = "/tmp/openclaw-auth-evicted-lineage";
    const snapshot = singleProfileSnapshot(agentDir, {
      profiles: { "anthropic:stable": apiKeyProfile("anthropic", "sk-stable") },
      runtimeLocalProfileIds: ["anthropic:stable", "openai:default"],
    });
    activateSnapshot(snapshot("sk-old", 19_001));
    const previous = getSnapshot()!;
    const candidate = snapshot("sk-candidate", 19_002);
    expect(activateSnapshotIfCurrent(candidate)).toBe(true);
    for (let index = 0; index < 300; index += 1) {
      noteCredentialMutation(agentDir, `openai:unrelated-${index}`);
    }

    expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
    expect(getAuthStore(agentDir)).toBeUndefined();
  });

  it.each(["owner", "profile"] as const)(
    "drops a changed-ref descendant after $eviction lineage eviction",
    (eviction) => {
      const root = autoCleanupTempDirs.make("openclaw-auth-evicted-ref-");
      const agentDir = path.join(root, eviction);
      fs.mkdirSync(agentDir, { recursive: true });
      const previousRef = { source: "env" as const, provider: "default", id: "OPENAI_API_KEY" };
      const candidateRef = { ...previousRef, id: "OPENAI_API_KEY_NEXT" };
      const snapshot = singleProfileSnapshot(agentDir, {
        runtimeLocalProfileIds: ["openai:default"],
      });
      try {
        saveAuthProfileStore(
          snapshot("sk-old", 19_001, previousRef).authStores[0]!.store,
          agentDir,
        );
        const previous = activateBaseline(snapshot("sk-old", 19_001, previousRef));
        const candidate = snapshot("sk-candidate", 19_002, candidateRef);
        expect(activateSnapshotIfCurrent(candidate)).toBe(true);
        setAuthStore(
          snapshot("sk-descendant", 19_002, candidateRef).authStores[0]!.store,
          agentDir,
        );
        for (let index = 0; index < 300; index += 1) {
          noteAuthMutation(
            eviction === "owner" ? `/tmp/openclaw-auth-unrelated-owner-${index}` : agentDir,
            {
              credentialsChanged: true,
              stateChanged: false,
              profileIds: [`openai:unrelated-${index}`],
            },
          );
        }

        expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
        expect(getAuthStore(agentDir)).toBeUndefined();
        expect(
          ensureAuthProfileStoreWithoutExternalProfiles(agentDir).profiles["openai:default"],
        ).toMatchObject({ keyRef: previousRef });
      } finally {
        clearSecretsRuntimeSnapshotState();
        closeOpenClawAgentDatabasesForTest();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["state-only bookkeeping write", "custom", "", true, false, false, true],
    ["unrelated main bookkeeping write", "main", "", true, false, false, false],
    ["inherited main bookkeeping write", "main", "", true, true, true, true],
    ["related main-store write", "main", "openai:default", false, true, false, true],
  ] as const)(
    "handles whole-store %s after candidate omission",
    (
      label,
      mutationOwner,
      profileId,
      stateOnly,
      inheritsMainProfile,
      inheritsMainState,
      expectMissing,
    ) => {
      const agentDir = `/tmp/openclaw-auth-store-removal-${label}`;
      const snapshot = (includeStore: boolean, port: number) =>
        preparedGatewayAuthSnapshot(
          agentDir,
          port,
          includeStore
            ? {
                version: 1,
                profiles: { "openai:default": apiKeyProfile("openai", "sk-old") },
                runtimeLocalProfileIds: inheritsMainProfile ? [] : ["openai:default"],
                runtimeInheritsMainState: inheritsMainState,
              }
            : undefined,
        );
      const previous = activateBaseline(snapshot(true, 19_001));
      const candidate = snapshot(false, 19_002);
      expect(activateSnapshotIfCurrent(candidate)).toBe(true);
      noteAuthMutation(mutationOwner === "custom" ? agentDir : undefined, {
        credentialsChanged: !stateOnly,
        stateChanged: stateOnly,
        profileIds: [profileId],
      });

      expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
      if (expectMissing) {
        expect(getAuthStore(agentDir)).toBeUndefined();
      } else {
        expect(getAuthStore(agentDir)?.profiles["openai:default"]).toMatchObject({ key: "sk-old" });
      }
    },
  );

  it("does not resurrect a baseline external store after a new main profile is added", () => {
    const agentDir = "/tmp/openclaw-auth-external-store-omission-mutation";
    const snapshot = (includeStore: boolean, port: number) =>
      preparedGatewayAuthSnapshot(
        agentDir,
        port,
        includeStore
          ? {
              version: 1,
              profiles: { "openai:x": apiKeyProfile("openai", "sk-external") },
              runtimeExternalProfileIds: ["openai:x"],
            }
          : undefined,
      );
    const previous = activateBaseline(snapshot(true, 19_001));
    const candidate = snapshot(false, 19_002);
    expect(activateSnapshotIfCurrent(candidate)).toBe(true);
    noteAuthMutation(undefined, {
      credentialsChanged: true,
      profileSetChanged: true,
      stateChanged: false,
      profileIds: ["openai:new-main"],
    });

    expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
    expect(getAuthStore(agentDir)).toBeUndefined();
  });

  it("does not resurrect an auth store cleared after candidate activation", () => {
    const agentDir = "/tmp/openclaw-auth-post-activation-clear";
    const snapshot = singleProfileSnapshot(agentDir);
    const previous = activateBaseline(snapshot("sk-old", 19_001));
    const candidate = snapshot("sk-candidate", 19_002);
    expect(activateSnapshotIfCurrent(candidate)).toBe(true);
    clearRuntimeAuthProfileStoreSnapshots();

    expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
    expect(getAuthStore(agentDir)).toBeUndefined();
  });

  it.each([
    ["retains a resolved value for the same auth-store SecretRef", false],
    ["restores the predecessor when the auth-store SecretRef changed", true],
  ])("%s", (_label, changedRef) => {
    const agentDir = `/tmp/openclaw-auth-ref-rollback-${changedRef}`;
    const previousRef = { source: "env" as const, provider: "default", id: "OPENAI_API_KEY" };
    const candidateRef = changedRef ? { ...previousRef, id: "OPENAI_API_KEY_NEXT" } : previousRef;
    const snapshot = singleProfileSnapshot(agentDir);
    const previous = activateBaseline(snapshot("sk-old", 19_001, previousRef));
    const candidate = snapshot("sk-candidate", 19_002, candidateRef);
    expect(activateSnapshotIfCurrent(candidate)).toBe(true);
    const candidateRevision = getRevision();
    expect(
      activateSnapshotIfCurrent(snapshot("sk-refreshed", 19_002, candidateRef), {
        expectedRevision: candidateRevision,
        preserveActivationLineage: true,
      }),
    ).toBe(true);

    expect(
      restoreSnapshotIfCurrent(previous, candidate, { expectedRevision: candidateRevision }),
    ).toBe(true);
    expect(getAuthStore(agentDir)?.profiles["openai:default"]).toMatchObject({
      key: changedRef ? "sk-old" : "sk-refreshed",
      keyRef: changedRef ? previousRef : candidateRef,
    });
  });

  it.each([
    {
      label: "retains a provider-auth descendant for the same SecretRef",
      candidateRefId: "OPENAI_API_KEY",
      expectedKey: "sk-refreshed",
    },
    {
      label: "restores the predecessor value when the candidate changed its SecretRef",
      candidateRefId: "OPENAI_API_KEY_NEXT",
      expectedKey: "sk-old",
    },
  ])("$label", ({ candidateRefId, expectedKey }) => {
    const previousKeyRef = { source: "env" as const, provider: "default", id: "OPENAI_API_KEY" };
    const candidateKeyRef = { ...previousKeyRef, id: candidateRefId };
    const snapshot = (port: number, apiKey: string, keyRef: SecretRef) =>
      preparedSnapshot({
        sourceConfig: providerConfig(port, keyRef),
        config: providerConfig(port, apiKey),
        authStores: [],
      });
    const previous = activateBaseline(snapshot(19_021, "sk-old", previousKeyRef));
    const candidate = snapshot(19_022, "sk-candidate", candidateKeyRef);
    expect(activateSnapshotIfCurrent(candidate)).toBe(true);
    const candidateRevision = getRevision();
    const providerRefresh = snapshot(19_022, "sk-refreshed", candidateKeyRef);
    expect(
      activateSnapshotIfCurrent(providerRefresh, {
        expectedRevision: candidateRevision,
        preserveActivationLineage: true,
      }),
    ).toBe(true);

    expect(
      restoreSnapshotIfCurrent(previous, candidate, { expectedRevision: candidateRevision }),
    ).toBe(true);
    expect(getSnapshot()?.config.gateway?.port).toBe(19_021);
    expect(getSnapshot()?.config.models?.providers?.openai?.apiKey).toBe(expectedKey);
  });

  it.each([
    {
      evictLineage: true,
      label: "provider definition with evicted lineage",
      keyRef: { source: "file", provider: "vault", id: "openai" } satisfies SecretRef,
      previousSourceConfig: fileSource("/tmp/old-secrets.json"),
      candidateSourceConfig: fileSource("/tmp/rejected-secrets.json"),
    },
    {
      evictLineage: false,
      label: "plugin integration owner",
      keyRef: { source: "exec", provider: "plugin-vault", id: "openai" } satisfies SecretRef,
      previousSourceConfig: pluginSource(true),
      candidateSourceConfig: pluginSource(false),
    },
  ] as Array<{
    evictLineage: boolean;
    label: string;
    keyRef: SecretRef;
    previousSourceConfig: OpenClawConfig;
    candidateSourceConfig: OpenClawConfig;
  }>)(
    "restores resolved values when a same-ref $label was rejected",
    ({ keyRef, previousSourceConfig, candidateSourceConfig, evictLineage }) => {
      const agentDir = `/tmp/openclaw-auth-provider-dependency-${keyRef.provider}`;
      const snapshot = (sourceConfig: OpenClawConfig, apiKey: string, port: number) =>
        preparedSnapshot({
          sourceConfig: providerConfig(port, keyRef, sourceConfig),
          config: providerConfig(port, apiKey, sourceConfig),
          authStores: [
            {
              agentDir,
              store: createAuthProfileStoreFixture({
                "openai:default": apiKeyProfile("openai", apiKey, keyRef),
              }),
            },
          ],
        });
      const previous = activateBaseline(snapshot(previousSourceConfig, "sk-old", 19_031));
      const candidate = snapshot(candidateSourceConfig, "sk-candidate", 19_032);
      expect(activateSnapshotIfCurrent(candidate)).toBe(true);
      if (evictLineage) {
        for (let index = 0; index < 300; index += 1) {
          noteCredentialMutation(agentDir, `openai:unrelated-${index}`);
        }
      }
      const candidateRevision = getRevision();
      expect(
        activateSnapshotIfCurrent(snapshot(candidateSourceConfig, "sk-refreshed", 19_032), {
          expectedRevision: candidateRevision,
          preserveActivationLineage: true,
        }),
      ).toBe(true);

      expect(
        restoreSnapshotIfCurrent(previous, candidate, { expectedRevision: candidateRevision }),
      ).toBe(true);
      const restored = getSnapshot();
      expect(restored?.sourceConfig).toMatchObject(previousSourceConfig);
      expect(restored?.config.models?.providers?.openai?.apiKey).toBe("sk-old");
      if (evictLineage) {
        expect(getAuthStore(agentDir)).toBeUndefined();
      } else {
        expect(getAuthStore(agentDir)?.profiles["openai:default"]).toMatchObject({
          key: "sk-old",
          keyRef,
        });
      }
    },
  );

  it.each([
    ["local delete", "local", "inherited"],
    ["same-owner local update", "local", "local"],
  ] as const)(
    "invalidates a same-ref provider change after a durable %s",
    (_label, capturedOwner, currentOwner) => {
      const agentDir = `/tmp/openclaw-auth-provider-owner-${capturedOwner}-${currentOwner}`;
      const keyRef = { source: "file" as const, provider: "vault", id: "openai" };
      const snapshot = (
        key: string,
        owner: "inherited" | "local",
        providerPath: string,
        port: number,
      ) =>
        singleProfileSnapshot(agentDir, {
          runtimeLocalProfileIds: owner === "local" ? ["openai:default"] : [],
        })(key, port, keyRef, fileProviderConfig(port, providerPath));
      const previous = activateBaseline(
        snapshot("sk-old", capturedOwner, "/tmp/old-secrets.json", 19_041),
      );
      const candidate = snapshot(
        "sk-candidate",
        capturedOwner,
        "/tmp/rejected-secrets.json",
        19_042,
      );
      expect(activateSnapshotIfCurrent(candidate)).toBe(true);
      noteCredentialMutation(agentDir, "openai:default");
      setAuthStore(
        snapshot("sk-durable", currentOwner, "/tmp/rejected-secrets.json", 19_042).authStores[0]!
          .store,
        agentDir,
      );

      expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
      expect(getAuthStore(agentDir)).toBeUndefined();
    },
  );

  it.each([
    ["vault", true],
    ["stable", false],
  ] as const)(
    "handles a durable ref-id update through %s with affected=%s",
    (currentProvider, affectedProvider) => {
      const agentDir = `/tmp/openclaw-auth-provider-ref-update-${currentProvider}`;
      const previousSourceConfig = fileSource("/tmp/old-secrets.json", true);
      const candidateSourceConfig = fileSource("/tmp/rejected-secrets.json", true);
      const previousRef = { source: "file" as const, provider: "vault", id: "openai-a" };
      const currentRef = { source: "file" as const, provider: currentProvider, id: "openai-b" };
      const makeSnapshot = singleProfileSnapshot(agentDir, {
        runtimeLocalProfileIds: ["openai:default"],
      });
      const snapshot = (
        key: string,
        keyRef: SecretRef,
        port: number,
        sourceConfig: OpenClawConfig,
      ) => makeSnapshot(key, port, keyRef, { ...sourceConfig, gateway: { port } });
      const previous = activateBaseline(
        snapshot("sk-old", previousRef, 19_051, previousSourceConfig),
      );
      const candidate = snapshot("sk-candidate", previousRef, 19_052, candidateSourceConfig);
      expect(activateSnapshotIfCurrent(candidate)).toBe(true);
      noteCredentialMutation(agentDir, "openai:default");
      setAuthStore(
        snapshot("sk-durable", currentRef, 19_052, candidateSourceConfig).authStores[0]!.store,
        agentDir,
      );

      expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
      if (affectedProvider) {
        expect(getAuthStore(agentDir)).toBeUndefined();
      } else {
        expect(getAuthStore(agentDir)?.profiles["openai:default"]).toMatchObject({
          key: "sk-durable",
          keyRef: currentRef,
        });
      }
    },
  );

  it("invalidates an absent-profile external upsert under a rejected provider", () => {
    const agentDir = `/tmp/openclaw-auth-provider-absent-upsert-external`;
    const snapshot = (includeProfile: boolean, providerPath: string, port: number) =>
      preparedGatewayAuthSnapshot(
        agentDir,
        port,
        {
          version: 1,
          profiles: {
            "anthropic:stable": apiKeyProfile("anthropic", "sk-stable"),
            ...(includeProfile
              ? {
                  "openai:default": apiKeyProfile("openai", "sk-current", {
                    source: "file",
                    provider: "vault",
                    id: "openai-b",
                  }),
                }
              : {}),
          },
          runtimeExternalProfileIds: includeProfile ? ["openai:default"] : [],
          runtimeLocalProfileIds: ["anthropic:stable"],
        },
        fileProviderConfig(port, providerPath),
      );
    const previous = activateBaseline(snapshot(false, "/tmp/old-secrets.json", 19_061));
    const candidate = snapshot(false, "/tmp/rejected-secrets.json", 19_062);
    expect(activateSnapshotIfCurrent(candidate)).toBe(true);
    setAuthStore(
      snapshot(true, "/tmp/rejected-secrets.json", 19_062).authStores[0]!.store,
      agentDir,
    );

    expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
    expect(getAuthStore(agentDir)).toBeUndefined();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
