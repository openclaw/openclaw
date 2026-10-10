/** Tests secrets runtime state clone isolation and refresh context. */
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
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreSnapshotCore,
  getRuntimeAuthProfileStoreSnapshotsRevision,
  noteRuntimeAuthProfileStorePersistedMutation,
  prepareRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot,
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
  collectSecretStoreRefKeysInSnapshot,
  getActiveSecretsRuntimeConfigSnapshot,
  getActiveSecretsRuntimeSnapshotState,
  getActiveSecretsRuntimeSnapshotRevisionState,
  hasSameSecretReloadContract,
  restoreSecretsRuntimeSourceSnapshotIfLineageCurrent,
  prepareSecretsRuntimeSnapshotRestoreState,
  setSecretsRuntimeSourceSnapshotIfCurrent,
  type PreparedSecretsRuntimeSnapshot,
} from "./runtime-state.js";

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
  store: PreparedSecretsRuntimeSnapshot["authStores"][number]["store"],
): PreparedSecretsRuntimeSnapshot {
  return preparedSnapshot({
    config: { gateway: { port } },
    authStores: [{ agentDir, store }],
  });
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
    expectedRevision: options.expectedRevision ?? getActiveSecretsRuntimeSnapshotRevisionState(),
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
    expectedRevision: options.expectedRevision ?? getActiveSecretsRuntimeSnapshotRevisionState(),
    refreshContext: null,
    refreshHandler: null,
    ...options,
  });
  return restoration !== null && activateSecretsRuntimeSnapshotStateIfCurrent(restoration);
}

