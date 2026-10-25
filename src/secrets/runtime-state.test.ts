import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { cloneAuthProfileStore } from "../agents/auth-profiles/clone.js";
import { createAuthProfileStoreFixture } from "../agents/auth-profiles/credential-fixtures.test-support.js";
import {
  observeCanonicalAuthProfileCredentials,
  withCanonicalAuthProfileCredentialObserver,
  type CanonicalAuthProfileCredentialObservation as Observation,
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
import type {
  AuthProfileStore as AuthStore,
  RuntimeAuthProfileStore as RuntimeStore,
} from "../agents/auth-profiles/types.js";
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
import type { OpenClawConfig as Config } from "../config/types.openclaw.js";
import type { SecretRef as Ref } from "../config/types.secrets.js";
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
  type PreparedSecretsRuntimeSnapshot as Snapshot,
} from "./runtime-state.js";

function noteCredentialMutation(agentDir: string | undefined, ...profileIds: string[]) {
  noteAuthMutation(agentDir, { credentialsChanged: true, stateChanged: false, profileIds });
}

function apiKeyProfile(provider: string, key: string, keyRef?: Ref) {
  return { type: "api_key" as const, provider, key, ...(keyRef ? { keyRef } : {}) };
}

function authStore(
  profiles: AuthStore["profiles"],
  state: Omit<Partial<RuntimeStore>, "profiles" | "version"> = {},
): RuntimeStore {
  return { version: 1, profiles, ...state };
}

function providerConfig(port: number, apiKey: string | Ref, source: Config = {}): Config {
  return {
    ...source,
    gateway: { port },
    models: {
      providers: { openai: { baseUrl: "https://api.openai.com/v1", apiKey, models: [] } },
    },
  };
}

