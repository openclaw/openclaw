/** Tests secrets runtime state clone isolation and refresh context. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreSnapshot,
  noteRuntimeAuthProfileStoreCredentialsChanged,
  setRuntimeAuthProfileStoreSnapshot,
} from "../agents/auth-profiles/runtime-snapshots.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretRef } from "../config/types.secrets.js";
import { captureEnv } from "../test-utils/env.js";
import {
  activateSecretsRuntimeSnapshotState,
  activateSecretsRuntimeSnapshotStateIfCurrent,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeConfigSnapshot,
  getActiveSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshotRevision,
  restoreSecretsRuntimeSnapshotStateIfCurrent,
  type PreparedSecretsRuntimeSnapshot,
} from "./runtime-state.js";

describe("secrets runtime state", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  });

  afterEach(() => {
    clearSecretsRuntimeSnapshot();
    envSnapshot.restore();
  });

  it("exposes the active config pair for hot paths without requiring the full snapshot", () => {
    const snapshot: PreparedSecretsRuntimeSnapshot = {
      sourceConfig: { agents: { list: [{ id: "source" }] } },
      config: { agents: { list: [{ id: "runtime" }] } },
      authStores: [],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [],
      webTools: {
        search: { providerSource: "none", diagnostics: [] },
        fetch: { providerSource: "none", diagnostics: [] },
        diagnostics: [],
      },
    };

    activateSecretsRuntimeSnapshotState({
      snapshot,
      refreshContext: null,
      refreshHandler: null,
    });

    const configSnapshot = getActiveSecretsRuntimeConfigSnapshot();
    const fullSnapshot = getActiveSecretsRuntimeSnapshot();

    expect(configSnapshot?.config).not.toBe(fullSnapshot?.config);
    expect(configSnapshot?.sourceConfig).not.toBe(fullSnapshot?.sourceConfig);
    expect(configSnapshot?.config).toEqual(snapshot.config);
    expect(configSnapshot?.sourceConfig).toEqual(snapshot.sourceConfig);
  });

  it("preserves live auth bookkeeping when prepared credentials activate", () => {
    const agentDir = "/tmp/openclaw-auth-bookkeeping-merge";
    const credential = {
      type: "api_key" as const,
      provider: "openai",
      key: "sk-current",
    };
    setRuntimeAuthProfileStoreSnapshot(
      {
        version: 1,
        profiles: { "openai:default": credential },
        usageStats: { "openai:default": { lastUsed: 1 } },
      },
      agentDir,
    );
    const snapshot: PreparedSecretsRuntimeSnapshot = {
      sourceConfig: {},
      config: {},
      authStores: [
        {
          agentDir,
          store: {
            version: 1,
            profiles: { "openai:default": credential },
            usageStats: { "openai:default": { lastUsed: 1 } },
          },
        },
      ],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [],
      webTools: {
        search: { providerSource: "none", diagnostics: [] },
        fetch: { providerSource: "none", diagnostics: [] },
        diagnostics: [],
      },
    };
    setRuntimeAuthProfileStoreSnapshot(
      {
        version: 1,
        profiles: { "openai:default": credential },
        usageStats: {
          "openai:default": { lastUsed: 2, cooldownUntil: Date.now() + 60_000 },
        },
      },
      agentDir,
    );

    activateSecretsRuntimeSnapshotState({
      snapshot,
      refreshContext: null,
      refreshHandler: null,
    });

    expect(
      getRuntimeAuthProfileStoreSnapshot(agentDir)?.usageStats?.["openai:default"],
    ).toMatchObject({ lastUsed: 2, cooldownUntil: expect.any(Number) });
  });

  it("removes candidate-only auth profiles when rolling config back", () => {
    const agentDir = "/tmp/openclaw-auth-rollback-cas";
    const snapshot = (key: string, port: number): PreparedSecretsRuntimeSnapshot => ({
      sourceConfig: {},
      config: { gateway: { port } },
      authStores: [
        {
          agentDir,
          store: {
            version: 1,
            profiles: {
              "openai:default": { type: "api_key", provider: "openai", key },
            },
          },
        },
      ],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [],
      webTools: {
        search: { providerSource: "none", diagnostics: [] },
        fetch: { providerSource: "none", diagnostics: [] },
        diagnostics: [],
      },
    });
    activateSecretsRuntimeSnapshotState({
      snapshot: snapshot("sk-old", 19_001),
      refreshContext: null,
      refreshHandler: null,
    });
    const previous = getActiveSecretsRuntimeSnapshot();
    const previousRevision = getActiveSecretsRuntimeSnapshotRevision();
    const candidate = snapshot("sk-old", 19_002);
    candidate.authStores[0]!.store.profiles["anthropic:candidate"] = {
      type: "api_key",
      provider: "anthropic",
      key: "sk-rejected-candidate",
    };
    expect(previous).not.toBeNull();
    expect(
      activateSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: candidate,
        expectedRevision: previousRevision,
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    const candidateRevision = getActiveSecretsRuntimeSnapshotRevision();
    expect(
      restoreSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: previous!,
        expectedRevision: candidateRevision,
        ownedSnapshot: candidate,
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    expect(getActiveSecretsRuntimeSnapshot()?.config.gateway?.port).toBe(19_001);
    expect(getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles["openai:default"]).toMatchObject({
      key: "sk-old",
    });
    expect(
      getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles["anthropic:candidate"],
    ).toBeUndefined();
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
    ): PreparedSecretsRuntimeSnapshot => ({
      sourceConfig: {},
      config: { gateway: { port } },
      authStores: [{ agentDir, store: { version: 1, profiles, ...state } }],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [],
      webTools: {
        search: { providerSource: "none", diagnostics: [] },
        fetch: { providerSource: "none", diagnostics: [] },
        diagnostics: [],
      },
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
    activateSecretsRuntimeSnapshotState({
      snapshot: snapshot(predecessorProfiles, 19_001, predecessorState),
      refreshContext: null,
      refreshHandler: null,
    });
    const previous = getActiveSecretsRuntimeSnapshot()!;
    const previousRevision = getActiveSecretsRuntimeSnapshotRevision();
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
    expect(
      activateSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: candidate,
        expectedRevision: previousRevision,
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    const liveAfterActivation = getRuntimeAuthProfileStoreSnapshot(agentDir)!;
    liveAfterActivation.order = { provider: ["provider-q:login", "provider-b:default"] };
    liveAfterActivation.lastGood = { provider: "provider-q:login" };
    liveAfterActivation.usageStats = {
      "provider-b:default": { lastUsed: 4, cooldownUntil: 40_000 },
    };
    setRuntimeAuthProfileStoreSnapshot(liveAfterActivation, agentDir);

    expect(
      restoreSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: previous,
        expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
        ownedSnapshot: candidate,
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    const restored = getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles;
    expect(restored?.["provider-a:default"]).toMatchObject({ key: "a-old" });
    expect(restored?.["provider-b:default"]).toMatchObject({ key: "b-external" });
    expect(restored?.["provider-q:login"]).toMatchObject({ key: "q-external" });
    expect(restored?.["provider-x:candidate"]).toBeUndefined();
    const restoredStore = getRuntimeAuthProfileStoreSnapshot(agentDir);
    expect(restoredStore?.order?.provider).toEqual(["provider-q:login", "provider-b:default"]);
    expect(restoredStore?.lastGood?.provider).toBe("provider-q:login");
    expect(restoredStore?.usageStats?.["provider-b:default"]).toMatchObject({
      lastUsed: 4,
      cooldownUntil: 40_000,
    });
  });

  it("preserves an auth rotation captured by the candidate", () => {
    const finalKey = "sk-candidate";
    const agentDir = "/tmp/openclaw-auth-rollback-sk-candidate";
    const snapshot = (key: string, port: number): PreparedSecretsRuntimeSnapshot => ({
      sourceConfig: {},
      config: { gateway: { port } },
      authStores: [
        {
          agentDir,
          store: {
            version: 1,
            profiles: {
              "openai:default": { type: "api_key", provider: "openai", key },
            },
          },
        },
      ],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [],
      webTools: {
        search: { providerSource: "none", diagnostics: [] },
        fetch: { providerSource: "none", diagnostics: [] },
        diagnostics: [],
      },
    });
    activateSecretsRuntimeSnapshotState({
      snapshot: snapshot("sk-old", 19_001),
      refreshContext: null,
      refreshHandler: null,
    });
    const previous = getActiveSecretsRuntimeSnapshot()!;
    const previousRevision = getActiveSecretsRuntimeSnapshotRevision();
    setRuntimeAuthProfileStoreSnapshot(
      snapshot("sk-candidate", 19_002).authStores[0]!.store,
      agentDir,
    );
    const candidate = snapshot("sk-candidate", 19_002);
    candidate.authStores[0]!.store.profiles["anthropic:candidate"] = {
      type: "api_key",
      provider: "anthropic",
      key: "sk-rejected-candidate",
    };
    expect(
      activateSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: candidate,
        expectedRevision: previousRevision,
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    expect(
      restoreSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: previous,
        expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
        ownedSnapshot: candidate,
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    expect(getActiveSecretsRuntimeSnapshot()?.config.gateway?.port).toBe(19_001);
    expect(getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles["openai:default"]).toMatchObject({
      key: finalKey,
    });
    expect(
      getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles["anthropic:candidate"],
    ).toBeUndefined();
  });

  it.each([
    {
      label: "candidate change",
      baselineAKey: "a-old",
      candidateAKey: "a-candidate",
      currentAKey: "a-candidate",
      expectedAKey: "a-old",
    },
    {
      label: "candidate deletion",
      baselineAKey: "a-old",
      candidateAKey: null,
      currentAKey: null,
      expectedAKey: "a-old",
    },
    {
      label: "triple rotation",
      baselineAKey: "a-old",
      candidateAKey: "a-candidate",
      currentAKey: "a-external",
      expectedAKey: "a-external",
    },
    {
      label: "external logout",
      baselineAKey: "a-old",
      candidateAKey: "a-candidate",
      currentAKey: null,
      expectedAKey: null,
    },
    {
      label: "candidate-only overwrite",
      baselineAKey: null,
      candidateAKey: "a-candidate",
      currentAKey: "a-external",
      expectedAKey: "a-external",
    },
  ])(
    "resolves per-profile ownership for $label while preserving post-activation profile B",
    ({ label, baselineAKey, candidateAKey, currentAKey, expectedAKey }) => {
      const agentDir = `/tmp/openclaw-auth-post-activation-${label}`;
      const profile = (provider: string, key: string) => ({
        type: "api_key" as const,
        provider,
        key,
      });
      const snapshot = (
        aKey: string | null,
        bKey: string,
        port: number,
      ): PreparedSecretsRuntimeSnapshot => ({
        sourceConfig: {},
        config: { gateway: { port } },
        authStores: [
          {
            agentDir,
            store: {
              version: 1,
              profiles: {
                ...(aKey === null ? {} : { "provider-a:default": profile("provider-a", aKey) }),
                "provider-b:default": profile("provider-b", bKey),
              },
            },
          },
        ],
        authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
        warnings: [],
        webTools: {
          search: { providerSource: "none", diagnostics: [] },
          fetch: { providerSource: "none", diagnostics: [] },
          diagnostics: [],
        },
      });
      activateSecretsRuntimeSnapshotState({
        snapshot: snapshot(baselineAKey, "b-old", 19_001),
        refreshContext: null,
        refreshHandler: null,
      });
      const previous = getActiveSecretsRuntimeSnapshot()!;
      const candidate = snapshot(candidateAKey, "b-old", 19_002);
      expect(
        activateSecretsRuntimeSnapshotStateIfCurrent({
          snapshot: candidate,
          expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
          refreshContext: null,
          refreshHandler: null,
        }),
      ).toBe(true);
      setRuntimeAuthProfileStoreSnapshot(
        snapshot(currentAKey, "b-external", 19_002).authStores[0]!.store,
        agentDir,
      );
      noteRuntimeAuthProfileStoreCredentialsChanged(agentDir, {
        profileIds: ["provider-b:default"],
      });

      expect(
        restoreSecretsRuntimeSnapshotStateIfCurrent({
          snapshot: previous,
          expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
          ownedSnapshot: candidate,
          refreshContext: null,
          refreshHandler: null,
        }),
      ).toBe(true);
      const restored = getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles;
      if (expectedAKey === null) {
        expect(restored?.["provider-a:default"]).toBeUndefined();
      } else {
        expect(restored?.["provider-a:default"]).toMatchObject({ key: expectedAKey });
      }
      expect(restored?.["provider-b:default"]).toMatchObject({ key: "b-external" });
    },
  );

  it.each([
    { label: "candidate-owned omission", mutationOwner: "none", profileId: "" },
    {
      label: "persisted external removal",
      mutationOwner: "custom",
      profileId: "openai:default",
    },
    { label: "unrelated main-store write", mutationOwner: "main", profileId: "anthropic:main" },
    { label: "related main-store write", mutationOwner: "main", profileId: "openai:default" },
  ] as const)(
    "handles whole-store $label after candidate omission",
    ({ label, mutationOwner, profileId }) => {
      const agentDir = `/tmp/openclaw-auth-store-removal-${label}`;
      const snapshot = (includeStore: boolean, port: number): PreparedSecretsRuntimeSnapshot => ({
        sourceConfig: {},
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
                },
              },
            ]
          : [],
        authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
        warnings: [],
        webTools: {
          search: { providerSource: "none", diagnostics: [] },
          fetch: { providerSource: "none", diagnostics: [] },
          diagnostics: [],
        },
      });
      activateSecretsRuntimeSnapshotState({
        snapshot: snapshot(true, 19_001),
        refreshContext: null,
        refreshHandler: null,
      });
      const previous = getActiveSecretsRuntimeSnapshot()!;
      const candidate = snapshot(false, 19_002);
      expect(
        activateSecretsRuntimeSnapshotStateIfCurrent({
          snapshot: candidate,
          expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
          refreshContext: null,
          refreshHandler: null,
        }),
      ).toBe(true);
      if (mutationOwner !== "none") {
        noteRuntimeAuthProfileStoreCredentialsChanged(
          mutationOwner === "custom" ? agentDir : undefined,
          {
            profileIds: [profileId],
          },
        );
      }

      expect(
        restoreSecretsRuntimeSnapshotStateIfCurrent({
          snapshot: previous,
          expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
          ownedSnapshot: candidate,
          refreshContext: null,
          refreshHandler: null,
        }),
      ).toBe(true);
      if (
        mutationOwner === "custom" ||
        (mutationOwner === "main" && profileId === "openai:default")
      ) {
        expect(getRuntimeAuthProfileStoreSnapshot(agentDir)).toBeUndefined();
      } else {
        expect(
          getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles["openai:default"],
        ).toMatchObject({ key: "sk-old" });
      }
    },
  );

  it("does not resurrect an auth store cleared after candidate activation", () => {
    const agentDir = "/tmp/openclaw-auth-post-activation-clear";
    const snapshot = (key: string, port: number): PreparedSecretsRuntimeSnapshot => ({
      sourceConfig: {},
      config: { gateway: { port } },
      authStores: [
        {
          agentDir,
          store: {
            version: 1,
            profiles: {
              "openai:default": { type: "api_key", provider: "openai", key },
            },
          },
        },
      ],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [],
      webTools: {
        search: { providerSource: "none", diagnostics: [] },
        fetch: { providerSource: "none", diagnostics: [] },
        diagnostics: [],
      },
    });
    activateSecretsRuntimeSnapshotState({
      snapshot: snapshot("sk-old", 19_001),
      refreshContext: null,
      refreshHandler: null,
    });
    const previous = getActiveSecretsRuntimeSnapshot()!;
    const candidate = snapshot("sk-candidate", 19_002);
    expect(
      activateSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: candidate,
        expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    clearRuntimeAuthProfileStoreSnapshots();

    expect(
      restoreSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: previous,
        expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
        ownedSnapshot: candidate,
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    expect(getRuntimeAuthProfileStoreSnapshot(agentDir)).toBeUndefined();
  });

  it.each([
    { label: "retains a resolved value for the same auth-store SecretRef", changedRef: false },
    { label: "restores the predecessor when the auth-store SecretRef changed", changedRef: true },
  ])("$label", ({ changedRef }) => {
    const agentDir = `/tmp/openclaw-auth-ref-rollback-${changedRef}`;
    const previousRef = {
      source: "env" as const,
      provider: "default",
      id: "OPENAI_API_KEY",
    };
    const candidateRef = changedRef ? { ...previousRef, id: "OPENAI_API_KEY_NEXT" } : previousRef;
    const snapshot = (
      key: string,
      keyRef: typeof previousRef,
      port: number,
    ): PreparedSecretsRuntimeSnapshot => ({
      sourceConfig: {},
      config: { gateway: { port } },
      authStores: [
        {
          agentDir,
          store: {
            version: 1,
            profiles: {
              "openai:default": { type: "api_key", provider: "openai", key, keyRef },
            },
          },
        },
      ],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [],
      webTools: {
        search: { providerSource: "none", diagnostics: [] },
        fetch: { providerSource: "none", diagnostics: [] },
        diagnostics: [],
      },
    });
    activateSecretsRuntimeSnapshotState({
      snapshot: snapshot("sk-old", previousRef, 19_001),
      refreshContext: null,
      refreshHandler: null,
    });
    const previous = getActiveSecretsRuntimeSnapshot()!;
    const candidate = snapshot("sk-candidate", candidateRef, 19_002);
    expect(
      activateSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: candidate,
        expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    const candidateRevision = getActiveSecretsRuntimeSnapshotRevision();
    expect(
      activateSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: snapshot("sk-refreshed", candidateRef, 19_002),
        expectedRevision: candidateRevision,
        refreshContext: null,
        refreshHandler: null,
        preserveActivationLineage: true,
      }),
    ).toBe(true);

    expect(
      restoreSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: previous,
        expectedRevision: candidateRevision,
        ownedSnapshot: candidate,
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    expect(getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles["openai:default"]).toMatchObject({
      key: changedRef ? "sk-old" : "sk-refreshed",
      keyRef: changedRef ? previousRef : candidateRef,
    });
  });

  it("preserves live credentials when the captured predecessor is stale", () => {
    const agentDir = "/tmp/openclaw-auth-stale-predecessor-rollback";
    const snapshot = (key: string, port: number): PreparedSecretsRuntimeSnapshot => ({
      sourceConfig: {},
      config: { gateway: { port } },
      authStores: [
        {
          agentDir,
          store: {
            version: 1,
            profiles: {
              "openai:default": { type: "api_key", provider: "openai", key },
            },
          },
        },
      ],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [],
      webTools: {
        search: { providerSource: "none", diagnostics: [] },
        fetch: { providerSource: "none", diagnostics: [] },
        diagnostics: [],
      },
    });
    activateSecretsRuntimeSnapshotState({
      snapshot: snapshot("sk-old", 19_011),
      refreshContext: null,
      refreshHandler: null,
    });
    setRuntimeAuthProfileStoreSnapshot(
      {
        version: 1,
        profiles: {
          "openai:default": { type: "api_key", provider: "openai", key: "sk-live" },
        },
      },
      agentDir,
    );
    const previous = getActiveSecretsRuntimeSnapshot();
    const previousRevision = getActiveSecretsRuntimeSnapshotRevision();
    const candidate = snapshot("sk-live", 19_012);
    expect(previous).not.toBeNull();
    expect(
      activateSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: candidate,
        expectedRevision: previousRevision,
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);

    expect(
      restoreSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: previous!,
        expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
        ownedSnapshot: candidate,
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    expect(getActiveSecretsRuntimeSnapshot()?.config.gateway?.port).toBe(19_011);
    expect(getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles["openai:default"]).toMatchObject({
      key: "sk-live",
    });
  });

  it.each([
    {
      label: "retains a provider-auth descendant for the same SecretRef",
      candidateRefId: "OPENAI_API_KEY",
      expectedKey: "sk-refreshed",
    },
    {
      label: "retains a provider-auth descendant for matching env shorthand",
      candidateRefId: "OPENAI_API_KEY",
      expectedKey: "sk-refreshed",
      shorthand: true,
    },
    {
      label: "restores the predecessor value when the candidate changed its SecretRef",
      candidateRefId: "OPENAI_API_KEY_NEXT",
      expectedKey: "sk-old",
    },
  ])("$label", ({ candidateRefId, expectedKey, shorthand }) => {
    const previousKeyRef = {
      source: "env" as const,
      provider: "default",
      id: "OPENAI_API_KEY",
    };
    const previousKeyInput = shorthand ? "$OPENAI_API_KEY" : previousKeyRef;
    const candidateKeyInput = shorthand
      ? `$${candidateRefId}`
      : { ...previousKeyRef, id: candidateRefId };
    const snapshot = (params: {
      sourcePort: number;
      runtimePort: number;
      apiKey: string;
      keyRef: string | typeof previousKeyRef;
    }): PreparedSecretsRuntimeSnapshot => ({
      sourceConfig: {
        gateway: { port: params.sourcePort },
        models: { providers: { openai: { apiKey: params.keyRef, models: [] } } },
      },
      config: {
        gateway: { port: params.runtimePort },
        models: {
          providers: {
            openai: { apiKey: params.apiKey, models: [] },
          },
        },
      },
      authStores: [],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [],
      webTools: {
        search: { providerSource: "none", diagnostics: [] },
        fetch: { providerSource: "none", diagnostics: [] },
        diagnostics: [],
      },
    });
    activateSecretsRuntimeSnapshotState({
      snapshot: snapshot({
        sourcePort: 19_021,
        runtimePort: 19_021,
        apiKey: "sk-old",
        keyRef: previousKeyInput,
      }),
      refreshContext: null,
      refreshHandler: null,
    });
    const previous = getActiveSecretsRuntimeSnapshot()!;
    const candidate = snapshot({
      sourcePort: 19_022,
      runtimePort: 19_022,
      apiKey: "sk-candidate",
      keyRef: candidateKeyInput,
    });
    expect(
      activateSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: candidate,
        expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    const candidateRevision = getActiveSecretsRuntimeSnapshotRevision();
    const providerRefresh = snapshot({
      sourcePort: 19_022,
      runtimePort: 19_022,
      apiKey: "sk-refreshed",
      keyRef: candidateKeyInput,
    });
    expect(
      activateSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: providerRefresh,
        expectedRevision: candidateRevision,
        refreshContext: null,
        refreshHandler: null,
        preserveActivationLineage: true,
      }),
    ).toBe(true);

    expect(
      restoreSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: previous,
        ownedSnapshot: candidate,
        expectedRevision: candidateRevision,
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    expect(getActiveSecretsRuntimeSnapshot()?.config.gateway?.port).toBe(19_021);
    expect(getActiveSecretsRuntimeSnapshot()?.config.models?.providers?.openai?.apiKey).toBe(
      expectedKey,
    );
  });

  it.each([
    {
      label: "provider definition",
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
  ])(
    "restores resolved values when a same-ref $label was rejected",
    ({ keyRef, previousSourceConfig, candidateSourceConfig }) => {
      const agentDir = `/tmp/openclaw-auth-provider-dependency-${keyRef.provider}`;
      const snapshot = (params: {
        sourceConfig: OpenClawConfig;
        apiKey: string;
        port: number;
      }): PreparedSecretsRuntimeSnapshot => ({
        sourceConfig: {
          ...params.sourceConfig,
          gateway: { port: params.port },
          models: { providers: { openai: { apiKey: keyRef, models: [] } } },
        },
        config: {
          ...params.sourceConfig,
          gateway: { port: params.port },
          models: { providers: { openai: { apiKey: params.apiKey, models: [] } } },
        },
        authStores: [
          {
            agentDir,
            store: {
              version: 1,
              profiles: {
                "openai:default": {
                  type: "api_key",
                  provider: "openai",
                  keyRef,
                  key: params.apiKey,
                },
              },
            },
          },
        ],
        authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
        warnings: [],
        webTools: {
          search: { providerSource: "none", diagnostics: [] },
          fetch: { providerSource: "none", diagnostics: [] },
          diagnostics: [],
        },
      });
      activateSecretsRuntimeSnapshotState({
        snapshot: snapshot({ sourceConfig: previousSourceConfig, apiKey: "sk-old", port: 19_031 }),
        refreshContext: null,
        refreshHandler: null,
      });
      const previous = getActiveSecretsRuntimeSnapshot()!;
      const candidate = snapshot({
        sourceConfig: candidateSourceConfig,
        apiKey: "sk-candidate",
        port: 19_032,
      });
      expect(
        activateSecretsRuntimeSnapshotStateIfCurrent({
          snapshot: candidate,
          expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
          refreshContext: null,
          refreshHandler: null,
        }),
      ).toBe(true);
      const candidateRevision = getActiveSecretsRuntimeSnapshotRevision();
      expect(
        activateSecretsRuntimeSnapshotStateIfCurrent({
          snapshot: snapshot({
            sourceConfig: candidateSourceConfig,
            apiKey: "sk-refreshed",
            port: 19_032,
          }),
          expectedRevision: candidateRevision,
          refreshContext: null,
          refreshHandler: null,
          preserveActivationLineage: true,
        }),
      ).toBe(true);

      expect(
        restoreSecretsRuntimeSnapshotStateIfCurrent({
          snapshot: previous,
          ownedSnapshot: candidate,
          expectedRevision: candidateRevision,
          refreshContext: null,
          refreshHandler: null,
        }),
      ).toBe(true);
      const restored = getActiveSecretsRuntimeSnapshot();
      expect(restored?.sourceConfig).toMatchObject(previousSourceConfig);
      expect(restored?.config.models?.providers?.openai?.apiKey).toBe("sk-old");
      expect(
        getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles["openai:default"],
      ).toMatchObject({
        key: "sk-old",
        keyRef,
      });
    },
  );
});
