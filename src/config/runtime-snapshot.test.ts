// Verifies runtime config snapshots preserve normalized public settings.
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import {
  cloneConfigWithResolutionFacts,
  createConfigResolutionFacts,
  getAuthoredConfigSecretRef,
  getConfigResolutionFacts,
  setConfigResolutionFacts,
} from "./resolution-facts.js";
import {
  createRuntimeConfigReader,
  finalizeRuntimeSnapshotWrite,
  getRuntimeConfigAppliedHash,
  hashRuntimeConfigValue,
  hasManagedRuntimeConfigWriteOwner,
  getRuntimeConfigSnapshotMetadata,
  getRuntimeConfigSourceSnapshot,
  getRuntimeConfigSnapshot,
  preflightManagedRuntimeConfigWrite,
  loadPinnedRuntimeConfig,
  registerManagedRuntimeConfigWriteOwner,
  resetConfigRuntimeState,
  resolveRuntimeConfigCacheKey,
  selectApplicableRuntimeConfig,
  setRuntimeConfigSnapshot,
  setRuntimeConfigAppliedHash,
  setRuntimeConfigSourceSnapshotIfCurrent,
  setRuntimeConfigSnapshotRefreshHandler,
} from "./runtime-snapshot.js";
import { createProviderConfigFixture } from "./runtime-snapshot.test-fixtures.js";
import { captureRuntimeConfig } from "./runtime-source-projection.js";
import type { OpenClawConfig } from "./types.js";

function resetRuntimeConfigState(): void {
  setRuntimeConfigSnapshotRefreshHandler(null);
  resetConfigRuntimeState();
}