function fileSource(providerPath: string, stable = false): Config {
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

function pluginSource(enabled: boolean): Config {
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

type PreparedSnapshotOverrides = Omit<
  Partial<Snapshot>,
  "authStoreCredentialsRevision" | "webTools" | "authStores"
> & { authStores?: Array<{ agentDir: string; store: RuntimeStore }> };

function preparedSnapshot(overrides: PreparedSnapshotOverrides = {}): Snapshot {
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

function authSnapshot(agentDir: string, port: number, store: RuntimeStore | undefined): Snapshot {
  return preparedSnapshot({
    config: { gateway: { port } },
    authStores: store ? [{ agentDir, store }] : [],
  });
}

type ActivateOptions = Omit<
  Parameters<typeof activateSecretsRuntimeSnapshotState>[0],
  "snapshot" | "refreshContext" | "refreshHandler"
>;

function activateSnapshot(snapshot: Snapshot, options: ActivateOptions = {}): void {
  activateSecretsRuntimeSnapshotState({
    snapshot,
    refreshContext: null,
    refreshHandler: null,
    ...options,
  });
}

function activateBaseline(snapshot: Snapshot) {
  activateSnapshot(snapshot);
  return getSnapshot()!;
}

function publishAuthStore(agentDir: string, snapshot: Snapshot) {
  setAuthStore(snapshot.authStores[0]!.store, agentDir);
}

function evictAuthLineage(agentDir: string, scope: "owner" | "profile" = "profile") {
  for (let index = 0; index < 300; index += 1) {
    noteCredentialMutation(
      scope === "owner" ? `/tmp/openclaw-auth-unrelated-owner-${index}` : agentDir,
      `openai:unrelated-${index}`,
    );
  }
}

type ActivateIfCurrentOptions = Omit<
  Parameters<typeof activateSecretsRuntimeSnapshotStateIfCurrent>[0],
  "snapshot" | "expectedRevision" | "refreshContext" | "refreshHandler"
> & { expectedRevision?: number };

function expectActivation(snapshot: Snapshot, options: ActivateIfCurrentOptions = {}): void {
  expect(
    activateSecretsRuntimeSnapshotStateIfCurrent({
      snapshot,
      expectedRevision: options.expectedRevision ?? getRevision(),
      refreshContext: null,
      refreshHandler: null,
      ...options,
    }),
  ).toBe(true);
}

function expectRollback(
  snapshot: Snapshot,
  ownedSnapshot: Snapshot,
  options: ActivateIfCurrentOptions = {},
): void {
  const restoration = prepareSecretsRuntimeSnapshotRestoreState({
    snapshot,
    ownedSnapshot,
    expectedRevision: options.expectedRevision ?? getRevision(),
    refreshContext: null,
    refreshHandler: null,
    ...options,
  });
  expect(restoration !== null && activateSecretsRuntimeSnapshotStateIfCurrent(restoration)).toBe(
    true,
  );
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

  it("preserves credential provenance and independent owners through rollback and teardown", async () => {
    const agentDir = "/tmp/openclaw-auth-observation-clones";
    const databasePath = resolveAuthProfileDatabasePath(agentDir);
    const ref = { source: "env", provider: "default", id: "OBSERVATION_TEST_KEY" } as const;
    const canonical = authStore({
      inline: apiKeyProfile("fixture", "canonical"),
      ref: { type: "api_key", provider: "fixture", keyRef: ref },
    });
    observeCanonicalAuthProfileCredentials(databasePath, canonical.profiles);
    const materialized = cloneAuthProfileStore(canonical);
    materialized.profiles.ref = apiKeyProfile("fixture", "resolved-only", ref);
    materialized.profiles.external = { type: "token", provider: "fixture", token: "external-only" };
    materialized.runtimeExternalProfileIds = ["external"];
    const initial = authSnapshot(agentDir, 19_001, materialized);
    initial.degradedOwners = [
      {
        ownerKind: "provider",
        ownerId: "openai",
        state: "unavailable",
        degradationState: "stale",
        paths: [],
        refKeys: [],
        reason: "secret provider failed",
      },
    ];
    const previous = activateBaseline(initial);
    setActiveCredentialDegradedOwner({
      ownerKind: "account",
      ownerId: "telegram:work",
      state: "unavailable",
      paths: [],
      refKeys: [],
      reason: "credential file is unavailable",
    });
    const rotated = cloneAuthProfileStore(materialized);
    rotated.profiles.inline = apiKeyProfile("fixture", "rotated");
    observeCanonicalAuthProfileCredentials(databasePath, { inline: rotated.profiles.inline });
    const candidate = authSnapshot(agentDir, 19_002, rotated);
    expectActivation(candidate);
    expect(listActiveDegradedSecretOwners()).toMatchObject([
      { ownerKind: "account", ownerId: "telegram:work" },
    ]);
    expectRollback(previous, candidate);
    expect(listActiveDegradedSecretOwners()).toMatchObject([
      { ownerKind: "provider", ownerId: "openai", degradationState: "stale" },
      { ownerKind: "account", ownerId: "telegram:work" },
    ]);
    const observations: Observation[] = [];
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
    clearSecretsRuntimeSnapshotState();
    expect(listActiveDegradedSecretOwners()).toEqual([]);
  });

  it("rejects a source-only secrets write after runtime config ownership changes", () => {
    const initialConfig = { gateway: { port: 19_030 } } satisfies Config;
    const concurrentConfig = { gateway: { port: 19_031 } } satisfies Config;
    activateSnapshot(preparedSnapshot({ sourceConfig: initialConfig, config: initialConfig }));
    const staleMetadata = getRuntimeConfigSnapshotMetadata()!;
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
    const runtimeConfig = { gateway: { port: 19_001 } } satisfies Config;
    activateSnapshot(preparedSnapshot({ sourceConfig: initialSource, config: runtimeConfig }), {
      runtimeSourceConfig: initialSource,
    });
    const runtimeMetadata = getRuntimeConfigSnapshotMetadata()!;
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
    descendant.config.gateway!.port = 19_002;
    expectActivation(descendant, {
      expectedRevision: committedRevision,
      runtimeSourceConfig: nextSource,
      preserveActivationLineage: true,
    });

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
    expect(getSnapshot()?.config.gateway?.port).toBe(19_002);
  });

  it.each(["save", "clear"])("preserves live auth bookkeeping after order %s", (action) => {
    const agentDir = "/tmp/openclaw-auth-bookkeeping-merge";
    const order = { openai: ["openai:default"] };
    const saved = action === "save";
    const credential = apiKeyProfile("openai", "sk-current");
    const store = (live: boolean) =>
      authStore(
        { "openai:default": credential },
        {
          order: live === saved ? order : undefined,
          runtimeLocalOrderProviderIds: live === saved ? ["openai"] : [],
          ...(live ? { lastGood: { openai: "openai:default" } } : {}),
          usageStats: {
            "openai:default": {
              lastUsed: live ? 2 : 1,
              ...(live ? { cooldownUntil: Date.now() + 60_000 } : {}),
            },
          },
        },
      );
    const baseline = store(false);
    setAuthStore(baseline, agentDir);
    const snapshot = preparedSnapshot({ authStores: [{ agentDir, store: baseline }] });
    setAuthStore(store(true), agentDir);

    activateSnapshot(snapshot);

    expect(getAuthStore(agentDir)?.order).toEqual(saved ? order : undefined);
    expect(getAuthStore(agentDir)).toMatchObject({
      usageStats: { "openai:default": { lastUsed: 2, cooldownUntil: expect.any(Number) } },
      runtimeLocalOrderProviderIds: saved ? ["openai"] : [],
      lastGood: { openai: "openai:default" },
    });
  });

  it("rolls back candidate credentials against the activation-time auth baseline", () => {
    const agentDir = "/tmp/openclaw-auth-activation-baseline";
    const snapshot = (
      profiles: AuthStore["profiles"],
      port: number,
      state: Pick<AuthStore, "order" | "lastGood" | "usageStats"> = {},
    ) => authSnapshot(agentDir, port, authStore(profiles, state));
    const a = "provider-a:default",
      b = "provider-b:default";
    const q = "provider-q:login",
      x = "provider-x:candidate";
    const profiles = (values: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(values).map(([id, key]) => [id, apiKeyProfile(id.split(":")[0]!, key)]),
      );
    const state = (order: string[], lastUsed: number, cooldownUntil?: number) => ({
      order: { provider: order },
      lastGood: { provider: order[0]! },
      usageStats: { [b]: { lastUsed, ...(cooldownUntil === undefined ? {} : { cooldownUntil }) } },
    });
    const previous = activateBaseline(
      snapshot(profiles({ [a]: "a-old", [b]: "b-old" }), 19_001, state([a, b], 1)),
    );
    const previousRevision = getRevision();
    const activationProfiles = profiles({ [a]: "a-old", [b]: "b-external", [q]: "q-external" });
    setAuthStore(authStore(activationProfiles, state([b, a], 2, 30_000)), agentDir);
    const candidate = snapshot(
      { ...activationProfiles, ...profiles({ [a]: "a-candidate", [x]: "x-candidate" }) },
      19_002,
      state([a], 3),
    );
    expectActivation(candidate, { expectedRevision: previousRevision });
    const liveAfterActivation = getAuthStore(agentDir)!;
    Object.assign(liveAfterActivation, state([q, b], 4, 40_000));
    setAuthStore(liveAfterActivation, agentDir);

    expectRollback(previous, candidate);
    expect(getAuthStore(agentDir)).toMatchObject({
      profiles: {
        "provider-a:default": { key: "a-old" },
        "provider-b:default": { key: "b-external" },
        "provider-q:login": { key: "q-external" },
      },
      order: { provider: ["provider-q:login", "provider-b:default"] },
      lastGood: { provider: "provider-q:login" },
      usageStats: { "provider-b:default": { lastUsed: 4, cooldownUntil: 40_000 } },
    });
    expect(getAuthStore(agentDir)?.profiles["provider-x:candidate"]).toBeUndefined();
  });

  it.each([
    ["triple rotation", "a-old", "a-candidate", "a-external", true, "a-external"],
    ["external logout", "a-old", "a-candidate", null, false, null],
  ])(
    "resolves per-profile ownership for %s while preserving post-activation profile B",
    (label, baselineAKey, candidateAKey, currentAKey, currentAExternal, expectedAKey) => {
      const agentDir = `/tmp/openclaw-auth-post-activation-${label}`;
      const snapshot = (aKey: string | null, bKey: string, port: number, aExternal = false) =>
        authSnapshot(agentDir, port, {
          version: 1,
          profiles: {
            ...(aKey === null ? {} : { "provider-a:default": apiKeyProfile("provider-a", aKey) }),
            "provider-b:default": apiKeyProfile("provider-b", bKey),
          },
          runtimeExternalProfileIds: aExternal ? ["provider-a:default"] : undefined,
        });
      const previous = activateBaseline(snapshot(baselineAKey, "b-old", 19_001));
      const candidate = snapshot(candidateAKey, "b-old", 19_002);
      expectActivation(candidate);
      publishAuthStore(agentDir, snapshot(currentAKey, "b-external", 19_002, currentAExternal));
      noteCredentialMutation(agentDir, "provider-b:default");

      expectRollback(previous, candidate);
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

  type Mutation = "main-profile" | "main-state" | "local-state" | "main-set" | "evict" | "clear";
  type RollbackRow = {
    name: string;
    before: RuntimeStore;
    next: RuntimeStore | undefined;
    current: RuntimeStore | undefined;
    mutation: Mutation | undefined;
    expected: Record<string, unknown> | undefined;
    metadata: { external?: boolean; authority?: true | "absent" } | undefined;
  };
  const owned = (key: string, owner: "local" | "inherited" | "external", stable = false) =>
    authStore(
      {
        "openai:x": apiKeyProfile("openai", key),
        ...(stable ? { "anthropic:stable": apiKeyProfile("anthropic", "stable") } : {}),
      },
      {
        runtimeExternalProfileIds: owner === "external" ? ["openai:x"] : [],
        runtimeLocalProfileIds: [
          ...(owner === "local" ? ["openai:x"] : []),
          ...(stable ? ["anthropic:stable"] : []),
        ],
      },
    );
  const keyIs = (key: string) => ({ profiles: { "openai:x": { key } } });
  const emptyExternal = (authoritative?: true) =>
    authStore(
      {},
      {
        runtimeExternalProfileIds: [],
        runtimeExternalProfileIdsAuthoritative: authoritative,
      },
    );
  const authorityStore = (key: string, authoritative?: true) => ({
    ...owned(key, "local"),
    runtimeExternalProfileIdsAuthoritative: authoritative,
  });
  const omitted = (inherited = false, state = false) => ({
    ...owned("old", inherited ? "inherited" : "local"),
    runtimeInheritsMainState: state,
  });

  const local0 = owned("old", "local"),
    local1 = owned("candidate", "local");
  const inherited0 = owned("old", "inherited"),
    inherited1 = owned("candidate", "inherited");
  const external0 = owned("old", "external"),
    external1 = owned("candidate", "external");
  const shared0 = owned("old", "inherited", true),
    shared1 = owned("candidate", "external", true);
  const partial0 = authStore(
    { ...external0.profiles, "openai:y": apiKeyProfile("openai", "y") },
    { runtimeExternalProfileIds: ["openai:x", "openai:y"] },
  );
  const partial1 = authStore(
    { "openai:y": apiKeyProfile("openai", "y") },
    { runtimeExternalProfileIds: ["openai:y"] },
  );
  it.each`
    name                             | before                            | next                                 | current                                 | mutation          | expected                                                                           | metadata
    ${"local override"}              | ${local0}                         | ${local1}                            | ${local1}                               | ${"main-profile"} | ${keyIs("old")}                                                                    | ${undefined}
    ${"inherited profile"}           | ${inherited0}                     | ${inherited1}                        | ${inherited1}                           | ${"main-profile"} | ${keyIs("candidate")}                                                              | ${undefined}
    ${"partial omission"}            | ${partial0}                       | ${partial1}                          | ${partial1}                             | ${"main-profile"} | ${undefined}                                                                       | ${undefined}
    ${"external to inherited write"} | ${external0}                      | ${inherited1}                        | ${inherited1}                           | ${"main-profile"} | ${undefined}                                                                       | ${undefined}
    ${"external to inherited"}       | ${external0}                      | ${inherited1}                        | ${owned("refreshed", "inherited")}      | ${undefined}      | ${keyIs("old")}                                                                    | ${{ external: true }}
    ${"inherited to external write"} | ${shared0}                        | ${shared1}                           | ${shared1}                              | ${"main-profile"} | ${undefined}                                                                       | ${undefined}
    ${"inherited to external"}       | ${shared0}                        | ${shared1}                           | ${owned("refreshed", "external", true)} | ${undefined}      | ${keyIs("old")}                                                                    | ${{ external: false }}
    ${"external takeover"}           | ${local0}                         | ${local1}                            | ${external1}                            | ${undefined}      | ${keyIs("candidate")}                                                              | ${{ external: true }}
    ${"empty overlay"}               | ${emptyExternal(true)}            | ${emptyExternal()}                   | ${undefined}                            | ${undefined}      | ${{ runtimeExternalProfileIds: [], runtimeExternalProfileIdsAuthoritative: true }} | ${undefined}
    ${"rejected authority"}          | ${authorityStore("old")}          | ${authorityStore("old", true)}       | ${authorityStore("current", true)}      | ${undefined}      | ${keyIs("current")}                                                                | ${{ authority: "absent" }}
    ${"external vs main"}            | ${external0}                      | ${external1}                         | ${external1}                            | ${"main-profile"} | ${keyIs("old")}                                                                    | ${undefined}
    ${"evicted lineage"}             | ${owned("old", "local", true)}    | ${owned("candidate", "local", true)} | ${undefined}                            | ${"evict"}        | ${undefined}                                                                       | ${undefined}
    ${"omitted, local state"}        | ${omitted()}                      | ${undefined}                         | ${undefined}                            | ${"local-state"}  | ${undefined}                                                                       | ${undefined}
    ${"omitted, unrelated state"}    | ${omitted()}                      | ${undefined}                         | ${undefined}                            | ${"main-state"}   | ${keyIs("old")}                                                                    | ${undefined}
    ${"omitted, inherited state"}    | ${omitted(true, true)}            | ${undefined}                         | ${undefined}                            | ${"main-state"}   | ${undefined}                                                                       | ${undefined}
    ${"omitted, inherited write"}    | ${omitted(true)}                  | ${undefined}                         | ${undefined}                            | ${"main-profile"} | ${undefined}                                                                       | ${undefined}
    ${"omitted, new main profile"}   | ${external0}                      | ${undefined}                         | ${undefined}                            | ${"main-set"}     | ${undefined}                                                                       | ${undefined}
    ${"cleared store"}               | ${authStore(inherited0.profiles)} | ${authStore(inherited1.profiles)}    | ${undefined}                            | ${"clear"}        | ${undefined}                                                                       | ${undefined}
  `(
    "rollback: $name",
    ({ name, before, next, current, mutation, expected, metadata }: RollbackRow) => {
      const agentDir = `/tmp/openclaw-auth-matrix-${name}`;
      const previous = activateBaseline(authSnapshot(agentDir, 19_001, before));
      const candidate = authSnapshot(agentDir, 19_002, next);
      expectActivation(candidate);
      if (mutation === "clear") {
        clearRuntimeAuthProfileStoreSnapshots();
      } else if (mutation === "evict") {
        evictAuthLineage(agentDir);
      } else if (mutation) {
        const stateChanged = mutation.endsWith("state");
        noteAuthMutation(mutation.startsWith("main") ? undefined : agentDir, {
          credentialsChanged: !stateChanged,
          stateChanged,
          ...(mutation === "main-set" ? { profileSetChanged: true } : {}),
          profileIds: [
            stateChanged ? "" : mutation === "main-set" ? "openai:new-main" : "openai:x",
          ],
        });
      }
      if (current) {
        publishAuthStore(agentDir, authSnapshot(agentDir, 19_002, current));
      }
      expectRollback(previous, candidate);
      const restored = getAuthStore(agentDir);
      if (expected === undefined) {
        expect(restored).toBeUndefined();
      } else {
        expect(restored).toMatchObject(expected);
      }
      if (metadata?.external !== undefined) {
        expect((restored?.runtimeExternalProfileIds ?? []).includes("openai:x")).toBe(
          metadata.external,
        );
        expect(restored?.runtimeLocalProfileIds ?? []).not.toContain("openai:x");
      }
      if (metadata?.authority === "absent") {
        expect(restored?.runtimeExternalProfileIdsAuthoritative).toBeUndefined();
      }
    },
  );

  it.each(["owner", "profile"] as const)(
    "drops a changed-ref descendant after %s lineage eviction",
    (eviction) => {
      const root = autoCleanupTempDirs.make("openclaw-auth-evicted-ref-");
      const agentDir = path.join(root, eviction);
      fs.mkdirSync(agentDir, { recursive: true });
      const previousRef = { source: "env" as const, provider: "default", id: "OPENAI_API_KEY" };
      const candidateRef = { ...previousRef, id: "OPENAI_API_KEY_NEXT" };
      const snapshot = (key: string, port: number, keyRef: Ref) =>
        authSnapshot(
          agentDir,
          port,
          authStore(
            { "openai:default": apiKeyProfile("openai", key, keyRef) },
            { runtimeLocalProfileIds: ["openai:default"] },
          ),
        );
      try {
        saveAuthProfileStore(
          snapshot("sk-old", 19_001, previousRef).authStores[0]!.store,
          agentDir,
        );
        const previous = activateBaseline(snapshot("sk-old", 19_001, previousRef));
        const candidate = snapshot("sk-candidate", 19_002, candidateRef);
        expectActivation(candidate);
        publishAuthStore(agentDir, snapshot("sk-descendant", 19_002, candidateRef));
        evictAuthLineage(agentDir, eviction);
        expectRollback(previous, candidate);
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
    ["auth store", false],
    ["auth store", true],
    ["provider config", false],
    ["provider config", true],
  ] as const)("rolls back %s with changed ref=%s", (surface, changedRef) => {
    const agentDir = "/tmp/openclaw-auth-ref-rollback";
    const previousRef = {
      source: "env",
      provider: "default",
      id: "OPENAI_API_KEY",
    } satisfies Ref;
    const candidateRef = changedRef ? { ...previousRef, id: "OPENAI_API_KEY_NEXT" } : previousRef;
    const snapshot = (key: string, ref: Ref, port: number) =>
      surface === "auth store"
        ? authSnapshot(
            agentDir,
            port,
            authStore({ "openai:default": apiKeyProfile("openai", key, ref) }),
          )
        : preparedSnapshot({
            sourceConfig: providerConfig(port, ref),
            config: providerConfig(port, key),
          });
    const previous = activateBaseline(snapshot("old", previousRef, 19_001));
    const candidate = snapshot("candidate", candidateRef, 19_002);
    expectActivation(candidate);
    const expectedRevision = getRevision();
    expectActivation(snapshot("refreshed", candidateRef, 19_002), {
      expectedRevision,
      preserveActivationLineage: true,
    });
    expectRollback(previous, candidate, { expectedRevision });
    if (surface === "auth store") {
      expect(getAuthStore(agentDir)?.profiles["openai:default"]).toMatchObject({
        key: changedRef ? "old" : "refreshed",
        keyRef: previousRef,
      });
    } else {
      expect(getSnapshot()?.config.gateway?.port).toBe(19_001);
      expect(getSnapshot()?.config.models?.providers?.openai?.apiKey).toBe(
        changedRef ? "old" : "refreshed",
      );
    }
  });

  it.each([
    "file-refresh",
    "plugin-refresh",
    "local-delete",
    "local-update",
    "ref-vault",
    "ref-stable",
    "external-upsert",
  ] as const)("rejects changed provider dependencies: %s", (mode) => {
    const agentDir = `/tmp/openclaw-auth-dependency-${mode}`;
    const refresh = mode.endsWith("refresh");
    const plugin = mode === "plugin-refresh";
    const upsert = mode === "external-upsert";
    const refUpdate = mode.startsWith("ref-");
    const previousRef: Ref = {
      source: plugin ? "exec" : "file",
      provider: plugin ? "plugin-vault" : "vault",
      id: refUpdate ? "openai-a" : "openai",
    };
    const currentRef: Ref =
      refUpdate || upsert
        ? { source: "file", provider: mode === "ref-stable" ? "stable" : "vault", id: "openai-b" }
        : previousRef;
    const beforeSource = plugin
      ? pluginSource(true)
      : fileSource("/tmp/old-secrets.json", refUpdate);
    const nextSource = plugin
      ? pluginSource(false)
      : fileSource("/tmp/rejected-secrets.json", refUpdate);
    const snapshot = (key: string, source: Config, port: number, current = false) => {
      const profiles: AuthStore["profiles"] = upsert
        ? { "anthropic:stable": apiKeyProfile("anthropic", "sk-stable") }
        : {};
      if (!upsert || current) {
        profiles["openai:default"] = apiKeyProfile(
          "openai",
          key,
          current ? currentRef : previousRef,
        );
      }
      const store = refresh
        ? createAuthProfileStoreFixture(profiles)
        : authStore(profiles, {
            runtimeLocalProfileIds: upsert
              ? ["anthropic:stable"]
              : mode === "local-delete" && current
                ? []
                : ["openai:default"],
            ...(upsert ? { runtimeExternalProfileIds: current ? ["openai:default"] : [] } : {}),
          });
      return preparedSnapshot({
        sourceConfig: refresh
          ? providerConfig(port, previousRef, source)
          : { ...source, gateway: { port } },
        config: refresh ? providerConfig(port, key, source) : { gateway: { port } },
        authStores: [{ agentDir, store }],
      });
    };
    const previous = activateBaseline(snapshot("old", beforeSource, 19_001));
    const candidate = snapshot("candidate", nextSource, 19_002);
    expectActivation(candidate);
    const expectedRevision = getRevision();
    if (refresh) {
      if (!plugin) {
        evictAuthLineage(agentDir);
      }
      expectActivation(snapshot("refreshed", nextSource, 19_002), {
        expectedRevision,
        preserveActivationLineage: true,
      });
    } else {
      if (!upsert) {
        noteCredentialMutation(agentDir, "openai:default");
      }
      publishAuthStore(agentDir, snapshot("durable", nextSource, 19_002, true));
    }
    expectRollback(previous, candidate, { expectedRevision });
    if (refresh) {
      expect(getSnapshot()?.sourceConfig).toMatchObject(beforeSource);
      expect(getSnapshot()?.config.models?.providers?.openai?.apiKey).toBe("old");
    }
    if (plugin || mode === "ref-stable") {
      expect(getAuthStore(agentDir)?.profiles["openai:default"]).toMatchObject({
        key: plugin ? "old" : "durable",
        keyRef: plugin ? previousRef : currentRef,
      });
    } else {
      expect(getAuthStore(agentDir)).toBeUndefined();
    }
  });
});
