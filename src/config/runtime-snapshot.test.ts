import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  applyConfigEnvVars,
  collectConfigRuntimeEnvOwnership,
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
  loadPinnedRuntimeConfigAsync as loadAsync,
  registerRuntimeConfigSnapshotPreparer as registerPreparer,
  setAppliedRuntimeConfigSnapshot,
  finalizeRuntimeSnapshotWrite,
  hashRuntimeConfigValue,
  hasManagedRuntimeConfigWriteOwner,
  getRuntimeConfigSnapshotMetadata as getMetadata,
  getRuntimeConfigSourceSnapshot as getSource,
  getRuntimeConfigSnapshot as getSnapshot,
  getRuntimeConfigAppliedHash as getAppliedHash,
  preflightManagedRuntimeConfigWrite,
  loadPinnedRuntimeConfig,
  registerManagedRuntimeConfigWriteOwner,
  resetConfigRuntimeState,
  resolveRuntimeConfigCacheKey,
  resolveRuntimeModelConfigCacheKey as modelCacheKey,
  selectApplicableRuntimeConfig,
  setRuntimeConfigSnapshot as setSnapshot,
  setRuntimeConfigSourceSnapshotIfCurrent as setSourceIfCurrent,
  setRuntimeConfigSnapshotRefreshHandler,
} from "./runtime-snapshot.js";
import { createProviderConfigFixture } from "./runtime-snapshot.test-fixtures.js";
import {
  captureRuntimeConfig,
  projectConfigOntoRuntimeSourceSnapshot,
} from "./runtime-source-projection.js";
import type { OpenClawConfig as Config } from "./types.js";

function resetRuntimeConfigState(): void {
  setRuntimeConfigSnapshotRefreshHandler(null);
  resetConfigRuntimeState();
}

const unregister: Array<() => void> = [];

const portConfig = (port: number) => ({ gateway: { port } });
const providerRefs = (id = "PROVIDER_KEY") => new Map([["models.providers.openai.apiKey", id]]);

function replaceSource(sourceConfig: Config) {
  expect(setSourceIfCurrent({ expectedRevision: getMetadata()!.revision, sourceConfig })).toBe(
    true,
  );
}

const authConfig = (): Config => ({ gateway: { auth: { mode: "token" } } });
function writeFixture(
  nextSourceConfig: Config,
  hadBothSnapshots: boolean,
  fresh = nextSourceConfig,
) {
  return {
    nextSourceConfig,
    hadBothSnapshots,
    freshConfig: vi.fn(async () => ({ config: fresh })),
    notifyCommittedWrite: vi.fn(),
    formatRefreshError: String,
    createRefreshError: (detail: string, cause: unknown) => new Error(detail, { cause }),
  };
}

