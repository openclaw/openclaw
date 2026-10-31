import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describePendingFakeTimers } from "../../test/helpers/fake-timer-diagnostics.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { AuthProfileStore, SavedSetupCredential } from "../agents/auth-profiles/types.js";
import type { InferenceBackendCandidate } from "../commands/onboard-inference-ambient.js";
import type { detectInferenceBackends } from "../commands/onboard-inference.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderAuthChoiceMetadata } from "../plugins/provider-auth-choices.js";
import type { ProviderAppGuidedSetupCandidate, ProviderPlugin } from "../plugins/types.js";
import { detectSetupInference } from "./setup-inference-detect.js";

const fixture = vi.hoisted(() => ({
  config: {} as OpenClawConfig,
  loadAuthProfileStore: vi.fn<() => AuthProfileStore | Promise<AuthProfileStore>>(),
  withSetupProviderAuthMethod: vi.fn(),
  detectInferenceBackends: vi.fn<typeof detectInferenceBackends>(),
  resolveManifestProviderAuthChoices:
    vi.fn<
      typeof import("../plugins/provider-auth-choices.js").resolveManifestProviderAuthChoices
    >(),
  resolvePluginProvidersCore:
    vi.fn<typeof import("../plugins/providers.runtime.js").resolvePluginProvidersCore>(),
  enablePluginInConfig: vi.fn<typeof import("../plugins/enable.js").enablePluginInConfig>(),
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshotWithPluginMetadata: async () => ({
    snapshot: { exists: true, valid: true, config: fixture.config },
  }),
}));
vi.mock("../agents/auth-profiles/store-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/auth-profiles/store-runtime.js")>()),
  loadAuthProfileStoreWithoutExternalProfilesAsync: async () => fixture.loadAuthProfileStore(),
}));
// mock-isolation: Discovery deadlines exclude the process-owned directory observer lifecycle.
vi.mock("../infra/owned-directory-observation.js", () => ({
  observeOwnedDirectory: () => ({ close() {} }),
}));
vi.mock("./setup-provider-method.js", () => ({
  withSetupProviderAuthMethod: fixture.withSetupProviderAuthMethod,
}));
vi.mock("./setup-native-session-catalogs.js", () => ({
  listSetupNativeSessionCatalogs: () => [],
  requiresSetupNativeSessionCatalogConsent: () => false,
}));
vi.mock("../plugins/provider-install-catalog.js", () => ({
  resolveProviderInstallCatalogEntries: () => [],
}));
// mock-isolation: Discovery tests simulate enabling plugins without changing installed plugin state.
vi.mock("../plugins/enable.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/enable.js")>()),
  enablePluginInConfig: fixture.enablePluginInConfig,
  enablePluginWithCapabilityConsent: async (config: OpenClawConfig) => ({ enabled: true, config }),
}));
vi.mock("../plugins/plugin-lifecycle-lease.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-lifecycle-lease.js")>()),
  withPluginLifecycleLeaseAsync: async (_options: unknown, run: () => Promise<unknown>) =>
    await run(),
}));

vi.mock("../commands/onboard-inference.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/onboard-inference.js")>()),
  detectInferenceBackends: fixture.detectInferenceBackends,
}));
vi.mock("../plugins/provider-auth-choices.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/provider-auth-choices.js")>()),
  resolveManifestProviderAuthChoices: fixture.resolveManifestProviderAuthChoices,
}));
vi.mock("../plugins/providers.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/providers.runtime.js")>()),
  resolvePluginProvidersCore: fixture.resolvePluginProvidersCore,
}));

const choice: ProviderAuthChoiceMetadata = {
  pluginId: "fixture",
  providerId: "fixture",
  methodId: "local",
  choiceId: "fixture-local",
  choiceLabel: "Fixture service",
  appGuidedDiscovery: true,
  appGuidedSecret: true,
};

function savedStore(
  setup: SavedSetupCredential | undefined,
  id = "saved",
  key = "fixture-key",
): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      [`fixture:${id}`]: { type: "api_key", provider: "fixture", key, ...(setup ? { setup } : {}) },
    },
  };
}

function savedSetup(modelRef = "fixture/saved-model", registered = false): SavedSetupCredential {
  return {
    replacement: true,
    modelRef,
    configJson: "{}",
    ...(registered ? { authChoice: choice.choiceId, pluginId: choice.pluginId } : {}),
  };
}