describe("runtime snapshot state", () => {
  afterEach(() => {
    resetRuntimeConfigState();
  });

  it.each<[string, OpenClawConfig, string]>([
    [
      "sidebar preferences",
      { ui: { prefs: { sidebarEntries: ["sessions"] } } },
      "config-presentation",
    ],
    ["logging", { logging: { level: "debug" } }, "config-presentation"],
    [
      "identity scopes",
      { gateway: { auth: { identityScopes: { "reader@example.test": ["operator.read"] } } } },
      "config-presentation",
    ],
    [
      "agent identity",
      { agents: { entries: { main: { identity: { name: "Renamed" } } } } },
      "config-profiles",
    ],
    ["agent addition", { agents: { entries: { main: {}, other: {} } } }, "config"],
    ["agent removal", { agents: { entries: {} } }, "config"],
    [
      "model defaults",
      { agents: { entries: { main: {} }, defaults: { model: "unit-test/changed" } } },
      "config",
    ],
    ["catalog", { models: { mode: "replace", providers: {} } }, "config"],
    ["session policy", { session: { scope: "global" } }, "config"],
    ["store topology", { session: { store: "/tmp/synthetic-session-store.sqlite" } }, "config"],
    ["visibility", { tools: { sessions: { visibility: "all" } } }, "config"],
    ["avatar route", { gateway: { controlUi: { basePath: "/changed" } } }, "config"],
  ])("publishes the projection impact of %s", (_label, change, scope) => {
    const initial: OpenClawConfig = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(initial);
    const published = vi.fn();
    const stop = sessionChanges.subscribe(published);
    try {
      setRuntimeConfigSnapshot({ ...initial, ...change });
      expect(published).toHaveBeenCalledExactlyOnceWith({ all: true, scope });
    } finally {
      stop();
    }
  });

  it("pins the first successful load in memory until the snapshot is cleared", () => {
    let freshPort = 18789;
    let loadCount = 0;
    const loadFresh = (): OpenClawConfig => {
      loadCount += 1;
      return { gateway: { port: freshPort } };
    };

    expect(loadPinnedRuntimeConfig(loadFresh).gateway?.port).toBe(18789);
    expect(loadCount).toBe(1);

    freshPort = 19001;
    expect(loadPinnedRuntimeConfig(loadFresh).gateway?.port).toBe(18789);
    expect(loadCount).toBe(1);

    resetRuntimeConfigState();
    expect(loadPinnedRuntimeConfig(loadFresh).gateway?.port).toBe(19001);
    expect(loadCount).toBe(2);
  });

  it("publishes and replaces same-byte resolution facts with the source snapshot", () => {
    const runtimeConfig: OpenClawConfig = {
      gateway: { auth: { mode: "token", token: "${GATEWAY_TOKEN}" } },
    };
    const unresolvedSource = structuredClone(runtimeConfig);
    setConfigResolutionFacts(
      unresolvedSource,
      createConfigResolutionFacts(
        [{ configPath: "gateway.auth.token", varName: "GATEWAY_TOKEN" }],
        new Map([["gateway.auth.token", "GATEWAY_TOKEN"]]),
      ),
    );
    setRuntimeConfigSnapshot(runtimeConfig, unresolvedSource);
    expect([...(getConfigResolutionFacts(getRuntimeConfigSnapshot()) ?? [])]).toEqual([
      "gateway.auth.token",
    ]);
    expect(getAuthoredConfigSecretRef(getRuntimeConfigSnapshot(), "gateway.auth.token")?.id).toBe(
      "GATEWAY_TOKEN",
    );

    const literalSource = structuredClone(runtimeConfig);
    setConfigResolutionFacts(literalSource, createConfigResolutionFacts([]));
    expect(
      setRuntimeConfigSourceSnapshotIfCurrent({
        expectedRevision: getRuntimeConfigSnapshotMetadata()?.revision ?? -1,
        sourceConfig: literalSource,
      }),
    ).toBe(true);
    expect(getConfigResolutionFacts(getRuntimeConfigSnapshot())?.size).toBe(0);
    expect(getAuthoredConfigSecretRef(getRuntimeConfigSnapshot(), "gateway.auth.token")).toBeNull();
  });

  it("tracks snapshot metadata and cache keys across runtime refreshes", () => {
    const firstConfig: OpenClawConfig = { gateway: { port: 18789 } };
    const secondConfig: OpenClawConfig = { gateway: { port: 19001 } };

    setRuntimeConfigSnapshot(firstConfig);
    const firstMetadata = getRuntimeConfigSnapshotMetadata();
    expect(firstMetadata?.revision).toBe(1);
    expect(resolveRuntimeConfigCacheKey(firstConfig)).toBe(
      `runtime:${firstMetadata?.revision}:${firstMetadata?.fingerprint}`,
    );

    setRuntimeConfigSnapshot(secondConfig);
    const secondMetadata = getRuntimeConfigSnapshotMetadata();
    expect(secondMetadata?.revision).toBe(2);
    expect(secondMetadata?.fingerprint).not.toBe(firstMetadata?.fingerprint);
    expect(resolveRuntimeConfigCacheKey(secondConfig)).toBe(
      `runtime:${secondMetadata?.revision}:${secondMetadata?.fingerprint}`,
    );
  });

  it("tracks the applied source revision independently from runtime fingerprints", () => {
    expect(getRuntimeConfigAppliedHash()).toBeNull();

    setRuntimeConfigAppliedHash("disk-hash-1");
    setRuntimeConfigSnapshot({ gateway: { port: 18789 } });
    expect(getRuntimeConfigAppliedHash()).toBe("disk-hash-1");

    resetConfigRuntimeState();
    expect(getRuntimeConfigAppliedHash()).toBeNull();
  });

  it("hashes resolved source content independently from root-file revision metadata", () => {
    const first = hashRuntimeConfigValue({ logging: { level: "info" } });
    const second = hashRuntimeConfigValue({ logging: { level: "debug" } });

    expect(first).not.toBe(second);
    expect(hashRuntimeConfigValue({ logging: { level: "info" } })).toBe(first);
  });

  it.each([false, true])("hashes one immutable fleet only once (captured: %s)", (captured) => {
    const source = {
      agents: {
        entries: Object.fromEntries(
          Array.from({ length: 200 }, (_, index) => [`agent-${index}`, { name: `${index}` }]),
        ),
      },
    };
    const keys = vi.spyOn(Object, "keys");
    try {
      const config = captured ? captureRuntimeConfig(source) : freezeJsonSnapshot(source);
      const first = hashRuntimeConfigValue(config);
      for (let index = 0; index < 200; index += 1) {
        expect(hashRuntimeConfigValue(config)).toBe(first);
      }
      expect(keys.mock.calls.filter(([value]) => value === config.agents?.entries)).toHaveLength(1);
    } finally {
      keys.mockRestore();
    }
  });

  it("rehashes mutable descendants of a shallow-frozen config", () => {
    const config = Object.freeze({ gateway: { port: 18789 } });
    const before = hashRuntimeConfigValue(config);
    config.gateway.port = 19001;
    expect(hashRuntimeConfigValue(config)).not.toBe(before);
    expect(hashRuntimeConfigValue(config)).toBe(
      hashRuntimeConfigValue({ gateway: { port: 19001 } }),
    );
  });

  it.each([false, true])(
    "selects and retains only matching runtime sources (resolution facts: %s)",
    (withFacts) => {
      const sourceConfig = createProviderConfigFixture();
      if (withFacts) {
        setConfigResolutionFacts(sourceConfig, createConfigResolutionFacts([]));
      }
      const runtimeConfig = createProviderConfigFixture("sk-runtime-resolved");
      const scopedResolvedConfig: OpenClawConfig = {
        ...runtimeConfig,
        tools: {
          updatePlan: true,
        },
      };

      const readUnbound = createRuntimeConfigReader(scopedResolvedConfig);

      expect(
        selectApplicableRuntimeConfig({
          inputConfig: cloneConfigWithResolutionFacts(sourceConfig),
          runtimeConfig,
          runtimeSourceConfig: sourceConfig,
        }),
      ).toBe(runtimeConfig);
      expect(
        selectApplicableRuntimeConfig({
          inputConfig: scopedResolvedConfig,
          runtimeConfig,
          runtimeSourceConfig: sourceConfig,
        }),
      ).toBe(scopedResolvedConfig);
      const foreignConfig = cloneConfigWithResolutionFacts(sourceConfig);
      setConfigResolutionFacts(
        foreignConfig,
        createConfigResolutionFacts(
          [],
          new Map([["models.providers.openai.apiKey", "OTHER_PROVIDER_KEY"]]),
        ),
      );
      expect(
        selectApplicableRuntimeConfig({
          inputConfig: foreignConfig,
          runtimeConfig,
          runtimeSourceConfig: sourceConfig,
        }),
      ).toBe(foreignConfig);
      setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
      const readRuntime = createRuntimeConfigReader(cloneConfigWithResolutionFacts(sourceConfig));
      const readScoped = createRuntimeConfigReader(scopedResolvedConfig);
      const readForeign = createRuntimeConfigReader(foreignConfig);
      const nextConfig = { ...runtimeConfig, messages: { ackReactionScope: "all" as const } };
      setRuntimeConfigSnapshot(nextConfig, nextConfig);
      expect(readRuntime()).toBe(nextConfig);
      expect(readScoped()).toBe(scopedResolvedConfig);
      expect(readForeign()).toBe(foreignConfig);
      expect(readUnbound()).toBe(scopedResolvedConfig);
    },
  );

  it("does not replace explicit config with a pinned snapshot without a source contract", () => {
    const sourceConfig = createProviderConfigFixture();
    const resolvedConfig = createProviderConfigFixture("synthetic-resolved-key");
    const pinned = loadPinnedRuntimeConfig(() => sourceConfig);
    expect(getRuntimeConfigSourceSnapshot()).toBeNull();

    expect(
      selectApplicableRuntimeConfig({ inputConfig: resolvedConfig, runtimeConfig: pinned }),
    ).toBe(resolvedConfig);
    expect(
      selectApplicableRuntimeConfig({ inputConfig: sourceConfig, runtimeConfig: pinned }),
    ).toBe(sourceConfig);
    expect(selectApplicableRuntimeConfig({ runtimeConfig: pinned })).toBe(pinned);

    // A resolved but unrelated singleton cannot supply credentials for an explicit source either.
    setRuntimeConfigSnapshot(resolvedConfig);
    expect(
      selectApplicableRuntimeConfig({
        inputConfig: sourceConfig,
        runtimeConfig: getRuntimeConfigSnapshot(),
      }),
    ).toBe(sourceConfig);
  });

  it("matches independently loaded config with equivalent resolution facts", () => {
    const source = createProviderConfigFixture();
    const freshRead = structuredClone(source);
    const facts = () =>
      createConfigResolutionFacts(
        [],
        new Map([["models.providers.openai.apiKey", "PROVIDER_KEY"]]),
      );
    setConfigResolutionFacts(source, facts());
    setConfigResolutionFacts(freshRead, facts());
    const runtime = createProviderConfigFixture("synthetic-runtime-key");
    setRuntimeConfigSnapshot(runtime, source);

    expect(getConfigResolutionFacts(freshRead)).not.toBe(getConfigResolutionFacts(source));
    expect(createRuntimeConfigReader(freshRead)()).toBe(runtime);
  });

  it.each(["absent", "empty", "different-ref", "different-provider", "resolved", "unresolved"])(
    "does not reuse runtime for same-byte config with %s resolution facts",
    (kind) => {
      const source = createProviderConfigFixture();
      const input = structuredClone(source);
      const refs = new Map([["models.providers.openai.apiKey", "PROVIDER_KEY"]]);
      setConfigResolutionFacts(source, createConfigResolutionFacts([], refs));
      if (kind !== "absent") {
        setConfigResolutionFacts(
          input,
          createConfigResolutionFacts(
            kind === "unresolved"
              ? [{ configPath: "models.providers.openai.apiKey", varName: "PROVIDER_KEY" }]
              : [],
            kind === "resolved" || kind === "empty"
              ? new Map()
              : kind === "different-ref"
                ? new Map([["models.providers.openai.apiKey", "OTHER_KEY"]])
                : refs,
            kind === "different-provider" ? "other" : "default",
            kind === "resolved" ? refs : new Map(),
          ),
        );
      }
      setRuntimeConfigSnapshot(createProviderConfigFixture("synthetic-runtime-key"), source);
      expect(createRuntimeConfigReader(input)()).toBe(input);
    },
  );

  it("clears runtime source snapshot when runtime snapshot is cleared", () => {
    setRuntimeConfigSnapshot({ gateway: { port: 18789 } }, { gateway: { port: 18789 } });
    resetRuntimeConfigState();
    expect(getRuntimeConfigSnapshot()).toBeNull();
    expect(getRuntimeConfigSourceSnapshot()).toBeNull();
    expect(getRuntimeConfigSnapshotMetadata()).toBeNull();
  });

  it("refreshes both snapshots from disk after a write when source + runtime snapshots exist", async () => {
    const notifyCommittedWrite = vi.fn();
    const loadFreshConfig = vi.fn<() => Promise<{ config: OpenClawConfig }>>(async () => ({
      config: { gateway: { auth: { mode: "token" } } },
    }));
    const nextSourceConfig: OpenClawConfig = {
      gateway: { auth: { mode: "token" } },
      ...createProviderConfigFixture(),
    };

    setRuntimeConfigSnapshot(createProviderConfigFixture("sk-runtime-resolved"), nextSourceConfig);

    await finalizeRuntimeSnapshotWrite({
      nextSourceConfig,
      hadBothSnapshots: true,
      freshConfig: loadFreshConfig,
      notifyCommittedWrite,
      formatRefreshError: (error) => String(error),
      createRefreshError: (detail, cause) => new Error(detail, { cause }),
    });

    expect(loadFreshConfig).toHaveBeenCalledTimes(1);
    expect(getRuntimeConfigSnapshot()).toEqual({ gateway: { auth: { mode: "token" } } });
    expect(getRuntimeConfigSourceSnapshot()).toEqual(nextSourceConfig);
    expect(notifyCommittedWrite).toHaveBeenCalledTimes(1);
  });

  it("refreshes a plain runtime snapshot after writes without restoring a source snapshot", async () => {
    const notifyCommittedWrite = vi.fn();
    const loadFreshConfig = vi.fn(async () => ({ config: { gateway: { port: 19002 } } }));

    setRuntimeConfigSnapshot({ gateway: { port: 18789 } });

    await finalizeRuntimeSnapshotWrite({
      nextSourceConfig: { gateway: { port: 19002 } },
      hadBothSnapshots: false,
      freshConfig: loadFreshConfig,
      notifyCommittedWrite,
      formatRefreshError: (error) => String(error),
      createRefreshError: (detail, cause) => new Error(detail, { cause }),
    });

    expect(loadFreshConfig).toHaveBeenCalledTimes(1);
    expect(getRuntimeConfigSnapshot()).toEqual({ gateway: { port: 19002 } });
    expect(getRuntimeConfigSourceSnapshot()).toBeNull();
    expect(notifyCommittedWrite).toHaveBeenCalledTimes(1);
  });

  it("keeps the last-known-good runtime snapshot active while specialized refresh is pending", async () => {
    const notifyCommittedWrite = vi.fn();
    const loadFreshConfig = vi.fn<() => Promise<{ config: OpenClawConfig }>>(async () => ({
      config: { gateway: { auth: { mode: "token" } } },
    }));
    let releaseRefresh: (() => void) | undefined;
    const refreshPending = new Promise<boolean>((resolve) => {
      releaseRefresh = () => resolve(true);
    });

    setRuntimeConfigSnapshot(
      createProviderConfigFixture("sk-runtime-resolved"),
      createProviderConfigFixture(),
    );
    setRuntimeConfigSnapshotRefreshHandler({
      refresh: async ({ sourceConfig }) => {
        expect(sourceConfig.gateway?.auth).toEqual({ mode: "token" });
        expect(getRuntimeConfigSnapshot()?.gateway?.auth).toBeUndefined();
        const handled = await refreshPending;
        if (handled) {
          setRuntimeConfigSnapshot(sourceConfig, sourceConfig);
        }
        return handled;
      },
    });

    const writePromise = finalizeRuntimeSnapshotWrite({
      nextSourceConfig: {
        gateway: { auth: { mode: "token" } },
        ...createProviderConfigFixture(),
      },
      hadBothSnapshots: true,
      freshConfig: loadFreshConfig,
      notifyCommittedWrite,
      formatRefreshError: (error) => String(error),
      createRefreshError: (detail, cause) => new Error(detail, { cause }),
    });

    await Promise.resolve();
    expect(getRuntimeConfigSnapshot()?.gateway?.auth).toBeUndefined();
    expect(loadFreshConfig).not.toHaveBeenCalled();

    if (!releaseRefresh) {
      throw new Error("Expected runtime snapshot refresh release callback to be initialized");
    }
    releaseRefresh();
    await writePromise;

    expect(notifyCommittedWrite).toHaveBeenCalledTimes(1);
    expect(getRuntimeConfigSnapshot()?.gateway?.auth).toEqual({ mode: "token" });
  });

  it.each(["reload", "declined refresh"] as const)(
    "fences a pending %s without a caller-supplied authority guard",
    async (phase) => {
      const initial: OpenClawConfig = { gateway: { port: 18789 } };
      const replacement: OpenClawConfig = { gateway: { port: 19002 } };
      const candidate: OpenClawConfig = { gateway: { port: 19001 } };
      setRuntimeConfigSnapshot(initial, initial);
      const release = createDeferredCore();
      if (phase === "declined refresh") {
        setRuntimeConfigSnapshotRefreshHandler({
          refresh: () => release.promise.then(() => false),
        });
      }
      const notifyCommittedWrite = vi.fn();
      const pending = finalizeRuntimeSnapshotWrite({
        nextSourceConfig: candidate,
        hadBothSnapshots: true,
        freshConfig: () =>
          phase === "reload"
            ? release.promise.then(() => ({ config: candidate }))
            : Promise.resolve({ config: candidate }),
        notifyCommittedWrite,
        formatRefreshError: String,
        createRefreshError: (detail, cause) => new Error(detail, { cause }),
      });
      try {
        expect(getRuntimeConfigSnapshot()).toBe(initial);
        setRuntimeConfigSnapshot(replacement, replacement);
        const rejected = expect(pending).rejects.toThrow("superseded");
        release.resolve();
        await rejected;
        expect(getRuntimeConfigSnapshot()).toBe(replacement);
        expect(getRuntimeConfigSourceSnapshot()).toBe(replacement);
        expect(notifyCommittedWrite).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await pending.catch(() => {});
      }
    },
  );

  it("scopes managed write ownership by path and reference count", () => {
    const releaseA = registerManagedRuntimeConfigWriteOwner("/tmp/a.json");
    const releaseA2 = registerManagedRuntimeConfigWriteOwner("/tmp/a.json");
    const releaseB = registerManagedRuntimeConfigWriteOwner("/tmp/b.json");

    expect(hasManagedRuntimeConfigWriteOwner("/tmp/a.json")).toBe(true);
    expect(hasManagedRuntimeConfigWriteOwner("/tmp/b.json")).toBe(true);
    releaseA();
    expect(hasManagedRuntimeConfigWriteOwner("/tmp/a.json")).toBe(true);
    releaseA2();
    releaseA2();
    expect(hasManagedRuntimeConfigWriteOwner("/tmp/a.json")).toBe(false);
    expect(hasManagedRuntimeConfigWriteOwner("/tmp/b.json")).toBe(true);
    releaseB();
  });

  it("keeps prepared candidates scoped to each managed owner", async () => {
    const runtimeConfigA: OpenClawConfig = { gateway: { port: 19001 } };
    const runtimeConfigB: OpenClawConfig = { gateway: { port: 19002 } };
    const candidateA = { runtimeConfig: runtimeConfigA, compareConfig: {} };
    const candidateB = { runtimeConfig: runtimeConfigB, compareConfig: {} };
    const releaseA = registerManagedRuntimeConfigWriteOwner(
      "/tmp/scoped.json",
      async () => candidateA,
    );
    const releaseB = registerManagedRuntimeConfigWriteOwner(
      "/tmp/scoped.json",
      async () => candidateB,
    );

    try {
      const prepared = await preflightManagedRuntimeConfigWrite("/tmp/scoped.json", {});
      expect(prepared.get(releaseA.ownerId)).toBe(candidateA);
      expect(prepared.get(releaseB.ownerId)).toBe(candidateB);
    } finally {
      releaseA();
      releaseB();
    }
  });

  it("defers raw runtime activation to a managed write owner", async () => {
    const activeConfig: OpenClawConfig = { gateway: { port: 18789 } };
    setRuntimeConfigSnapshot(activeConfig);
    const notifyCommittedWrite = vi.fn();
    const refresh = vi.fn(async () => true);
    const loadFreshConfig = vi.fn(async () => ({ config: { gateway: { port: 19001 } } }));
    setRuntimeConfigSnapshotRefreshHandler({ refresh });

    await finalizeRuntimeSnapshotWrite({
      nextSourceConfig: { gateway: { port: 19001 } },
      hadBothSnapshots: false,
      freshConfig: loadFreshConfig,
      notifyCommittedWrite,
      deferRuntimeActivation: true,
      formatRefreshError: (error) => String(error),
      createRefreshError: (detail, cause) => new Error(detail, { cause }),
    });

    expect(getRuntimeConfigSnapshot()).toBe(activeConfig);
    expect(refresh).not.toHaveBeenCalled();
    expect(loadFreshConfig).not.toHaveBeenCalled();
    expect(notifyCommittedWrite).toHaveBeenCalledOnce();
  });
});