afterEach(() => {
  unregister.splice(0).forEach((release) => release());
  resetRuntimeConfigState();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("pins the first successful load in memory until the snapshot is cleared", () => {
  let freshPort = 18789;
  const loadFresh = vi.fn(() => portConfig(freshPort));

  expect(loadPinnedRuntimeConfig(loadFresh).gateway?.port).toBe(18789);
  expect(loadFresh).toHaveBeenCalledTimes(1);

  freshPort = 19001;
  expect(loadPinnedRuntimeConfig(loadFresh).gateway?.port).toBe(18789);
  expect(loadFresh).toHaveBeenCalledTimes(1);

  resetRuntimeConfigState();
  expect(loadPinnedRuntimeConfig(loadFresh).gateway?.port).toBe(19001);
  expect(loadFresh).toHaveBeenCalledTimes(2);
});

it("publishes and replaces same-byte resolution facts with the source snapshot", () => {
  const runtimeConfig: Config = {
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
  setSnapshot(runtimeConfig, unresolvedSource);
  expect([...(getConfigResolutionFacts(getSnapshot()) ?? [])]).toEqual(["gateway.auth.token"]);
  expect(getAuthoredConfigSecretRef(getSnapshot(), "gateway.auth.token")?.id).toBe("GATEWAY_TOKEN");

  const literalSource = structuredClone(runtimeConfig);
  setConfigResolutionFacts(literalSource, createConfigResolutionFacts([]));
  replaceSource(literalSource);
  expect(getConfigResolutionFacts(getSnapshot())?.size).toBe(0);
  expect(getAuthoredConfigSecretRef(getSnapshot(), "gateway.auth.token")).toBeNull();
});

it("keeps model projections across display writes but invalidates authored values and resolution changes", () => {
  const initial = modelConfig("test/first");
  setSnapshot(initial, initial);
  const modelKey = modelCacheKey(initial);
  const configKey = resolveRuntimeConfigCacheKey(initial);
  const display: Config = {
    ...initial,
    ui: { seamColor: "#123456", prefs: { chatShowToolCalls: false } },
    meta: { lastTouchedVersion: "2026.10.11" },
  };
  setSnapshot(display, display);
  expect(resolveRuntimeConfigCacheKey(display)).not.toBe(configKey);
  expect(modelCacheKey(display)).toBe(modelKey);

  const source = { ...display, ...modelConfig("test/second") };
  replaceSource(source);
  expect(modelCacheKey(getSnapshot()!)).not.toBe(modelKey);
  expect(getSource()).toBe(source);

  const resolved = { ...display };
  setConfigResolutionFacts(resolved, new Set());
  setSnapshot(resolved, display);
  expect(modelCacheKey(resolved)).not.toBe(modelKey);
  setSnapshot(source, source);
  expect(modelCacheKey(source)).not.toBe(modelKey);
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
  const config = captureRuntimeConfig(source);
  const first = hashRuntimeConfigValue(config);
  for (let index = 0; index < 200; index += 1) {
    expect(hashRuntimeConfigValue(config)).toBe(first);
  }
  expect(keys.mock.calls.filter(([value]) => value === config.agents?.entries)).toHaveLength(1);
});

it("rehashes mutable descendants of a shallow-frozen config", () => {
  const config = Object.freeze(portConfig(18789));
  const before = hashRuntimeConfigValue(config);
  config.gateway.port = 19001;
  expect(hashRuntimeConfigValue(config)).not.toBe(before);
  expect(hashRuntimeConfigValue(config)).toBe(hashRuntimeConfigValue(portConfig(19001)));
});

it("selects and retains only matching runtime sources", () => {
  const sourceConfig = createProviderConfigFixture();
  const runtimeConfig = createProviderConfigFixture("sk-runtime-resolved");
  const scopedResolvedConfig: Config = { ...runtimeConfig, tools: { updatePlan: true } };

  const readUnbound = createRuntimeConfigReader(scopedResolvedConfig);
  const select = (inputConfig: Config) =>
    selectApplicableRuntimeConfig({
      inputConfig,
      runtimeConfig,
      runtimeSourceConfig: sourceConfig,
    });
  expect(select(cloneConfigWithResolutionFacts(sourceConfig))).toBe(runtimeConfig);
  expect(select(scopedResolvedConfig)).toBe(scopedResolvedConfig);
  const foreignConfig = cloneConfigWithResolutionFacts(sourceConfig);
  setConfigResolutionFacts(
    foreignConfig,
    createConfigResolutionFacts([], providerRefs("OTHER_PROVIDER_KEY")),
  );
  expect(select(foreignConfig)).toBe(foreignConfig);
  setSnapshot(runtimeConfig, sourceConfig);
  const readRuntime = createRuntimeConfigReader(cloneConfigWithResolutionFacts(sourceConfig));
  const readScoped = createRuntimeConfigReader(scopedResolvedConfig);
  const readForeign = createRuntimeConfigReader(foreignConfig);
  const nextConfig = { ...runtimeConfig, messages: { ackReactionScope: "all" as const } };
  setSnapshot(nextConfig, nextConfig);
  expect(readRuntime()).toBe(nextConfig);
  expect(readScoped()).toBe(scopedResolvedConfig);
  expect(readForeign()).toBe(foreignConfig);
  expect(readUnbound()).toBe(scopedResolvedConfig);
});

it("does not replace explicit config with a pinned snapshot without a source contract", () => {
  const sourceConfig = createProviderConfigFixture();
  const resolvedConfig = createProviderConfigFixture("synthetic-resolved-key");
  const pinned = loadPinnedRuntimeConfig(() => sourceConfig);
  expect(getSource()).toBeNull();

  expect(
    selectApplicableRuntimeConfig({ inputConfig: resolvedConfig, runtimeConfig: pinned }),
  ).toBe(resolvedConfig);
  expect(selectApplicableRuntimeConfig({ inputConfig: sourceConfig, runtimeConfig: pinned })).toBe(
    sourceConfig,
  );
  expect(selectApplicableRuntimeConfig({ runtimeConfig: pinned })).toBe(pinned);

  // A resolved but unrelated singleton cannot supply credentials for an explicit source either.
  setSnapshot(resolvedConfig);
  expect(
    selectApplicableRuntimeConfig({ inputConfig: sourceConfig, runtimeConfig: getSnapshot() }),
  ).toBe(sourceConfig);
});

it.each([
  ["equivalent", () => createConfigResolutionFacts([], providerRefs())],
  ["absent", undefined],
  ["empty", () => createConfigResolutionFacts([])],
  ["different-ref", () => createConfigResolutionFacts([], providerRefs("OTHER_KEY"))],
  ["different-provider", () => createConfigResolutionFacts([], providerRefs(), "other")],
  ["resolved", () => createConfigResolutionFacts([], new Map(), "default", providerRefs())],
  [
    "unresolved",
    () =>
      createConfigResolutionFacts(
        [{ configPath: "models.providers.openai.apiKey", varName: "PROVIDER_KEY" }],
        providerRefs(),
      ),
  ],
] as const)("selects runtime only for equivalent facts: %s", (kind, facts) => {
  const source = createProviderConfigFixture();
  const input = structuredClone(source);
  setConfigResolutionFacts(source, createConfigResolutionFacts([], providerRefs()));
  if (facts) {
    setConfigResolutionFacts(input, facts());
  }
  const runtime = createProviderConfigFixture("synthetic-runtime-key");
  setSnapshot(runtime, source);
  if (kind === "equivalent") {
    expect(getConfigResolutionFacts(input)).not.toBe(getConfigResolutionFacts(source));
  }
  expect(createRuntimeConfigReader(input)()).toBe(kind === "equivalent" ? runtime : input);
});

it.each([true, false])(
  "refreshes snapshots after a write (authored source=%s)",
  async (hasSource) => {
    const nextSource = hasSource
      ? { ...authConfig(), ...createProviderConfigFixture() }
      : portConfig(19002);
    const fresh = hasSource ? authConfig() : portConfig(19002);
    const write = writeFixture(nextSource, hasSource, fresh);
    setSnapshot(
      hasSource ? createProviderConfigFixture("sk-runtime-resolved") : portConfig(18789),
      hasSource ? nextSource : undefined,
    );
    await finalizeRuntimeSnapshotWrite(write);
    expect(write.freshConfig).toHaveBeenCalledOnce();
    expect(write.notifyCommittedWrite).toHaveBeenCalledOnce();
    expect(getSnapshot()).toEqual(fresh);
    expect(getSource()).toEqual(hasSource ? nextSource : null);
  },
);

it("keeps the last-known-good runtime snapshot active while specialized refresh is pending", async () => {
  const write = writeFixture(
    { ...authConfig(), ...createProviderConfigFixture() },
    true,
    authConfig(),
  );
  const refresh = createDeferredCore<boolean>();

  setSnapshot(createProviderConfigFixture("sk-runtime-resolved"), createProviderConfigFixture());
  setRuntimeConfigSnapshotRefreshHandler({
    refresh: async ({ sourceConfig }) => {
      expect(sourceConfig.gateway?.auth).toEqual({ mode: "token" });
      expect(getSnapshot()?.gateway?.auth).toBeUndefined();
      const handled = await refresh.promise;
      if (handled) {
        setSnapshot(sourceConfig, sourceConfig);
      }
      return handled;
    },
  });

  const writePromise = finalizeRuntimeSnapshotWrite(write);

  await Promise.resolve();
  expect(getSnapshot()?.gateway?.auth).toBeUndefined();
  expect(write.freshConfig).not.toHaveBeenCalled();

  refresh.resolve(true);
  await writePromise;

  expect(write.notifyCommittedWrite).toHaveBeenCalledTimes(1);
  expect(getSnapshot()?.gateway?.auth).toEqual({ mode: "token" });
});

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
  const candidateA = { runtimeConfig: portConfig(19001), compareConfig: {} };
  const candidateB = { runtimeConfig: portConfig(19002), compareConfig: {} };
  const register = (candidate: typeof candidateA) =>
    registerManagedRuntimeConfigWriteOwner("/tmp/scoped.json", async () => candidate);
  const releaseA = register(candidateA);
  const releaseB = register(candidateB);

  unregister.push(releaseA, releaseB);
  const prepared = await preflightManagedRuntimeConfigWrite("/tmp/scoped.json", {});
  expect(prepared.get(releaseA.ownerId)).toBe(candidateA);
  expect(prepared.get(releaseB.ownerId)).toBe(candidateB);
});

it("defers raw runtime activation to a managed write owner", async () => {
  const activeConfig: Config = portConfig(18789);
  setSnapshot(activeConfig);
  const write = writeFixture(portConfig(19001), false);
  const refresh = vi.fn(async () => true);
  setRuntimeConfigSnapshotRefreshHandler({ refresh });

  await finalizeRuntimeSnapshotWrite({ ...write, deferRuntimeActivation: true });

  expect(getSnapshot()).toBe(activeConfig);
  expect(refresh).not.toHaveBeenCalled();
  expect(write.freshConfig).not.toHaveBeenCalled();
  expect(write.notifyCommittedWrite).toHaveBeenCalledOnce();
});

function gatedPreparer() {
  const started = createDeferredCore();
  const deferred = createDeferredCore<() => void>();
  const syncPrepare = vi.fn();
  const prepareAsync = vi.fn(() => {
    started.resolve();
    return deferred.promise;
  });
  const release = registerPreparer(syncPrepare, { prepareAsync });
  unregister.push(release);
  return { started: started.promise, deferred, syncPrepare, prepareAsync };
}

it("publishes applied config and its source only after asynchronous preparation", async () => {
  const { started, deferred } = gatedPreparer();
  const config: Config = portConfig(19001);
  const source: Config = portConfig(19002);
  const facts = createConfigResolutionFacts([]);
  setConfigResolutionFacts(source, facts);
  const pending = setAppliedRuntimeConfigSnapshot(config, source);
  await started;
  expect(getSnapshot()).toBeNull();
  expect(getAppliedHash()).toBeNull();
  deferred.resolve(() => {});
  await pending;
  expect(getSnapshot()).toBe(config);
  expect(getSource()).toBe(source);
  expect(getConfigResolutionFacts(config)).toBe(facts);
  expect(getAppliedHash()).toBe(hashRuntimeConfigValue(source));
});

it("keeps registration and setters synchronous when an async companion is available", () => {
  const active: Config = portConfig(18789);
  setSnapshot(active);
  const prepare = vi.fn();
  const prepareAsync = vi.fn(async () => () => {});
  unregister.push(registerPreparer(prepare, { prepareAsync }));
  expect(prepare).toHaveBeenCalledExactlyOnceWith(active);
  const next: Config = portConfig(19001);
  expect(setSnapshot(next)).toBeUndefined();
  expect(prepare).toHaveBeenLastCalledWith(next);
  expect(getSnapshot()).toBe(next);
  expect(prepareAsync).not.toHaveBeenCalled();
});

it("prepares registrations added during a cold load before publishing and reusing its config", async () => {
  const changes = vi.fn(() => getSnapshot());
  unregister.push(sessionChanges.subscribe(changes));
  const candidate: Config = portConfig(19001);
  const facts = createConfigResolutionFacts([]);
  setConfigResolutionFacts(candidate, facts);
  const loadGate = createDeferredCore<{ config: Config }>();
  const pending = loadAsync(() => loadGate.promise);
  const { started, deferred, syncPrepare, prepareAsync } = gatedPreparer();
  const contribute = vi.fn(() => {
    expect(getSnapshot()).toBeNull();
    expect(getConfigResolutionFacts(candidate)).toBe(facts);
  });
  const legacyPrepare = vi.fn();
  unregister.push(registerPreparer(legacyPrepare));
  loadGate.resolve({ config: candidate });
  await started;
  expect(getSnapshot()).toBeNull();
  expect(getMetadata()).toBeNull();
  expect(contribute).not.toHaveBeenCalled();
  expect(legacyPrepare).not.toHaveBeenCalled();
  deferred.resolve(contribute);
  expect(await pending).toBe(candidate);
  expect(getSnapshot()).toBe(candidate);
  expect(getSource()).toBeNull();
  expect(getMetadata()?.revision).toBe(1);
  expect(syncPrepare).not.toHaveBeenCalled();
  expect(prepareAsync).toHaveBeenCalledExactlyOnceWith(candidate, { env: undefined });
  expect(legacyPrepare).toHaveBeenCalledExactlyOnceWith(candidate);
  expect(contribute).toHaveBeenCalledOnce();
  expect(changes).toHaveBeenCalledExactlyOnceWith({ all: true, scope: "config" });
  expect(changes).toHaveReturnedWith(candidate);
  const load = vi.fn(async () => ({ config: {} }));
  expect(await loadAsync(load)).toBe(candidate);
  expect(load).not.toHaveBeenCalled();
});

const modelConfig = (model = "unit-test/model"): Config => ({
  agents: { defaults: { model } },
});

const tokenConfig = (): Config => ({
  gateway: { port: 18789, auth: { token: "unit-test-token" } },
});
const withTokenFacts = (
  config: Config = tokenConfig(),
  unresolvedPaths: string[] = ["gateway.auth.token"],
): Config => {
  setConfigResolutionFacts(
    config,
    createConfigResolutionFacts(
      unresolvedPaths.map((configPath) => ({ varName: "UNIT_TEST_TOKEN", configPath })),
    ),
  );
  return config;
};

const editPort = (config: Config) => {
  config.gateway = { ...config.gateway, port: 19001 };
};
const clearFacts = (config: Config) =>
  setConfigResolutionFacts(config, createConfigResolutionFacts([]));
const emptyFacts = () => withTokenFacts(tokenConfig(), []);
const changedPort = () => withTokenFacts({ gateway: { ...tokenConfig().gateway, port: 19001 } });
type ReloadCase = [
  name: string,
  next: (published: Config) => Config,
  emits: boolean,
  mutate?: (published: Config) => void,
  initial?: () => Config,
  followup?: () => Config,
];
it.each<ReloadCase>([
  [
    "equal reload then changed model",
    () => modelConfig(),
    false,
    undefined,
    () => modelConfig(),
    () => modelConfig("unit-test/other"),
  ],
  ["equal values and fresh provenance", () => withTokenFacts(), false],
  ["same published object", (published) => published, true],
  ["changed provenance", emptyFacts, true],
  ["missing provenance", tokenConfig, true],
  ["values matching in-place edit", changedPort, true, editPort],
  ["provenance matching in-place edit", emptyFacts, true, clearFacts],
  ["original values after in-place edit", () => withTokenFacts(), true, editPort],
  ["original provenance after in-place edit", () => withTokenFacts(), true, clearFacts],
])("publication: %s", (_name, next, emits, mutate, initial, followup) => {
  const changes = vi.fn();
  unregister.push(sessionChanges.subscribe(changes));
  const published = initial?.() ?? withTokenFacts();
  setSnapshot(published);
  const metadata = getMetadata();
  expect(changes).toHaveBeenCalledExactlyOnceWith({ all: true, scope: "config" });
  changes.mockClear();

  mutate?.(published);
  const nextConfig = next(published);
  setSnapshot(nextConfig);
  // a same-value publication is a full no-op; revision is internal and keys caches
  expect(getMetadata()?.revision).toBe(emits ? 2 : 1);
  expect(changes).toHaveBeenCalledTimes(emits ? 1 : 0);
  if (emits) {
    expect(getSnapshot()).toBe(nextConfig);
    expect(changes).toHaveBeenCalledExactlyOnceWith({ all: true, scope: "config" });
  } else {
    expect(getSnapshot()).toBe(published);
    expect(getMetadata()).toBe(metadata);
  }
  if (followup) {
    setSnapshot(followup());
    expect(getMetadata()?.revision).toBe(emits ? 3 : 2);
    expect(changes).toHaveBeenCalledExactlyOnceWith({ all: true, scope: "config" });
  }
});

it("withholds a source-only republish only when runtime values and provenance are unchanged", () => {
  const changes = vi.fn();
  unregister.push(sessionChanges.subscribe(changes));
  const runtime: Config = portConfig(18789);
  const source = (version: string, unresolvedPaths: string[] = []): Config =>
    withTokenFacts(
      { gateway: { port: 18789 }, meta: { lastTouchedVersion: version } },
      unresolvedPaths,
    );
  const advance = (sourceConfig: Config, changed = true) => {
    const previousSource = getSource();
    const previousMetadata = getMetadata();
    changes.mockClear();
    replaceSource(sourceConfig);
    expect(getSource()).toBe(changed ? sourceConfig : previousSource);
    if (!changed) {
      expect(getSnapshot()).toBe(runtime);
      expect(getMetadata()).toBe(previousMetadata);
    }
    return changes.mock.calls.length;
  };
  setSnapshot(runtime, source("1"));

  // A value-identical config.apply only restamps the source's meta, so no row can change.
  expect(advance(source("2"), false)).toBe(0);
  // Changed provenance is copied onto the published object in place, so rows refresh.
  expect(advance(source("3", ["gateway.port"]))).toBe(1);
  // So does an in-place edit of the published object made since its last publication.
  runtime.gateway = { port: 19001 };
  expect(advance(source("4", ["gateway.port"]))).toBe(1);
  // And provenance changed in place, even when the newer source carries the same facts.
  setConfigResolutionFacts(runtime, createConfigResolutionFacts([]));
  expect(advance(source("5"))).toBe(1);
  expect(getSnapshot()).toBe(runtime);
});

it.each(["preparation", "contribution"] as const)(
  "rechecks caller authority after %s",
  async (phase) => {
    const { started, deferred } = gatedPreparer();
    const failure =
      phase === "contribution" ? "caller superseded during contribution" : "caller superseded";
    let current = true;
    const rollback = Object.assign(vi.fn(), { commit: vi.fn() });
    const contribute = vi.fn(() => {
      current = false;
    });
    const pending = loadAsync(
      async () => ({
        config: portConfig(19001),
        ...(phase === "contribution" ? { runtimeEnv: { env: {}, publish: () => rollback } } : {}),
      }),
      {
        assertCurrent: () => {
          if (!current) {
            throw new Error(failure);
          }
        },
      },
    );
    await started;
    if (phase === "preparation") {
      current = false;
    }
    const rejected = expect(pending).rejects.toThrow(failure);
    deferred.resolve(contribute);
    await rejected;
    expect(getSnapshot()).toBeNull();
    if (phase === "contribution") {
      expect(contribute).toHaveBeenCalledOnce();
      expect(rollback).toHaveBeenCalledOnce();
      expect(rollback.commit).not.toHaveBeenCalled();
    } else {
      expect(contribute).not.toHaveBeenCalled();
    }
  },
);

it("joins rejected preparation companions before failing the cold load", async () => {
  const { started, deferred, syncPrepare } = gatedPreparer();
  const remaining = createDeferredCore<() => void>();
  const contribute = vi.fn();
  unregister.push(
    registerPreparer(() => {}, {
      prepareAsync: () => remaining.promise,
    }),
  );
  const pending = loadAsync(async () => ({ config: portConfig(19001) }));
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
  expect(getSnapshot()).toBeNull();
  expect(getMetadata()).toBeNull();
});

it("reuses a newer publication that completes during a cold load", async () => {
  const gate = createDeferredCore<{ config: Config }>();
  const pending = loadAsync(() => gate.promise);
  const current: Config = portConfig(20001);
  setSnapshot(current);
  gate.resolve({ config: portConfig(19001) });
  expect(await pending).toBe(current);
  expect(getSnapshot()).toBe(current);
});

it.each(["source", "reset", "captured source"])(
  "keeps the selected runtime/source pair after %s changes before continuation",
  async (change) => {
    const runtime: Config = portConfig(19001);
    const firstSource: Config = portConfig(19002);
    const nextSource: Config = portConfig(19003);
    setSnapshot(runtime, firstSource);
    const selected = change === "captured source" ? captureRuntimeConfig(runtime) : runtime;
    setSnapshot(selected, firstSource);
    vi.stubEnv("CONFIG_CAPTURE_TEST", "original");
    const pending = loadAsync(async () => ({ config: {} }), { capture: true });
    if (change === "reset") {
      resetConfigRuntimeState();
    } else {
      setSnapshot(selected, nextSource);
    }
    vi.stubEnv("CONFIG_CAPTURE_TEST", "replacement");
    const captured = await pending;
    expect(captured.config).toEqual(runtime);
    expect(projectConfigOntoRuntimeSourceSnapshot(captured.config)).toEqual(firstSource);
    expect(captured.env.CONFIG_CAPTURE_TEST).toBe("original");
    if (change === "captured source") {
      const next = await loadAsync(async () => ({ config: {} }), { capture: true });
      expect(projectConfigOntoRuntimeSourceSnapshot(next.config)).toEqual(nextSource);
    }
  },
);

it("captures a cold publication before queued source replacement", async () => {
  const runtime: Config = portConfig(19001);
  const release = sessionChanges.subscribe(() => {
    release();
    queueMicrotask(() => setSnapshot(runtime, portConfig(19002)));
  });
  try {
    const captured = await loadAsync(async () => ({ config: runtime }), { capture: true });
    expect(getSource()).toEqual(portConfig(19002));
    expect(projectConfigOntoRuntimeSourceSnapshot(captured.config)).toEqual(runtime);
  } finally {
    release();
  }
});

const restartConfig = (value: string, ambient: string): Config => ({
  env: { vars: { OPENCLAW_TEST_RESTART_VALUE: value, OPENCLAW_TEST_RESTART_AMBIENT: ambient } },
});
it("applies config-owned value replacement after restart", async () => {
  vi.stubEnv("OPENCLAW_TEST_RESTART_VALUE", undefined);
  vi.stubEnv("OPENCLAW_TEST_RESTART_AMBIENT", "ambient");
  const initial = restartConfig("first", "config-default");
  const start = (preserveExistingOwnership = false) => {
    const before = { ...process.env };
    applyConfigEnvVars(initial);
    initializePublishedConfigRuntimeEnv(initial, {
      ownedEnv: collectConfigRuntimeEnvOwnership(initial, before, process.env),
      preserveExistingOwnership,
    });
  };
  start();
  await setAppliedRuntimeConfigSnapshot(initial, initial);

  // Server shutdown and the run loop both clear snapshots before the next boot.
  clearRuntimeConfigSnapshot();
  clearRuntimeConfigSnapshot();
  start(true);
  const publication = prepareConfigRuntimeEnv({
    previousConfig: initial,
    nextConfig: restartConfig("second", "changed-config-default"),
  }).publish();
  publication.commit();

  expect(process.env.OPENCLAW_TEST_RESTART_VALUE).toBe("second");
  expect(process.env.OPENCLAW_TEST_RESTART_AMBIENT).toBe("ambient");
});

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