function detectWithProvider(
  detect: NonNullable<ProviderPlugin["auth"][number]["appGuidedSetup"]>["detect"],
  nativeCandidates: InferenceBackendCandidate[] | typeof detectInferenceBackends = [],
  options: {
    enablePluginInConfig?: typeof import("../plugins/enable.js").enablePluginInConfig;
    choices?: ProviderAuthChoiceMetadata[];
  } = {},
) {
  const provider: ProviderPlugin = {
    id: "fixture",
    pluginId: "fixture",
    label: "Fixture service",
    auth: [
      {
        id: "local",
        label: "Local model",
        kind: "custom",
        run: async () => ({ profiles: [] }),
        appGuidedSetup: { detect, prepare: async () => null },
      },
    ],
  };
  fixture.resolveManifestProviderAuthChoices.mockReturnValue(options.choices ?? [choice]);
  fixture.resolvePluginProvidersCore.mockReturnValue([provider]);
  fixture.detectInferenceBackends.mockImplementation(
    typeof nativeCandidates === "function" ? nativeCandidates : async () => nativeCandidates,
  );
  if (options.enablePluginInConfig) {
    fixture.enablePluginInConfig.mockImplementation(options.enablePluginInConfig);
  }
  return detectSetupInference("main");
}

beforeEach(() => {
  vi.useFakeTimers();
  fixture.config = {
    agents: { entries: { main: {} }, defaults: { workspace: "/fixture/workspace" } },
  };
  fixture.loadAuthProfileStore.mockReturnValue(savedStore(savedSetup(undefined, true)));
  fixture.withSetupProviderAuthMethod.mockReset();
  fixture.resolveManifestProviderAuthChoices.mockReset().mockReturnValue([choice]);
  fixture.resolvePluginProvidersCore.mockReset().mockReturnValue([]);
  fixture.detectInferenceBackends.mockReset().mockResolvedValue([]);
  fixture.enablePluginInConfig.mockReset().mockImplementation((config, pluginId) => ({
    enabled: true,
    config,
    pluginId,
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function nativeCandidate(
  kind: InferenceBackendCandidate["kind"],
  modelRef: string,
  credentials = true,
): InferenceBackendCandidate {
  return { kind, modelRef, label: kind, detail: "", credentials };
}
const environmentCandidate = nativeCandidate("openai-api-key", "fixture/environment-model");

function pendingProbe<T>() {
  const started = createDeferred<AbortSignal | undefined>();
  const result = createDeferred<T>();
  return {
    started: started.promise,
    result,
    run: ({ signal }: { signal?: AbortSignal } = {}) => {
      started.resolve(signal);
      return result.promise;
    },
  };
}

describe("setup inference discovery concurrency", () => {
  it("probes provider services during CLI detection", async () => {
    const cli = pendingProbe<InferenceBackendCandidate[]>();
    const hook = pendingProbe<ProviderAppGuidedSetupCandidate | null>();
    const detection = detectWithProvider(hook.run, () => cli.run());
    // Serial discovery cannot start the provider probe while CLI detection is pending.
    await Promise.all([cli.started, hook.started]);
    cli.result.resolve([environmentCandidate]);
    hook.result.resolve({ modelRef: "fixture/local-model" });
    expect((await detection).candidates.map(({ modelRef }) => modelRef)).toEqual([
      "fixture/environment-model",
      "fixture/saved-model",
      "fixture/local-model",
    ]);
    expect(vi.getTimerCount(), describePendingFakeTimers()).toBe(0);
  });

  it("reports a provider discovery failure without waiting for CLI detection", async () => {
    fixture.resolvePluginProvidersCore.mockImplementation(() => {
      throw new Error("synthetic provider load failure");
    });
    fixture.detectInferenceBackends.mockImplementation(() => new Promise(() => {}));
    const detection = detectSetupInference("main");
    await expect(detection).rejects.toThrow("synthetic provider load failure");
    expect(vi.getTimerCount(), describePendingFakeTimers()).toBe(0);
  });

  it("aborts pending provider probes when local detection fails", async () => {
    const hook = pendingProbe<ProviderAppGuidedSetupCandidate | null>();
    const detection = detectWithProvider(hook.run, async () => {
      await hook.started;
      throw new Error("synthetic CLI detection failure");
    });
    await expect(detection).rejects.toThrow("synthetic CLI detection failure");
    expect((await hook.started)?.aborted).toBe(true);
    expect(vi.getTimerCount(), describePendingFakeTimers()).toBe(0);
  });
});

describe("setup inference discovery deadline", () => {
  it.each([false, true])(
    "offers registered saved credentials with retry metadata: %s",
    async (retry) => {
      fixture.config.auth = {
        profiles: { "fixture:saved": { provider: "fixture", mode: "api_key" } },
      };
      fixture.loadAuthProfileStore.mockReturnValue(savedStore(retry ? savedSetup() : undefined));
      fixture.withSetupProviderAuthMethod.mockImplementation(async (_params, consume) =>
        consume({ method: { starterModel: "fixture/saved-model" } }),
      );
      const result = await detectWithProvider(async () => null);
      expect(result.candidates).toMatchObject([
        {
          kind: "saved-auth:fixture%3Asaved",
          modelRef: "fixture/saved-model",
          credentials: true,
          recommended: true,
        },
      ]);
    },
  );

  it.each(["saved", "configured", "complete"] as const)(
    "preserves the %s discovery recommendation and settled snapshot",
    async (stage) => {
      const cli = pendingProbe<InferenceBackendCandidate[]>();
      const hook = pendingProbe<ProviderAppGuidedSetupCandidate | null>();
      const detection = detectWithProvider(hook.run, () => cli.run());
      await Promise.all([cli.started, hook.started]);
      const nativeCandidates = [
        nativeCandidate("existing-model", "fixture/configured"),
        nativeCandidate("codex-cli", "openai/model", false),
      ];
      if (stage !== "saved") {
        cli.result.resolve(nativeCandidates);
      }
      if (stage === "complete") {
        hook.result.resolve({ modelRef: "fixture/local" });
      } else {
        await vi.advanceTimersByTimeAsync(30_000);
      }
      const result = await detection;
      expect(result.candidates.filter(({ recommended }) => recommended)).toMatchObject([
        { kind: stage === "saved" ? "saved-auth:fixture%3Asaved" : "existing-model" },
      ]);
      if (stage === "saved") {
        expect(result.candidates.map(({ modelRef }) => modelRef)).toEqual(["fixture/saved-model"]);
      } else {
        expect(result.candidates).toContainEqual(
          expect.objectContaining({ kind: "codex-cli", recommended: false }),
        );
      }
      if (stage === "complete") {
        expect(result.candidates).toContainEqual(
          expect.objectContaining({ kind: "provider-auto:fixture-local", recommended: false }),
        );
      }
      if (stage !== "complete") {
        const settledSnapshot = structuredClone(result);
        cli.result.resolve(nativeCandidates);
        hook.result.resolve({ modelRef: "fixture/local" });
        await vi.advanceTimersByTimeAsync(0);
        expect(result).toEqual(settledSnapshot);
      }
      expect(vi.getTimerCount(), describePendingFakeTimers()).toBe(0);
    },
  );

  it.each(["ready", "deadline"] as const)(
    "waits for the worker's saved credentials before offering local candidates (%s)",
    async (outcome) => {
      const loaded = pendingProbe<AuthProfileStore>();
      fixture.loadAuthProfileStore.mockImplementationOnce(() => loaded.run());
      const settled = vi.fn();
      const detection = detectWithProvider(async () => null, [environmentCandidate]);
      void detection.then(settled, settled);
      await loaded.started;
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).not.toHaveBeenCalled();
      const workerStore = savedStore(
        savedSetup("fixture/worker-model", true),
        "worker",
        "fixture-worker-key",
      );
      if (outcome === "ready") {
        loaded.result.resolve(workerStore);
        const result = await detection;
        expect(result.candidates).toContainEqual(
          expect.objectContaining({ modelRef: "fixture/worker-model", credentials: true }),
        );
      } else {
        await vi.advanceTimersByTimeAsync(30_000);
        const result = await detection;
        expect(result.candidates).toEqual([]);
        const settledSnapshot = structuredClone(result);
        loaded.result.resolve(workerStore);
        await vi.advanceTimersByTimeAsync(0);
        expect(result).toEqual(settledSnapshot);
      }
      expect(vi.getTimerCount(), describePendingFakeTimers()).toBe(0);
    },
  );

  it.each([
    ["unavailable", undefined, false, undefined, false],
    ["another model available", "fixture/other-model", false, undefined, false],
    ["same model available", "fixture/saved-model", true, undefined, false],
    ["disabled", "fixture/saved-model", false, "disabled", false],
    ["unsupported platform", "fixture/saved-model", false, "platform", false],
    ["ordinary sibling", undefined, true, undefined, true],
  ] as const)(
    "gates saved and configured detected-only routes while %s",
    async (_name, modelRef, eligible, unavailable, ordinarySibling) => {
      const detect = vi.fn(async () => (modelRef ? { modelRef } : null));
      const choices: ProviderAuthChoiceMetadata[] = [
        {
          ...choice,
          assistantVisibility: "detected-only",
          ...(unavailable === "platform" ? { platforms: [] } : {}),
        },
      ];
      if (ordinarySibling) {
        choices.push({
          ...choice,
          methodId: "remote",
          choiceId: "fixture-remote",
          appGuidedDiscovery: false,
        });
      }
      const options = {
        choices,
        enablePluginInConfig:
          unavailable === "disabled"
            ? (config: OpenClawConfig) => ({
                config,
                pluginId: "fixture",
                enabled: false,
                reason: "disabled",
              })
            : undefined,
      };
      const hook = pendingProbe<ProviderAppGuidedSetupCandidate | null>();
      const pending = detectWithProvider(
        hook.run,
        [nativeCandidate("existing-model", "fixture/saved-model")],
        options,
      );
      await vi.advanceTimersByTimeAsync(30_000);
      const partial = await pending;
      expect([
        partial.candidates.some(({ kind }) => kind === "existing-model"),
        partial.candidates.some(({ kind }) => kind.startsWith("saved-auth:")),
      ]).toEqual([ordinarySibling, ordinarySibling]);
      const settledSnapshot = structuredClone(partial);
      hook.result.resolve(modelRef ? { modelRef } : null);
      await vi.advanceTimersByTimeAsync(0);
      expect(partial).toEqual(settledSnapshot);
      const result = await detectWithProvider(
        detect,
        [nativeCandidate("existing-model", "fixture/saved-model")],
        options,
      );
      if (!ordinarySibling) {
        expect(result).toMatchObject({ manualProviders: [], prepareOptions: [] });
      }
      expect([
        result.candidates.some(({ kind }) => kind === "existing-model"),
        result.candidates.some(({ kind }) => kind.startsWith("saved-auth:")),
      ]).toEqual([eligible, eligible]);
      expect(result).toMatchObject({ configuredModel: "fixture/saved-model", setupComplete: true });
      if (unavailable) {
        expect(result).toMatchObject({ candidates: [], authOptions: [{ id: "custom-api-key" }] });
        expect(detect).not.toHaveBeenCalled();
      }
    },
  );

  it("returns saved choices and aborts a stalled hook without accepting its late result", async () => {
    const hook = pendingProbe<ProviderAppGuidedSetupCandidate | null>();
    const detection = detectWithProvider(hook.run, [environmentCandidate]);
    const discoverySignal = await hook.started;
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await detection;
    expect(result.candidates).toEqual([
      expect.objectContaining({ modelRef: "fixture/environment-model" }),
      expect.objectContaining({ modelRef: "fixture/saved-model" }),
    ]);
    expect(result.authOptions).toContainEqual(expect.objectContaining({ id: "custom-api-key" }));
    expect(discoverySignal?.aborted).toBe(true);
    hook.result.resolve({ modelRef: "fixture/late-model" });
    await vi.advanceTimersByTimeAsync(0);
    expect(result.candidates).toHaveLength(2);
    expect(vi.getTimerCount(), describePendingFakeTimers()).toBe(0);
  });

  it("keeps manual setup available when loading a saved sign-in stalls", async () => {
    const loading = pendingProbe<never>();
    fixture.loadAuthProfileStore.mockReturnValue(savedStore(undefined));
    fixture.withSetupProviderAuthMethod.mockImplementation(() => loading.run());
    const detection = detectWithProvider(async () => null);
    await loading.started;
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await detection;
    expect(result.candidates).toEqual([]);
    expect(result.authOptions).toContainEqual(expect.objectContaining({ id: "custom-api-key" }));
    expect(vi.getTimerCount(), describePendingFakeTimers()).toBe(0);
  });
});
