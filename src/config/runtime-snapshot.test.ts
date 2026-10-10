import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  applyConfigEnvVars,
  collectConfigRuntimeEnvOwnership,
  getPublishedConfigRuntimeEnvState,
  initializePublishedConfigRuntimeEnv,
  prepareConfigRuntimeEnv,
} from "./config-env-vars.js";
import {
  cloneConfigWithResolutionFacts,
  createConfigResolutionFacts,
  getAuthoredConfigSecretRef,
  getConfigResolutionFacts,
  setConfigResolutionFacts,
} from "./resolution-facts.js";
import {
  clearRuntimeConfigSnapshot,
  createRuntimeConfigReader,
  loadPinnedRuntimeConfigAsync,
  registerRuntimeConfigSnapshotPreparer,
  type RuntimeConfigSnapshotPreparationContext,
  setAppliedRuntimeConfigSnapshot,
  finalizeRuntimeSnapshotWrite,
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
  setRuntimeConfigSourceSnapshotIfCurrent,
  setRuntimeConfigSnapshotRefreshHandler,
} from "./runtime-snapshot.js";
import { createProviderConfigFixture } from "./runtime-snapshot.test-fixtures.js";
import {
  captureRuntimeConfig,
  projectConfigOntoRuntimeSourceSnapshot,
} from "./runtime-source-projection.js";
import type { OpenClawConfig } from "./types.js";

function resetRuntimeConfigState(): void {
  setRuntimeConfigSnapshotRefreshHandler(null);
  resetConfigRuntimeState();
}

const unregister: Array<() => void> = [];

afterEach(() => {
  unregister.splice(0).forEach((release) => release());
  resetRuntimeConfigState();
  vi.unstubAllEnvs();
});