describe("secrets runtime state", () => {
  it("finds canonical store refs without interpreting providerless or other-source values", () => {
    const config = {
      secrets: { defaults: { store: "default" } },
      models: {
        providers: {
          one: {
            apiKey: { source: "store", provider: "default", id: "TEAM_API_KEY" },
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;
    expect(
      collectSecretStoreRefKeysInSnapshot({ sourceConfig: config, authStores: [] }, "TEAM_API_KEY"),
    ).toEqual(new Set(["store:default:TEAM_API_KEY"]));
    expect(
      collectSecretStoreRefKeysInSnapshot(
        {
          sourceConfig: {
            plugins: {
              entries: { sample: { config: { apiKey: { source: "store", id: "TEAM_API_KEY" } } } },
            },
          },
          authStores: [],
        },
        "TEAM_API_KEY",
      ),
    ).toEqual(new Set());
    expect(
      collectSecretStoreRefKeysInSnapshot(
        {
          sourceConfig: {
            gateway: {
              auth: { token: { source: "env", provider: "default", id: "TEAM_API_KEY" } },
            },
          },
          authStores: [],
        },
        "TEAM_API_KEY",
      ),
    ).toEqual(new Set());
  });

  let envSnapshot: ReturnType<typeof captureEnv>;
  const autoCleanupTempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
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
        inline: { type: "api_key", provider: "fixture", key: "canonical" },
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
    materialized.profiles.external = {
      type: "token",
      provider: "fixture",
      token: "external-only",
    };
    materialized.runtimeExternalProfileIds = ["external"];
    activateSnapshot(preparedGatewayAuthSnapshot(agentDir, 19_001, materialized));
    const previous = getActiveSecretsRuntimeSnapshotState()!;
    const rotated = cloneAuthProfileStore(materialized);
    rotated.profiles.inline = { type: "api_key", provider: "fixture", key: "rotated" };
    observeCanonicalAuthProfileCredentials(databasePath, { inline: rotated.profiles.inline });
    const candidate = preparedGatewayAuthSnapshot(agentDir, 19_002, rotated);
    expect(activateSnapshotIfCurrent(candidate)).toBe(true);
    expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
    const observations: CanonicalAuthProfileCredentialObservation[] = [];
    await withCanonicalAuthProfileCredentialObserver(
      (value) => observations.push(value),
      async () => {
        const cached = getRuntimeAuthProfileStoreSnapshotCore(agentDir);
        expect(cached?.profiles.inline).toEqual(canonical.profiles.inline);
        expect(cached?.profiles.ref).toMatchObject({ key: "resolved-only" });
        expect(cached?.profiles.external).toMatchObject({ token: "external-only" });
      },
    );
    expect(observations).toEqual([
      { databasePath, profiles: { inline: canonical.profiles.inline! } },
    ]);
  });

  it("includes env shorthand SecretRefs in the reload contract", () => {
    const configWithRef = (apiKey: string): OpenClawConfig => ({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey,
            models: [],
          },
        },
      },
    });

    expect(
      hasSameSecretReloadContract(
        configWithRef("$OPENAI_API_KEY"),
        configWithRef("$OPENAI_API_KEY"),
      ),
    ).toBe(true);
    expect(
      hasSameSecretReloadContract(
        configWithRef("$OPENAI_API_KEY"),
        configWithRef("$OPENAI_API_KEY_NEXT"),
      ),
    ).toBe(false);
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
      preparedSnapshot({
        sourceConfig: initialConfig,
        config: initialConfig,
        authStores: [],
      }),
    );
    const staleMetadata = getRuntimeConfigSnapshotMetadata();
    if (!staleMetadata) {
      throw new Error("expected runtime config metadata");
    }
    setRuntimeConfigSnapshot(concurrentConfig, concurrentConfig);

    expect(
      setSecretsRuntimeSourceSnapshotIfCurrent({
        expectedSecretsRevision: getActiveSecretsRuntimeSnapshotRevisionState(),
        expectedRuntimeConfigRevision: staleMetadata.revision,
        runtimeSourceConfig: initialConfig,
        secretsSourceConfig: initialConfig,
      }),
    ).toBe(false);
    expect(getRuntimeConfigSourceSnapshot()).toEqual(concurrentConfig);
    expect(getActiveSecretsRuntimeSnapshotState()?.sourceConfig).toEqual(initialConfig);
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
      preparedSnapshot({
        sourceConfig: initialSource,
        config: runtimeConfig,
        authStores: [],
      }),
      { runtimeSourceConfig: initialSource },
    );
    const runtimeMetadata = getRuntimeConfigSnapshotMetadata();
    if (!runtimeMetadata) {
      throw new Error("expected runtime config metadata");
    }
    expect(
      setSecretsRuntimeSourceSnapshotIfCurrent({
        expectedSecretsRevision: getActiveSecretsRuntimeSnapshotRevisionState(),
        expectedRuntimeConfigRevision: runtimeMetadata.revision,
        runtimeSourceConfig: nextSource,
        secretsSourceConfig: nextSource,
      }),
    ).toBe(true);
    expect(getConfigResolutionFacts(getActiveSecretsRuntimeConfigSnapshot()?.config)?.size).toBe(0);
    const committedRevision = getActiveSecretsRuntimeSnapshotRevisionState();
    const active = getActiveSecretsRuntimeSnapshotState()!;
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
    expect(getActiveSecretsRuntimeSnapshotState()?.sourceConfig).toEqual(initialSource);
    expect(getActiveSecretsRuntimeSnapshotState()?.config.models?.providers?.openai?.baseUrl).toBe(
      "https://refreshed.example.invalid/v1",
    );
  });

  it.each(["save", "clear"])("preserves live auth bookkeeping after order %s", (action) => {
    const agentDir = "/tmp/openclaw-auth-bookkeeping-merge";
    const order = { openai: ["openai:default"] };
    const saved = action === "save";
    const credential = {
      type: "api_key" as const,
      provider: "openai",
      key: "sk-current",
    };
    setRuntimeAuthProfileStoreSnapshot(
      {
        version: 1,
        profiles: { "openai:default": credential },
        order: saved ? undefined : order,
        runtimeLocalOrderProviderIds: saved ? [] : ["openai"],
        usageStats: { "openai:default": { lastUsed: 1 } },
      },
      agentDir,
    );
    const snapshot = preparedSnapshot({
      config: {},
      authStores: [
        {
          agentDir,
          store: {
            version: 1,
            profiles: { "openai:default": credential },
            order: saved ? undefined : order,
            runtimeLocalOrderProviderIds: saved ? [] : ["openai"],
            usageStats: { "openai:default": { lastUsed: 1 } },
          },
        },
      ],
    });
    setRuntimeAuthProfileStoreSnapshot(
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

    expect(
      getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.usageStats?.["openai:default"],
    ).toMatchObject({ lastUsed: 2, cooldownUntil: expect.any(Number) });
    expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.order).toEqual(
      saved ? order : undefined,
    );
    expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.runtimeLocalOrderProviderIds).toEqual(
      saved ? ["openai"] : [],
    );
    expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.lastGood?.openai).toBe(
      "openai:default",
    );
  });

  it("rolls back candidate credentials against the activation-time auth baseline", () => {
    const agentDir = "/tmp/openclaw-auth-activation-baseline";
    const profile = (provider: string, key: string) => ({
      type: "api_key" as const,
      provider,
      key,
    });
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
      "provider-a:default": profile("provider-a", "a-old"),
      "provider-b:default": profile("provider-b", "b-old"),
    };
    const predecessorState = {
      order: { provider: ["provider-a:default", "provider-b:default"] },
      lastGood: { provider: "provider-a:default" },
      usageStats: { "provider-b:default": { lastUsed: 1 } },
    };
    activateSnapshot(snapshot(predecessorProfiles, 19_001, predecessorState));
    const previous = getActiveSecretsRuntimeSnapshotState()!;
    const previousRevision = getActiveSecretsRuntimeSnapshotRevisionState();
    const activationProfiles = {
      ...predecessorProfiles,
      "provider-b:default": profile("provider-b", "b-external"),
      "provider-q:login": profile("provider-q", "q-external"),
    };
    const activationState = {
      order: { provider: ["provider-b:default", "provider-a:default"] },
      lastGood: { provider: "provider-b:default" },
      usageStats: {
        "provider-b:default": { lastUsed: 2, cooldownUntil: 30_000 },
      },
    };
    setRuntimeAuthProfileStoreSnapshot(
      { version: 1, profiles: activationProfiles, ...activationState },
      agentDir,
    );
    const preparedState = {
      order: { provider: ["provider-a:default"] },
      lastGood: { provider: "provider-a:default" },
      usageStats: { "provider-b:default": { lastUsed: 3 } },
    };
    const candidate = snapshot(
      {
        ...activationProfiles,
        "provider-a:default": profile("provider-a", "a-candidate"),
        "provider-x:candidate": profile("provider-x", "x-candidate"),
      },
      19_002,
      preparedState,
    );
    expect(activateSnapshotIfCurrent(candidate, { expectedRevision: previousRevision })).toBe(true);
    const liveAfterActivation = getRuntimeAuthProfileStoreSnapshotCore(agentDir)!;
    liveAfterActivation.order = { provider: ["provider-q:login", "provider-b:default"] };
    liveAfterActivation.lastGood = { provider: "provider-q:login" };
    liveAfterActivation.usageStats = {
      "provider-b:default": { lastUsed: 4, cooldownUntil: 40_000 },
    };
    setRuntimeAuthProfileStoreSnapshot(liveAfterActivation, agentDir);

    expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
    const restored = getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.profiles;
    expect(restored?.["provider-a:default"]).toMatchObject({ key: "a-old" });
    expect(restored?.["provider-b:default"]).toMatchObject({ key: "b-external" });
    expect(restored?.["provider-q:login"]).toMatchObject({ key: "q-external" });
    expect(restored?.["provider-x:candidate"]).toBeUndefined();
    const restoredStore = getRuntimeAuthProfileStoreSnapshotCore(agentDir);
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
      const profile = (provider: string, key: string) => ({
        type: "api_key" as const,
        provider,
        key,
      });
      const snapshot = (aKey: string | null, bKey: string, port: number, aExternal = false) =>
        preparedGatewayAuthSnapshot(agentDir, port, {
          version: 1,
          profiles: {
            ...(aKey === null ? {} : { "provider-a:default": profile("provider-a", aKey) }),
            "provider-b:default": profile("provider-b", bKey),
          },
          runtimeExternalProfileIds: aExternal ? ["provider-a:default"] : undefined,
        });
      activateSnapshot(snapshot(baselineAKey, "b-old", 19_001));
      const previous = getActiveSecretsRuntimeSnapshotState()!;
      const candidate = snapshot(candidateAKey, "b-old", 19_002);
      expect(activateSnapshotIfCurrent(candidate)).toBe(true);
      setRuntimeAuthProfileStoreSnapshot(
        snapshot(currentAKey, "b-external", 19_002, currentAExternal).authStores[0]!.store,
        agentDir,
      );
      noteRuntimeAuthProfileStorePersistedMutation(agentDir, {
        credentialsChanged: true,
        stateChanged: false,
        profileIds: ["provider-b:default"],
      });

      expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
      const restored = getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.profiles;
      if (expectedAKey === null) {
        expect(restored?.["provider-a:default"]).toBeUndefined();
      } else {
        expect(restored?.["provider-a:default"]).toMatchObject({ key: expectedAKey });
      }
      expect(restored?.["provider-b:default"]).toMatchObject({ key: "b-external" });
      if (currentAExternal) {
        expect(
          getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.runtimeExternalProfileIds,
        ).toContain("provider-a:default");
      }
    },
  );

  it.each([
    ["local override", ["openai:default"], "sk-old"],
    ["inherited profile", [], "sk-candidate"],
  ])("uses the effective owner token for %s", (_label, runtimeLocalProfileIds, expected) => {
    const agentDir = `/tmp/openclaw-auth-effective-owner-${runtimeLocalProfileIds.length}`;
    const snapshot = (key: string, port: number) =>
      preparedGatewayAuthSnapshot(agentDir, port, {
        version: 1,
        profiles: {
          "openai:default": { type: "api_key", provider: "openai", key },
        },
        runtimeLocalProfileIds,
      });
    activateSnapshot(snapshot("sk-old", 19_001));
    const previous = getActiveSecretsRuntimeSnapshotState()!;
    const candidate = snapshot("sk-candidate", 19_002);
    expect(activateSnapshotIfCurrent(candidate)).toBe(true);
    noteRuntimeAuthProfileStorePersistedMutation(undefined, {
      credentialsChanged: true,
      stateChanged: false,
      profileIds: ["openai:default"],
    });
    setRuntimeAuthProfileStoreSnapshot(candidate.authStores[0]!.store, agentDir);

    expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
    expect(
      getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.profiles["openai:default"],
    ).toMatchObject({
      key: expected,
    });
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
    const profileX = {
      type: "api_key" as const,
      provider: "openai",
      key: "sk-external-x",
    };
    const profileY = {
      type: "api_key" as const,
      provider: "openai",
      key: "sk-external-y",
    };
    activateSnapshot(
      snapshot({ "openai:x": profileX, "openai:y": profileY }, ["openai:x", "openai:y"], 19_001),
    );
    const previous = getActiveSecretsRuntimeSnapshotState()!;
    const candidate = snapshot({ "openai:y": profileY }, ["openai:y"], 19_002);
    expect(activateSnapshotIfCurrent(candidate)).toBe(true);
    noteRuntimeAuthProfileStorePersistedMutation(undefined, {
      credentialsChanged: true,
      stateChanged: false,
      profileIds: ["openai:x"],
    });
    setRuntimeAuthProfileStoreSnapshot(candidate.authStores[0]!.store, agentDir);

    expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
    expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)).toBeUndefined();
  });

  it.each([true, false])(
    "handles baseline external to inherited with mutation=%s",
    (mutateCandidateOwner) => {
      const agentDir = `/tmp/openclaw-auth-external-to-inherited-${mutateCandidateOwner}`;
      const snapshot = (key: string, owner: "external" | "inherited" | "local", port: number) =>
        preparedGatewayAuthSnapshot(agentDir, port, {
          version: 1,
          profiles: {
            "openai:x": { type: "api_key", provider: "openai", key },
          },
          runtimeExternalProfileIds: owner === "external" ? ["openai:x"] : [],
          runtimeLocalProfileIds: owner === "local" ? ["openai:x"] : [],
        });
      activateSnapshot(snapshot("sk-external-old", "external", 19_001));
      const previous = getActiveSecretsRuntimeSnapshotState()!;
      const candidate = snapshot("sk-candidate", "inherited", 19_002);
      expect(activateSnapshotIfCurrent(candidate)).toBe(true);
      if (mutateCandidateOwner) {
        noteRuntimeAuthProfileStorePersistedMutation(undefined, {
          credentialsChanged: true,
          stateChanged: false,
          profileIds: ["openai:x"],
        });
      }
      setRuntimeAuthProfileStoreSnapshot(
        snapshot(mutateCandidateOwner ? "sk-candidate" : "sk-descendant", "inherited", 19_002)
          .authStores[0]!.store,
        agentDir,
      );

      expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
      if (mutateCandidateOwner) {
        expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)).toBeUndefined();
      } else {
        const restored = getRuntimeAuthProfileStoreSnapshotCore(agentDir);
        expect(restored?.profiles["openai:x"]).toMatchObject({ key: "sk-external-old" });
        expect(restored?.runtimeExternalProfileIds).toContain("openai:x");
      }
    },
  );

  it("invalidates candidate external ownership after a baseline inherited mutation", () => {
    const agentDir = `/tmp/openclaw-auth-inherited-to-external`;
    const snapshot = (
      key: string | null,
      owner: "external" | "inherited" | "local",
      port: number,
    ) =>
      preparedGatewayAuthSnapshot(agentDir, port, {
        version: 1,
        profiles: {
          ...(key === null
            ? {}
            : { "openai:x": { type: "api_key" as const, provider: "openai", key } }),
          "anthropic:stable": {
            type: "api_key",
            provider: "anthropic",
            key: "sk-stable",
          },
        },
        runtimeExternalProfileIds: owner === "external" ? ["openai:x"] : [],
        runtimeLocalProfileIds: ["anthropic:stable", ...(owner === "local" ? ["openai:x"] : [])],
      });
    activateSnapshot(snapshot("sk-baseline", "inherited", 19_001));
    const previous = getActiveSecretsRuntimeSnapshotState()!;
    const candidate = snapshot("sk-external", "external", 19_002);
    expect(activateSnapshotIfCurrent(candidate)).toBe(true);
    noteRuntimeAuthProfileStorePersistedMutation(undefined, {
      credentialsChanged: true,
      stateChanged: false,
      profileIds: ["openai:x"],
    });
    setRuntimeAuthProfileStoreSnapshot(candidate.authStores[0]!.store, agentDir);

    expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
    expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)).toBeUndefined();
  });

  it("restores unchanged inherited ownership after a candidate external refresh", () => {
    const agentDir = `/tmp/openclaw-auth-inherited-external-refresh`;
    const snapshot = (
      key: string | null,
      owner: "external" | "inherited" | "local",
      port: number,
    ) =>
      preparedGatewayAuthSnapshot(agentDir, port, {
        version: 1,
        profiles: {
          ...(key === null
            ? {}
            : { "openai:x": { type: "api_key" as const, provider: "openai", key } }),
          "anthropic:stable": {
            type: "api_key",
            provider: "anthropic",
            key: "sk-stable",
          },
        },
        runtimeExternalProfileIds: owner === "external" ? ["openai:x"] : [],
        runtimeLocalProfileIds: ["anthropic:stable", ...(owner === "local" ? ["openai:x"] : [])],
      });
    const baseline = snapshot("sk-baseline", "inherited", 19_001);
    activateSnapshot(baseline);
    const previous = getActiveSecretsRuntimeSnapshotState()!;
    const candidate = snapshot("sk-external", "external", 19_002);
    expect(activateSnapshotIfCurrent(candidate)).toBe(true);
    setRuntimeAuthProfileStoreSnapshot(
      snapshot("sk-external-refresh", "external", 19_002).authStores[0]!.store,
      agentDir,
    );

    expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
    const restored = getRuntimeAuthProfileStoreSnapshotCore(agentDir);
    expect(restored?.profiles["openai:x"]).toMatchObject({ key: "sk-baseline" });
    expect(restored?.runtimeExternalProfileIds ?? []).not.toContain("openai:x");
  });

  it("preserves external owner metadata when bytes equal the local candidate", () => {
    const agentDir = `/tmp/openclaw-auth-local-external-equal-bytes`;
    const snapshot = (key: string, owner: "external" | "local", port: number) =>
      preparedGatewayAuthSnapshot(agentDir, port, {
        version: 1,
        profiles: {
          "openai:x": { type: "api_key", provider: "openai", key },
        },
        runtimeExternalProfileIds: owner === "external" ? ["openai:x"] : [],
        runtimeLocalProfileIds: owner === "local" ? ["openai:x"] : [],
      });
    activateSnapshot(snapshot("sk-old", "local", 19_001));
    const previous = getActiveSecretsRuntimeSnapshotState()!;
    const candidate = snapshot("sk-candidate", "local", 19_002);
    expect(activateSnapshotIfCurrent(candidate)).toBe(true);
    setRuntimeAuthProfileStoreSnapshot(
      snapshot("sk-candidate", "external", 19_002).authStores[0]!.store,
      agentDir,
    );

    expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
    const restored = getRuntimeAuthProfileStoreSnapshotCore(agentDir);
    expect(restored?.profiles["openai:x"]).toMatchObject({ key: "sk-candidate" });
    expect(restored?.runtimeExternalProfileIds).toContain("openai:x");
    expect(restored?.runtimeLocalProfileIds ?? []).not.toContain("openai:x");
  });

  it("preserves an authoritative empty external overlay on rollback", () => {
    const agentDir = "/tmp/openclaw-auth-authoritative-empty-external";
    const snapshot = (authoritative: boolean, port: number) =>
      preparedGatewayAuthSnapshot(agentDir, port, {
        version: 1,
        profiles: {},
        runtimeExternalProfileIds: [],
        runtimeExternalProfileIdsAuthoritative: authoritative ? true : undefined,
      });
    activateSnapshot(snapshot(true, 19_001));
    const previous = getActiveSecretsRuntimeSnapshotState()!;
    const candidate = snapshot(false, 19_002);
    expect(activateSnapshotIfCurrent(candidate)).toBe(true);

    expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
    expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)).toMatchObject({
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
    activateSnapshot(snapshot("sk-old", false, 19_001));
    const previous = getActiveSecretsRuntimeSnapshotState()!;
    const candidate = snapshot("sk-old", true, 19_002);
    expect(activateSnapshotIfCurrent(candidate)).toBe(true);
    setRuntimeAuthProfileStoreSnapshot(
      snapshot("sk-current", true, 19_002).authStores[0]!.store,
      agentDir,
    );

    expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
    const restored = getRuntimeAuthProfileStoreSnapshotCore(agentDir);
    expect(restored?.profiles["openai:x"]).toMatchObject({ key: "sk-current" });
    expect(restored?.runtimeExternalProfileIdsAuthoritative).toBeUndefined();
  });

  it.each([["sk-candidate", "sk-old"]])(
    "keeps external profile ownership separate from main mutations",
    (current, expected) => {
      const agentDir = `/tmp/openclaw-auth-external-owner-${current}`;
      const snapshot = (key: string, port: number) =>
        preparedGatewayAuthSnapshot(agentDir, port, {
          version: 1,
          profiles: {
            "openai:external": { type: "api_key", provider: "openai", key },
          },
          runtimeExternalProfileIds: ["openai:external"],
        });
      activateSnapshot(snapshot("sk-old", 19_001));
      const previous = getActiveSecretsRuntimeSnapshotState()!;
      const candidate = snapshot("sk-candidate", 19_002);
      expect(activateSnapshotIfCurrent(candidate)).toBe(true);
      noteRuntimeAuthProfileStorePersistedMutation(undefined, {
        credentialsChanged: true,
        stateChanged: false,
        profileIds: ["openai:external"],
      });
      setRuntimeAuthProfileStoreSnapshot(snapshot(current, 19_002).authStores[0]!.store, agentDir);

      expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
      expect(
        getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.profiles["openai:external"],
      ).toMatchObject({
        key: expected,
      });
    },
  );

  it("removes a rejected candidate credential when its bounded lineage was evicted", () => {
    const agentDir = "/tmp/openclaw-auth-evicted-lineage";
    const snapshot = (key: string, port: number) =>
      preparedGatewayAuthSnapshot(agentDir, port, {
        version: 1,
        profiles: {
          "openai:default": { type: "api_key", provider: "openai", key },
          "anthropic:stable": {
            type: "api_key",
            provider: "anthropic",
            key: "sk-stable",
          },
        },
        runtimeLocalProfileIds: ["anthropic:stable", "openai:default"],
      });
    activateSnapshot(snapshot("sk-old", 19_001));
    const previous = getActiveSecretsRuntimeSnapshotState()!;
    const candidate = snapshot("sk-candidate", 19_002);
    expect(activateSnapshotIfCurrent(candidate)).toBe(true);
    for (let index = 0; index < 300; index += 1) {
      noteRuntimeAuthProfileStorePersistedMutation(agentDir, {
        credentialsChanged: true,
        stateChanged: false,
        profileIds: [`openai:unrelated-${index}`],
      });
    }

    expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
    expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)).toBeUndefined();
  });

  it.each(["owner", "profile"] as const)(
    "drops a changed-ref descendant after $eviction lineage eviction",
    (eviction) => {
      const root = autoCleanupTempDirs.make("openclaw-auth-evicted-ref-");
      const agentDir = path.join(root, eviction);
      fs.mkdirSync(agentDir, { recursive: true });
      const previousRef = {
        source: "env" as const,
        provider: "default",
        id: "OPENAI_API_KEY",
      };
      const candidateRef = { ...previousRef, id: "OPENAI_API_KEY_NEXT" };
      const snapshot = (key: string, keyRef: typeof previousRef, port: number) =>
        preparedGatewayAuthSnapshot(agentDir, port, {
          version: 1,
          profiles: {
            "openai:default": { type: "api_key", provider: "openai", key, keyRef },
          },
          runtimeLocalProfileIds: ["openai:default"],
        });
      try {
        saveAuthProfileStore(
          snapshot("sk-old", previousRef, 19_001).authStores[0]!.store,
          agentDir,
        );
        activateSnapshot(snapshot("sk-old", previousRef, 19_001));
        const previous = getActiveSecretsRuntimeSnapshotState()!;
        const candidate = snapshot("sk-candidate", candidateRef, 19_002);
        expect(activateSnapshotIfCurrent(candidate)).toBe(true);
        setRuntimeAuthProfileStoreSnapshot(
          snapshot("sk-descendant", candidateRef, 19_002).authStores[0]!.store,
          agentDir,
        );
        for (let index = 0; index < 300; index += 1) {
          noteRuntimeAuthProfileStorePersistedMutation(
            eviction === "owner" ? `/tmp/openclaw-auth-unrelated-owner-${index}` : agentDir,
            {
              credentialsChanged: true,
              stateChanged: false,
              profileIds: [`openai:unrelated-${index}`],
            },
          );
        }

        expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
        expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)).toBeUndefined();
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
        preparedSnapshot({
          config: { gateway: { port } },
          authStores: includeStore
            ? [
                {
                  agentDir,
                  store: {
                    version: 1,
                    profiles: {
                      "openai:default": {
                        type: "api_key",
                        provider: "openai",
                        key: "sk-old",
                      },
                    },
                    runtimeLocalProfileIds: inheritsMainProfile ? [] : ["openai:default"],
                    runtimeInheritsMainState: inheritsMainState,
                  },
                },
              ]
            : [],
        });
      activateSnapshot(snapshot(true, 19_001));
      const previous = getActiveSecretsRuntimeSnapshotState()!;
      const candidate = snapshot(false, 19_002);
      expect(activateSnapshotIfCurrent(candidate)).toBe(true);
      noteRuntimeAuthProfileStorePersistedMutation(
        mutationOwner === "custom" ? agentDir : undefined,
        {
          credentialsChanged: !stateOnly,
          stateChanged: stateOnly,
          profileIds: [profileId],
        },
      );

      expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
      if (expectMissing) {
        expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)).toBeUndefined();
      } else {
        expect(
          getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.profiles["openai:default"],
        ).toMatchObject({ key: "sk-old" });
      }
    },
  );

  it("does not resurrect a baseline external store after a new main profile is added", () => {
    const agentDir = "/tmp/openclaw-auth-external-store-omission-mutation";
    const snapshot = (includeStore: boolean, port: number) =>
      preparedSnapshot({
        config: { gateway: { port } },
        authStores: includeStore
          ? [
              {
                agentDir,
                store: {
                  version: 1,
                  profiles: {
                    "openai:x": {
                      type: "api_key",
                      provider: "openai",
                      key: "sk-external",
                    },
                  },
                  runtimeExternalProfileIds: ["openai:x"],
                },
              },
            ]
          : [],
      });
    activateSnapshot(snapshot(true, 19_001));
    const previous = getActiveSecretsRuntimeSnapshotState()!;
    const candidate = snapshot(false, 19_002);
    expect(activateSnapshotIfCurrent(candidate)).toBe(true);
    noteRuntimeAuthProfileStorePersistedMutation(undefined, {
      credentialsChanged: true,
      profileSetChanged: true,
      stateChanged: false,
      profileIds: ["openai:new-main"],
    });

    expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
    expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)).toBeUndefined();
  });

  it("does not resurrect an auth store cleared after candidate activation", () => {
    const agentDir = "/tmp/openclaw-auth-post-activation-clear";
    const snapshot = (key: string, port: number) =>
      preparedGatewayAuthSnapshot(
        agentDir,
        port,
        createAuthProfileStoreFixture({
          "openai:default": { type: "api_key", provider: "openai", key },
        }),
      );
    activateSnapshot(snapshot("sk-old", 19_001));
    const previous = getActiveSecretsRuntimeSnapshotState()!;
    const candidate = snapshot("sk-candidate", 19_002);
    expect(activateSnapshotIfCurrent(candidate)).toBe(true);
    clearRuntimeAuthProfileStoreSnapshots();

    expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
    expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)).toBeUndefined();
  });

  it.each([
    ["retains a resolved value for the same auth-store SecretRef", false],
    ["restores the predecessor when the auth-store SecretRef changed", true],
  ])("%s", (_label, changedRef) => {
    const agentDir = `/tmp/openclaw-auth-ref-rollback-${changedRef}`;
    const previousRef = {
      source: "env" as const,
      provider: "default",
      id: "OPENAI_API_KEY",
    };
    const candidateRef = changedRef ? { ...previousRef, id: "OPENAI_API_KEY_NEXT" } : previousRef;
    const snapshot = (key: string, keyRef: typeof previousRef, port: number) =>
      preparedGatewayAuthSnapshot(
        agentDir,
        port,
        createAuthProfileStoreFixture({
          "openai:default": { type: "api_key", provider: "openai", key, keyRef },
        }),
      );
    activateSnapshot(snapshot("sk-old", previousRef, 19_001));
    const previous = getActiveSecretsRuntimeSnapshotState()!;
    const candidate = snapshot("sk-candidate", candidateRef, 19_002);
    expect(activateSnapshotIfCurrent(candidate)).toBe(true);
    const candidateRevision = getActiveSecretsRuntimeSnapshotRevisionState();
    expect(
      activateSnapshotIfCurrent(snapshot("sk-refreshed", candidateRef, 19_002), {
        expectedRevision: candidateRevision,
        preserveActivationLineage: true,
      }),
    ).toBe(true);

    expect(
      restoreSnapshotIfCurrent(previous, candidate, { expectedRevision: candidateRevision }),
    ).toBe(true);
    expect(
      getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.profiles["openai:default"],
    ).toMatchObject({
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
    const previousKeyRef = {
      source: "env" as const,
      provider: "default",
      id: "OPENAI_API_KEY",
    };
    const candidateKeyRef = { ...previousKeyRef, id: candidateRefId };
    const snapshot = (params: {
      sourcePort: number;
      runtimePort: number;
      apiKey: string;
      keyRef: string | typeof previousKeyRef;
    }) =>
      preparedSnapshot({
        sourceConfig: {
          gateway: { port: params.sourcePort },
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                apiKey: params.keyRef,
                models: [],
              },
            },
          },
        },
        config: {
          gateway: { port: params.runtimePort },
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                apiKey: params.apiKey,
                models: [],
              },
            },
          },
        },
        authStores: [],
      });
    activateSnapshot(
      snapshot({
        sourcePort: 19_021,
        runtimePort: 19_021,
        apiKey: "sk-old",
        keyRef: previousKeyRef,
      }),
    );
    const previous = getActiveSecretsRuntimeSnapshotState()!;
    const candidate = snapshot({
      sourcePort: 19_022,
      runtimePort: 19_022,
      apiKey: "sk-candidate",
      keyRef: candidateKeyRef,
    });
    expect(activateSnapshotIfCurrent(candidate)).toBe(true);
    const candidateRevision = getActiveSecretsRuntimeSnapshotRevisionState();
    const providerRefresh = snapshot({
      sourcePort: 19_022,
      runtimePort: 19_022,
      apiKey: "sk-refreshed",
      keyRef: candidateKeyRef,
    });
    expect(
      activateSnapshotIfCurrent(providerRefresh, {
        expectedRevision: candidateRevision,
        preserveActivationLineage: true,
      }),
    ).toBe(true);

    expect(
      restoreSnapshotIfCurrent(previous, candidate, { expectedRevision: candidateRevision }),
    ).toBe(true);
    expect(getActiveSecretsRuntimeSnapshotState()?.config.gateway?.port).toBe(19_021);
    expect(getActiveSecretsRuntimeSnapshotState()?.config.models?.providers?.openai?.apiKey).toBe(
      expectedKey,
    );
  });

  it.each([
    {
      evictLineage: true,
      label: "provider definition with evicted lineage",
      keyRef: { source: "file", provider: "vault", id: "openai" } satisfies SecretRef,
      previousSourceConfig: {
        secrets: {
          providers: { vault: { source: "file", path: "/tmp/old-secrets.json" } },
        },
      } satisfies OpenClawConfig,
      candidateSourceConfig: {
        secrets: {
          providers: { vault: { source: "file", path: "/tmp/rejected-secrets.json" } },
        },
      } satisfies OpenClawConfig,
    },
    {
      evictLineage: false,
      label: "plugin integration owner",
      keyRef: { source: "exec", provider: "plugin-vault", id: "openai" } satisfies SecretRef,
      previousSourceConfig: {
        secrets: {
          providers: {
            "plugin-vault": {
              source: "exec",
              pluginIntegration: { pluginId: "secret-plugin", integrationId: "vault" },
            },
          },
        },
        plugins: { entries: { "secret-plugin": { enabled: true } } },
      } satisfies OpenClawConfig,
      candidateSourceConfig: {
        secrets: {
          providers: {
            "plugin-vault": {
              source: "exec",
              pluginIntegration: { pluginId: "secret-plugin", integrationId: "vault" },
            },
          },
        },
        plugins: { entries: { "secret-plugin": { enabled: false } } },
      } satisfies OpenClawConfig,
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
      const snapshot = (params: { sourceConfig: OpenClawConfig; apiKey: string; port: number }) =>
        preparedSnapshot({
          sourceConfig: {
            ...params.sourceConfig,
            gateway: { port: params.port },
            models: {
              providers: {
                openai: {
                  baseUrl: "https://api.openai.com/v1",
                  apiKey: keyRef,
                  models: [],
                },
              },
            },
          },
          config: {
            ...params.sourceConfig,
            gateway: { port: params.port },
            models: {
              providers: {
                openai: {
                  baseUrl: "https://api.openai.com/v1",
                  apiKey: params.apiKey,
                  models: [],
                },
              },
            },
          },
          authStores: [
            {
              agentDir,
              store: createAuthProfileStoreFixture({
                "openai:default": {
                  type: "api_key",
                  provider: "openai",
                  keyRef,
                  key: params.apiKey,
                },
              }),
            },
          ],
        });
      activateSnapshot(
        snapshot({ sourceConfig: previousSourceConfig, apiKey: "sk-old", port: 19_031 }),
      );
      const previous = getActiveSecretsRuntimeSnapshotState()!;
      const candidate = snapshot({
        sourceConfig: candidateSourceConfig,
        apiKey: "sk-candidate",
        port: 19_032,
      });
      expect(activateSnapshotIfCurrent(candidate)).toBe(true);
      if (evictLineage) {
        for (let index = 0; index < 300; index += 1) {
          noteRuntimeAuthProfileStorePersistedMutation(agentDir, {
            credentialsChanged: true,
            stateChanged: false,
            profileIds: [`openai:unrelated-${index}`],
          });
        }
      }
      const candidateRevision = getActiveSecretsRuntimeSnapshotRevisionState();
      expect(
        activateSnapshotIfCurrent(
          snapshot({
            sourceConfig: candidateSourceConfig,
            apiKey: "sk-refreshed",
            port: 19_032,
          }),
          {
            expectedRevision: candidateRevision,
            preserveActivationLineage: true,
          },
        ),
      ).toBe(true);

      expect(
        restoreSnapshotIfCurrent(previous, candidate, { expectedRevision: candidateRevision }),
      ).toBe(true);
      const restored = getActiveSecretsRuntimeSnapshotState();
      expect(restored?.sourceConfig).toMatchObject(previousSourceConfig);
      expect(restored?.config.models?.providers?.openai?.apiKey).toBe("sk-old");
      if (evictLineage) {
        expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)).toBeUndefined();
      } else {
        expect(
          getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.profiles["openai:default"],
        ).toMatchObject({
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
      const keyRef = {
        source: "file" as const,
        provider: "vault",
        id: "openai",
      };
      const snapshot = (params: {
        key: string;
        owner: "inherited" | "local";
        providerPath: string;
        port: number;
      }) =>
        preparedSnapshot({
          sourceConfig: {
            gateway: { port: params.port },
            secrets: {
              providers: { vault: { source: "file", path: params.providerPath } },
            },
          },
          config: { gateway: { port: params.port } },
          authStores: [
            {
              agentDir,
              store: {
                version: 1,
                profiles: {
                  "openai:default": {
                    type: "api_key",
                    provider: "openai",
                    key: params.key,
                    keyRef,
                  },
                },
                runtimeLocalProfileIds: params.owner === "local" ? ["openai:default"] : [],
              },
            },
          ],
        });
      activateSnapshot(
        snapshot({
          key: "sk-old",
          owner: capturedOwner,
          providerPath: "/tmp/old-secrets.json",
          port: 19_041,
        }),
      );
      const previous = getActiveSecretsRuntimeSnapshotState()!;
      const candidate = snapshot({
        key: "sk-candidate",
        owner: capturedOwner,
        providerPath: "/tmp/rejected-secrets.json",
        port: 19_042,
      });
      expect(activateSnapshotIfCurrent(candidate)).toBe(true);
      noteRuntimeAuthProfileStorePersistedMutation(agentDir, {
        credentialsChanged: true,
        stateChanged: false,
        profileIds: ["openai:default"],
      });
      setRuntimeAuthProfileStoreSnapshot(
        snapshot({
          key: "sk-durable",
          owner: currentOwner,
          providerPath: "/tmp/rejected-secrets.json",
          port: 19_042,
        }).authStores[0]!.store,
        agentDir,
      );

      expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
      expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)).toBeUndefined();
    },
  );

  it.each([
    ["vault", true],
    ["stable", false],
  ] as const)(
    "handles a durable ref-id update through %s with affected=%s",
    (currentProvider, affectedProvider) => {
      const agentDir = `/tmp/openclaw-auth-provider-ref-update-${currentProvider}`;
      const previousSourceConfig = {
        secrets: {
          providers: {
            stable: { source: "file" as const, path: "/tmp/stable-secrets.json" },
            vault: { source: "file" as const, path: "/tmp/old-secrets.json" },
          },
        },
      };
      const candidateSourceConfig = {
        secrets: {
          providers: {
            stable: { source: "file" as const, path: "/tmp/stable-secrets.json" },
            vault: { source: "file" as const, path: "/tmp/rejected-secrets.json" },
          },
        },
      };
      const previousRef = {
        source: "file" as const,
        provider: "vault",
        id: "openai-a",
      };
      const currentRef = {
        source: "file" as const,
        provider: currentProvider,
        id: "openai-b",
      };
      const snapshot = (params: {
        key: string;
        keyRef: SecretRef;
        port: number;
        sourceConfig: OpenClawConfig;
      }) =>
        preparedSnapshot({
          sourceConfig: { ...params.sourceConfig, gateway: { port: params.port } },
          config: { gateway: { port: params.port } },
          authStores: [
            {
              agentDir,
              store: {
                version: 1,
                profiles: {
                  "openai:default": {
                    type: "api_key",
                    provider: "openai",
                    key: params.key,
                    keyRef: params.keyRef,
                  },
                },
                runtimeLocalProfileIds: ["openai:default"],
              },
            },
          ],
        });
      activateSnapshot(
        snapshot({
          key: "sk-old",
          keyRef: previousRef,
          port: 19_051,
          sourceConfig: previousSourceConfig,
        }),
      );
      const previous = getActiveSecretsRuntimeSnapshotState()!;
      const candidate = snapshot({
        key: "sk-candidate",
        keyRef: previousRef,
        port: 19_052,
        sourceConfig: candidateSourceConfig,
      });
      expect(activateSnapshotIfCurrent(candidate)).toBe(true);
      noteRuntimeAuthProfileStorePersistedMutation(agentDir, {
        credentialsChanged: true,
        stateChanged: false,
        profileIds: ["openai:default"],
      });
      setRuntimeAuthProfileStoreSnapshot(
        snapshot({
          key: "sk-durable",
          keyRef: currentRef,
          port: 19_052,
          sourceConfig: candidateSourceConfig,
        }).authStores[0]!.store,
        agentDir,
      );

      expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
      if (affectedProvider) {
        expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)).toBeUndefined();
      } else {
        expect(
          getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.profiles["openai:default"],
        ).toMatchObject({ key: "sk-durable", keyRef: currentRef });
      }
    },
  );

  it("invalidates an absent-profile external upsert under a rejected provider", () => {
    const agentDir = `/tmp/openclaw-auth-provider-absent-upsert-external`;
    const snapshot = (params: { includeProfile: boolean; providerPath: string; port: number }) =>
      preparedSnapshot({
        sourceConfig: {
          gateway: { port: params.port },
          secrets: {
            providers: { vault: { source: "file", path: params.providerPath } },
          },
        },
        config: { gateway: { port: params.port } },
        authStores: [
          {
            agentDir,
            store: {
              version: 1,
              profiles: {
                "anthropic:stable": {
                  type: "api_key",
                  provider: "anthropic",
                  key: "sk-stable",
                },
                ...(params.includeProfile
                  ? {
                      "openai:default": {
                        type: "api_key" as const,
                        provider: "openai",
                        key: "sk-current",
                        keyRef: {
                          source: "file" as const,
                          provider: "vault",
                          id: "openai-b",
                        },
                      },
                    }
                  : {}),
              },
              runtimeExternalProfileIds: params.includeProfile ? ["openai:default"] : [],
              runtimeLocalProfileIds: ["anthropic:stable"],
            },
          },
        ],
      });
    activateSnapshot(
      snapshot({
        includeProfile: false,
        providerPath: "/tmp/old-secrets.json",
        port: 19_061,
      }),
    );
    const previous = getActiveSecretsRuntimeSnapshotState()!;
    const candidate = snapshot({
      includeProfile: false,
      providerPath: "/tmp/rejected-secrets.json",
      port: 19_062,
    });
    expect(activateSnapshotIfCurrent(candidate)).toBe(true);
    setRuntimeAuthProfileStoreSnapshot(
      snapshot({
        includeProfile: true,
        providerPath: "/tmp/rejected-secrets.json",
        port: 19_062,
      }).authStores[0]!.store,
      agentDir,
    );

    expect(restoreSnapshotIfCurrent(previous, candidate)).toBe(true);
    expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)).toBeUndefined();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
