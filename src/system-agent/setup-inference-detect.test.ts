import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describePendingFakeTimers } from "../../test/helpers/fake-timer-diagnostics.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { AuthProfileStore, SavedSetupCredential } from "../agents/auth-profiles/types.js";
import type { InferenceBackendCandidate } from "../commands/onboard-inference-ambient.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderAuthChoiceMetadata } from "../plugins/provider-auth-choices.js";
import type { ProviderAppGuidedSetupCandidate, ProviderPlugin } from "../plugins/types.js";
import type { DetectSetupInferenceDeps, SetupInferenceDetection } from "./setup-inference-core.js";
import { detectSetupInference } from "./setup-inference-detect.js";

const fixture = vi.hoisted(() => ({
  config: {} as OpenClawConfig,
  loadAuthProfileStore: vi.fn<() => AuthProfileStore | Promise<AuthProfileStore>>(),
  withSetupProviderAuthMethod: vi.fn(),
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
vi.mock("../plugins/enable.js", () => ({
  enablePluginInConfig: (config: OpenClawConfig) => ({ enabled: true, config }),
  enablePluginWithCapabilityConsent: async (config: OpenClawConfig) => ({ enabled: true, config }),
}));
vi.mock("../plugins/plugin-lifecycle-lease.js", () => ({
  withPluginLifecycleLease: async (_options: unknown, run: () => Promise<unknown>) => await run(),
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
  nativeCandidates:
    | InferenceBackendCandidate[]
    | NonNullable<DetectSetupInferenceDeps["detectInferenceBackends"]> = [],
  options: Pick<DetectSetupInferenceDeps, "onPartial" | "enablePluginInConfig"> & {
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
  return detectSetupInference(
    {
      ...options,
      resolveManifestProviderAuthChoices: () => options.choices ?? [choice],
      resolvePluginProviders: () => [provider],
      detectInferenceBackends:
        typeof nativeCandidates === "function" ? nativeCandidates : async () => nativeCandidates,
    },
    "main",
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  fixture.config = {
    agents: { entries: { main: {} }, defaults: { workspace: "/fixture/workspace" } },
  };
  fixture.loadAuthProfileStore.mockReturnValue(savedStore(savedSetup(undefined, true)));
  fixture.withSetupProviderAuthMethod.mockReset();
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
  it("probes provider services during CLI detection and publishes local results first", async () => {
    const cli = pendingProbe<InferenceBackendCandidate[]>();
    const hook = pendingProbe<ProviderAppGuidedSetupCandidate | null>();
    const localPublished = createDeferred<SetupInferenceDetection>();
    const detection = detectWithProvider(hook.run, () => cli.run(), {
      onPartial: (partial) => {
        if (partial.candidates.some(({ modelRef }) => modelRef === environmentCandidate.modelRef)) {
          localPublished.resolve(partial);
        }
      },
    });
    // Serial discovery cannot start the provider probe while CLI detection is pending.
    await Promise.all([cli.started, hook.started]);
    cli.result.resolve([environmentCandidate]);
    expect((await localPublished.promise).candidates.map(({ modelRef }) => modelRef)).toEqual([
      "fixture/environment-model",
      "fixture/saved-model",
    ]);
    hook.result.resolve({ modelRef: "fixture/local-model" });
    expect((await detection).candidates.map(({ modelRef }) => modelRef)).toEqual([
      "fixture/environment-model",
      "fixture/saved-model",
      "fixture/local-model",
    ]);
    expect(vi.getTimerCount(), describePendingFakeTimers()).toBe(0);
  });

  it("reports a provider discovery failure without waiting for CLI detection", async () => {
    const detection = detectSetupInference(
      {
        resolveManifestProviderAuthChoices: () => [choice],
        resolvePluginProviders: () => {
          throw new Error("synthetic provider load failure");
        },
        detectInferenceBackends: () => new Promise(() => {}),
      },
      "main",
    );
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

  it("recomputes the recommendation for partial and final detection without changing older results", async () => {
    const partials: SetupInferenceDetection[] = [];
    const result = await detectWithProvider(
      async () => ({ modelRef: "fixture/local" }),
      [
        nativeCandidate("existing-model", "fixture/configured"),
        nativeCandidate("codex-cli", "openai/model", false),
      ],
      { onPartial: (partial) => partials.push(partial) },
    );

    expect(partials[0]?.candidates.filter(({ recommended }) => recommended)).toMatchObject([
      { kind: "saved-auth:fixture%3Asaved" },
    ]);
    for (const detection of [...partials.slice(1), result]) {
      expect(detection.candidates.filter(({ recommended }) => recommended)).toMatchObject([
        { kind: "existing-model" },
      ]);
      expect(detection.candidates).toContainEqual(
        expect.objectContaining({ kind: "codex-cli", recommended: false }),
      );
    }
    expect(result.candidates).toContainEqual(
      expect.objectContaining({ kind: "provider-auto:fixture-local", recommended: false }),
    );
  });

  it("waits for the worker's saved credentials before publishing candidates", async () => {
    const loaded = pendingProbe<AuthProfileStore>();
    fixture.loadAuthProfileStore.mockImplementationOnce(() => loaded.run());
    const onPartial = vi.fn();
    const detection = detectWithProvider(async () => null, [], { onPartial });
    await loaded.started;
    expect(onPartial).not.toHaveBeenCalled();
    loaded.result.resolve(
      savedStore(savedSetup("fixture/worker-model", true), "worker", "fixture-worker-key"),
    );
    const result = await detection;
    expect(result.candidates).toContainEqual(
      expect.objectContaining({ modelRef: "fixture/worker-model", credentials: true }),
    );
  });

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
      const partials: SetupInferenceDetection[] = [];
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
      const result = await detectWithProvider(
        detect,
        [nativeCandidate("existing-model", "fixture/saved-model")],
        {
          choices,
          onPartial: (partial) => partials.push(partial),
          enablePluginInConfig:
            unavailable === "disabled"
              ? (config) => ({ config, pluginId: "fixture", enabled: false, reason: "disabled" })
              : undefined,
        },
      );
      if (!ordinarySibling) {
        expect(partials.every((partial) => partial.candidates.length === 0)).toBe(true);
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