describe("runtime snapshot state", () => {
  it.each<[string, OpenClawConfig, string]>([
    [
      "sidebar preferences",
      { ui: { prefs: { sidebarEntries: ["sessions"] } } },
      "config-presentation",
    ],
    [
      "agent identity",
      { agents: { entries: { main: { identity: { name: "Renamed" } } } } },
      "config-profiles",
    ],
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

  it("hashes one captured immutable fleet only once", () => {
    const source = {
      agents: {
        entries: Object.fromEntries(
          Array.from({ length: 200 }, (_, index) => [`agent-${index}`, { name: `${index}` }]),
        ),
      },
    };
    const keys = vi.spyOn(Object, "keys");
    try {
      const config = captureRuntimeConfig(source);
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

  it("selects and retains only matching runtime sources", () => {
    const sourceConfig = createProviderConfigFixture();
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
  });

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

function gatedPreparer() {
  const started = createDeferredCore();
  const deferred = createDeferredCore<() => void>();
  const syncPrepare = vi.fn();
  const prepareAsync = vi.fn(
    (_config: OpenClawConfig, _context: RuntimeConfigSnapshotPreparationContext) => {
      started.resolve();
      return deferred.promise;
    },
  );
  const release = registerRuntimeConfigSnapshotPreparer(syncPrepare, { prepareAsync });
  unregister.push(release);
  return { started: started.promise, deferred, syncPrepare, prepareAsync, release };
}

describe("prepared runtime snapshots", () => {
  it("keeps registration and setters synchronous when an async companion is available", () => {
    const active: OpenClawConfig = { gateway: { port: 18789 } };
    setRuntimeConfigSnapshot(active);
    const prepare = vi.fn();
    const prepareAsync = vi.fn(async () => () => {});
    unregister.push(registerRuntimeConfigSnapshotPreparer(prepare, { prepareAsync }));
    expect(prepare).toHaveBeenCalledExactlyOnceWith(active);
    const next: OpenClawConfig = { gateway: { port: 19001 } };
    expect(setRuntimeConfigSnapshot(next)).toBeUndefined();
    expect(prepare).toHaveBeenLastCalledWith(next);
    expect(getRuntimeConfigSnapshot()).toBe(next);
    expect(prepareAsync).not.toHaveBeenCalled();
  });

  it("prepares registrations added during a cold load before publishing and reusing its config", async () => {
    const changes = vi.fn(() => getRuntimeConfigSnapshot());
    unregister.push(sessionChanges.subscribe(changes));
    const candidate: OpenClawConfig = { gateway: { port: 19001 } };
    const facts = createConfigResolutionFacts([]);
    setConfigResolutionFacts(candidate, facts);
    const loadGate = createDeferredCore<{ config: OpenClawConfig }>();
    const pending = loadPinnedRuntimeConfigAsync(() => loadGate.promise);
    const { started, deferred, syncPrepare, prepareAsync } = gatedPreparer();
    const contribute = vi.fn(() => {
      expect(getRuntimeConfigSnapshot()).toBeNull();
      expect(getConfigResolutionFacts(candidate)).toBe(facts);
    });
    const legacyPrepare = vi.fn();
    unregister.push(registerRuntimeConfigSnapshotPreparer(legacyPrepare));
    loadGate.resolve({ config: candidate });
    await started;
    expect(getRuntimeConfigSnapshot()).toBeNull();
    expect(getRuntimeConfigSnapshotMetadata()).toBeNull();
    expect(contribute).not.toHaveBeenCalled();
    expect(legacyPrepare).not.toHaveBeenCalled();
    deferred.resolve(contribute);
    expect(await pending).toBe(candidate);
    expect(getRuntimeConfigSnapshot()).toBe(candidate);
    expect(getRuntimeConfigSourceSnapshot()).toBeNull();
    expect(getRuntimeConfigSnapshotMetadata()?.revision).toBe(1);
    expect(syncPrepare).not.toHaveBeenCalled();
    expect(prepareAsync).toHaveBeenCalledExactlyOnceWith(candidate, { env: undefined });
    expect(legacyPrepare).toHaveBeenCalledExactlyOnceWith(candidate);
    expect(contribute).toHaveBeenCalledOnce();
    expect(changes).toHaveBeenCalledExactlyOnceWith({ all: true, scope: "config" });
    expect(changes).toHaveReturnedWith(candidate);
    const load = vi.fn(async () => ({ config: {} }));
    expect(await loadPinnedRuntimeConfigAsync(load)).toBe(candidate);
    expect(load).not.toHaveBeenCalled();
  });

  const modelConfig = (model = "unit-test/model"): OpenClawConfig => ({
    agents: {
      defaults: { model },
      entries: { main: { identity: { name: "Zilla" } } },
    },
  });

  const tokenConfig = (): OpenClawConfig => ({
    gateway: { port: 18789, auth: { token: "unit-test-token" } },
  });
  const withTokenFacts = (config: OpenClawConfig, unresolvedPaths: string[]): OpenClawConfig => {
    setConfigResolutionFacts(
      config,
      createConfigResolutionFacts(
        unresolvedPaths.map((configPath) => ({ varName: "UNIT_TEST_TOKEN", configPath })),
      ),
    );
    return config;
  };

  it.each([
    {
      name: "withholds an equal reload, then invalidates a changed model",
      initial: () => modelConfig(),
      next: () => modelConfig(),
      followup: () => modelConfig("unit-test/other"),
      emits: false,
    },
    {
      name: "withholds a distinct object with equal values and equal fresh provenance",
      next: () => withTokenFacts(tokenConfig(), ["gateway.auth.token"]),
      emits: false,
    },
    {
      name: "invalidates the published object republished without an edit",
      next: (published: OpenClawConfig) => published,
      emits: true,
    },
    {
      name: "invalidates equal bytes whose resolution provenance changed",
      next: () => withTokenFacts(tokenConfig(), []),
      emits: true,
    },
    {
      name: "invalidates equal bytes that lost their resolution provenance",
      next: () => tokenConfig(),
      emits: true,
    },
    {
      name: "invalidates a distinct object matching values edited in place on the published one",
      next: (published: OpenClawConfig) => {
        published.gateway = { ...published.gateway, port: 19001 };
        return withTokenFacts({ gateway: { ...tokenConfig().gateway, port: 19001 } }, [
          "gateway.auth.token",
        ]);
      },
      emits: true,
    },
    {
      name: "invalidates a distinct object matching provenance changed in place on the published one",
      next: (published: OpenClawConfig) => {
        setConfigResolutionFacts(published, createConfigResolutionFacts([]));
        return withTokenFacts(tokenConfig(), []);
      },
      emits: true,
    },
  ])("$name", ({ initial, next, followup, emits }) => {
    const changes = vi.fn();
    unregister.push(sessionChanges.subscribe(changes));
    const published = initial?.() ?? withTokenFacts(tokenConfig(), ["gateway.auth.token"]);
    setRuntimeConfigSnapshot(published);
    expect(changes).toHaveBeenCalledExactlyOnceWith({ all: true, scope: "config" });
    changes.mockClear();

    setRuntimeConfigSnapshot(next(published));
    expect(getRuntimeConfigSnapshotMetadata()?.revision).toBe(2);
    expect(changes).toHaveBeenCalledTimes(emits ? 1 : 0);
    if (emits) {
      expect(changes).toHaveBeenCalledExactlyOnceWith({ all: true, scope: "config" });
    }
    if (followup) {
      setRuntimeConfigSnapshot(followup());
      expect(getRuntimeConfigSnapshotMetadata()?.revision).toBe(3);
      expect(changes).toHaveBeenCalledExactlyOnceWith({ all: true, scope: "config" });
    }
  });

  it("withholds a source-only republish only when runtime values and provenance are unchanged", () => {
    const changes = vi.fn();
    unregister.push(sessionChanges.subscribe(changes));
    const runtime: OpenClawConfig = { gateway: { port: 18789 } };
    const source = (version: string, unresolvedPaths: string[] = []): OpenClawConfig =>
      withTokenFacts(
        { gateway: { port: 18789 }, meta: { lastTouchedVersion: version } },
        unresolvedPaths,
      );
    const advance = (sourceConfig: OpenClawConfig) => {
      changes.mockClear();
      expect(
        setRuntimeConfigSourceSnapshotIfCurrent({
          expectedRevision: getRuntimeConfigSnapshotMetadata()?.revision ?? 0,
          sourceConfig,
        }),
      ).toBe(true);
      expect(getRuntimeConfigSourceSnapshot()).toBe(sourceConfig);
      return changes.mock.calls.length;
    };
    setRuntimeConfigSnapshot(runtime, source("1"));

    // A value-identical config.apply only restamps the source's meta, so no row can change.
    expect(advance(source("2"))).toBe(0);
    // Changed provenance is copied onto the published object in place, so rows refresh.
    expect(advance(source("3", ["gateway.port"]))).toBe(1);
    // So does an in-place edit of the published object made since its last publication.
    runtime.gateway = { port: 19001 };
    expect(advance(source("4", ["gateway.port"]))).toBe(1);
    // And provenance changed in place, even when the newer source carries the same facts.
    setConfigResolutionFacts(runtime, createConfigResolutionFacts([]));
    expect(advance(source("5"))).toBe(1);
    expect(getRuntimeConfigSnapshot()).toBe(runtime);
  });

  it.each([
    "publication",
    "reset without active snapshot",
    "registration",
    "unregistration",
    "candidate bytes",
    "candidate facts",
    "environment",
    "caller",
  ])("discards a cold candidate after %s changes during preparation", async (change) => {
    const candidate: OpenClawConfig = { gateway: { port: 19001 } };
    const { started, deferred, release, prepareAsync } = gatedPreparer();
    const contribute = vi.fn();
    const env = { OPENCLAW_STATE_DIR: "/fixture/prepared-state" };
    const rollback = Object.assign(vi.fn(), { commit: vi.fn() });
    const publish = vi.fn(() => rollback);
    let current = true;
    const runtimeEnv =
      change === "environment" || change === "caller" ? { env, publish } : undefined;
    const pending = loadPinnedRuntimeConfigAsync(
      async () => ({ config: candidate, runtimeEnv }),
      change === "caller"
        ? {
            assertCurrent: () => {
              if (!current) {
                throw new Error("caller superseded");
              }
            },
          }
        : undefined,
    );
    await started;
    if (runtimeEnv) {
      expect(prepareAsync).toHaveBeenCalledExactlyOnceWith(candidate, { env });
      expect(prepareAsync.mock.calls[0]?.[1].env).toBe(env);
    }
    switch (change) {
      case "publication":
        setRuntimeConfigSnapshot({ gateway: { port: 20000 } });
        break;
      case "reset without active snapshot":
        resetConfigRuntimeState();
        break;
      case "registration":
        unregister.push(registerRuntimeConfigSnapshotPreparer(() => {}));
        break;
      case "unregistration":
        release();
        break;
      case "candidate bytes":
        candidate.gateway = { port: 20000 };
        break;
      case "candidate facts":
        setConfigResolutionFacts(candidate, createConfigResolutionFacts([]));
        break;
      case "environment":
        env.OPENCLAW_STATE_DIR = "/fixture/replaced-state";
        break;
      case "caller":
        current = false;
        break;
    }
    const active = getRuntimeConfigSnapshot();
    const metadata = getRuntimeConfigSnapshotMetadata();
    const result = active
      ? expect(pending).resolves.toBe(active)
      : expect(pending).rejects.toThrow(change === "caller" ? "caller superseded" : "superseded");
    deferred.resolve(contribute);
    await result;
    expect(contribute).not.toHaveBeenCalled();
    expect(getRuntimeConfigSnapshot()).toBe(active);
    expect(getRuntimeConfigSnapshotMetadata()).toBe(metadata);
    expect(rollback).toHaveBeenCalledTimes(change === "environment" ? 1 : 0);
    expect(rollback.commit).not.toHaveBeenCalled();
    if (change === "caller") {
      expect(publish).not.toHaveBeenCalled();
    }
  });

  it("joins rejected preparation companions before failing the cold load", async () => {
    const { started, deferred, syncPrepare } = gatedPreparer();
    const remaining = createDeferredCore<() => void>();
    const contribute = vi.fn();
    unregister.push(
      registerRuntimeConfigSnapshotPreparer(() => {}, {
        prepareAsync: () => remaining.promise,
      }),
    );
    const pending = loadPinnedRuntimeConfigAsync(async () => ({
      config: { gateway: { port: 19001 } },
    }));
    const completed = vi.fn();
    const observed = pending.then(completed, completed);
    await started;
    deferred.reject(new Error("preparation failed"));
    await setImmediate();
    expect(completed).not.toHaveBeenCalled();
    remaining.resolve(contribute);
    await expect(pending).rejects.toThrow("preparation failed");
    await observed;
    expect(completed).toHaveBeenCalledOnce();
    expect(contribute).not.toHaveBeenCalled();
    expect(syncPrepare).not.toHaveBeenCalled();
    expect(getRuntimeConfigSnapshot()).toBeNull();
    expect(getRuntimeConfigSnapshotMetadata()).toBeNull();
  });
});

describe("async cold runtime pin", () => {
  it.each(["reset", "newer publication"])("discards a cold load after %s", async (change) => {
    const gate = createDeferredCore<{ config: OpenClawConfig }>();
    const pending = loadPinnedRuntimeConfigAsync(() => gate.promise);
    const candidate: OpenClawConfig = { gateway: { port: 19001 } };
    const current: OpenClawConfig = { gateway: { port: 20001 } };
    if (change === "reset") {
      resetConfigRuntimeState();
      const rejected = expect(pending).rejects.toThrow("superseded");
      gate.resolve({ config: candidate });
      await rejected;
      expect(getRuntimeConfigSnapshot()).toBeNull();
    } else {
      setRuntimeConfigSnapshot(current);
      gate.resolve({ config: candidate });
      expect(await pending).toBe(current);
      expect(getRuntimeConfigSnapshot()).toBe(current);
    }
  });

  it.each(["publication", "reset", "admission"] as const)(
    "does not publish a cold candidate superseded by a contribution's %s",
    async (change) => {
      const candidate: OpenClawConfig = { gateway: { port: 19001 } };
      const newer: OpenClawConfig = { gateway: { port: 20001 } };
      let admitted = true;
      const rollback = Object.assign(vi.fn(), { commit: vi.fn() });
      unregister.push(
        registerRuntimeConfigSnapshotPreparer(() => {}, {
          prepareAsync: async () => () => {
            if (change === "publication") {
              setRuntimeConfigSnapshot(newer);
            } else if (change === "reset") {
              resetConfigRuntimeState();
            } else {
              admitted = false;
            }
          },
        }),
      );
      const pending = loadPinnedRuntimeConfigAsync(
        async () => ({ config: candidate, runtimeEnv: { env: {}, publish: () => rollback } }),
        {
          assertCurrent: () => {
            if (!admitted) {
              throw new Error("caller superseded during contribution");
            }
          },
        },
      );
      if (change === "publication") {
        expect(await pending).toBe(newer);
        expect(getRuntimeConfigSnapshot()).toBe(newer);
      } else {
        await expect(pending).rejects.toThrow("superseded");
        expect(getRuntimeConfigSnapshot()).toBeNull();
      }
      expect(rollback).toHaveBeenCalledOnce();
      expect(rollback.commit).not.toHaveBeenCalled();
    },
  );
});

describe("captured async runtime reads", () => {
  it.each(["source", "reset", "captured source"])(
    "keeps the selected runtime/source pair after %s changes before continuation",
    async (change) => {
      const runtime: OpenClawConfig = { gateway: { port: 19001 } };
      const firstSource: OpenClawConfig = { gateway: { port: 19002 } };
      setRuntimeConfigSnapshot(runtime, firstSource);
      const selected = change === "captured source" ? captureRuntimeConfig(runtime) : runtime;
      setRuntimeConfigSnapshot(selected, firstSource);
      vi.stubEnv("CONFIG_CAPTURE_TEST", "original");
      const pending = loadPinnedRuntimeConfigAsync(async () => ({ config: {} }), { capture: true });
      if (change === "reset") {
        resetConfigRuntimeState();
      } else {
        setRuntimeConfigSnapshot(selected, { gateway: { port: 19003 } });
      }
      vi.stubEnv("CONFIG_CAPTURE_TEST", "replacement");
      const captured = await pending;
      expect(captured.config).toEqual(runtime);
      expect(projectConfigOntoRuntimeSourceSnapshot(captured.config)).toEqual(firstSource);
      expect(captured.env.CONFIG_CAPTURE_TEST).toBe("original");
      if (change === "captured source") {
        const next = await loadPinnedRuntimeConfigAsync(async () => ({ config: {} }), {
          capture: true,
        });
        expect(projectConfigOntoRuntimeSourceSnapshot(next.config)).toEqual({
          gateway: { port: 19003 },
        });
      }
    },
  );

  it("captures a cold publication before queued source replacement", async () => {
    const runtime: OpenClawConfig = { gateway: { port: 19001 } };
    const release = sessionChanges.subscribe(() => {
      release();
      queueMicrotask(() => setRuntimeConfigSnapshot(runtime, { gateway: { port: 19002 } }));
    });
    try {
      const captured = await loadPinnedRuntimeConfigAsync(async () => ({ config: runtime }), {
        capture: true,
      });
      expect(getRuntimeConfigSourceSnapshot()).toEqual({ gateway: { port: 19002 } });
      expect(projectConfigOntoRuntimeSourceSnapshot(captured.config)).toEqual(runtime);
    } finally {
      release();
    }
  });
});

describe("config environment across in-process restart", () => {
  it.each([{ operation: "replacement", nextValue: "second" }])(
    "applies config-owned value $operation after restart",
    ({ nextValue }) => {
      vi.stubEnv("OPENCLAW_TEST_RESTART_VALUE", undefined);
      vi.stubEnv("OPENCLAW_TEST_RESTART_AMBIENT", "ambient");
      const initial = {
        env: {
          vars: {
            OPENCLAW_TEST_RESTART_VALUE: "first",
            OPENCLAW_TEST_RESTART_AMBIENT: "config-default",
          },
        },
      };
      const beforeStartup = { ...process.env };
      applyConfigEnvVars(initial);
      initializePublishedConfigRuntimeEnv(initial, {
        ownedEnv: collectConfigRuntimeEnvOwnership(initial, beforeStartup, process.env),
      });
      setAppliedRuntimeConfigSnapshot(initial, initial);

      clearRuntimeConfigSnapshot();
      // Server shutdown and the run loop both clear snapshots before the next boot.
      clearRuntimeConfigSnapshot();
      const beforeRestartedStartup = { ...process.env };
      applyConfigEnvVars(initial);
      initializePublishedConfigRuntimeEnv(initial, {
        ownedEnv: collectConfigRuntimeEnvOwnership(initial, beforeRestartedStartup, process.env),
        preserveExistingOwnership: true,
      });
      const next = {
        env: {
          vars: {
            ...(nextValue ? { OPENCLAW_TEST_RESTART_VALUE: nextValue } : {}),
            OPENCLAW_TEST_RESTART_AMBIENT: "changed-config-default",
          },
        },
      };
      const publication = prepareConfigRuntimeEnv({
        previousConfig: initial,
        nextConfig: next,
      }).publish();
      publication.commit();

      expect(process.env.OPENCLAW_TEST_RESTART_VALUE).toBe(nextValue);
      expect(process.env.OPENCLAW_TEST_RESTART_AMBIENT).toBe("ambient");
    },
  );

  it("fences a late rollback while retaining the published environment for restart", () => {
    vi.stubEnv("OPENCLAW_TEST_RESTART_VALUE", "first");
    const initial = { env: { vars: { OPENCLAW_TEST_RESTART_VALUE: "first" } } };
    const next = { env: { vars: { OPENCLAW_TEST_RESTART_VALUE: "second" } } };
    initializePublishedConfigRuntimeEnv(initial, {
      ownedEnv: { OPENCLAW_TEST_RESTART_VALUE: "first" },
    });
    const rollback = prepareConfigRuntimeEnv({
      previousConfig: initial,
      nextConfig: next,
    }).publish();

    clearRuntimeConfigSnapshot();
    rollback();

    expect(process.env.OPENCLAW_TEST_RESTART_VALUE).toBe("second");
    const publication = prepareConfigRuntimeEnv({ previousConfig: next, nextConfig: {} }).publish();
    publication.commit();
    expect(process.env.OPENCLAW_TEST_RESTART_VALUE).toBeUndefined();
  });

  it("still clears environment ownership on an explicit full runtime reset", () => {
    vi.stubEnv("OPENCLAW_TEST_RESTART_VALUE", "owned");
    const initial = { env: { vars: { OPENCLAW_TEST_RESTART_VALUE: "owned" } } };
    initializePublishedConfigRuntimeEnv(initial, {
      ownedEnv: { OPENCLAW_TEST_RESTART_VALUE: "owned" },
    });

    resetConfigRuntimeState();

    expect(getPublishedConfigRuntimeEnvState().ownedEnv).toEqual({});
    expect(getPublishedConfigRuntimeEnvState().sourceConfig).toBeNull();
  });
});
