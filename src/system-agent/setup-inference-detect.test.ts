import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { InferenceBackendCandidate } from "../commands/onboard-inference-ambient.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderAuthChoiceMetadata } from "../plugins/provider-auth-choices.js";
import type { ProviderAppGuidedSetupCandidate, ProviderPlugin } from "../plugins/types.js";
import type { DetectSetupInferenceDeps, SetupInferenceDetection } from "./setup-inference-core.js";
import { detectSetupInference } from "./setup-inference-detect.js";

const fixture = vi.hoisted(() => ({
  loadAuthProfileStore: vi.fn<() => AuthProfileStore>(),
  withSetupProviderAuthMethod: vi.fn(),
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshotWithPluginMetadata: async () => ({
    snapshot: {
      exists: true,
      valid: true,
      config: {
        agents: {
          entries: { main: { default: true } },
          defaults: { workspace: "/fixture/workspace" },
        },
      },
    },
  }),
}));
vi.mock("../agents/auth-profiles/store-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/auth-profiles/store-runtime.js")>()),
  loadAuthProfileStoreWithoutExternalProfiles: fixture.loadAuthProfileStore,
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
vi.mock("../plugins/enable.js", () => ({
  enablePluginInConfig: (config: OpenClawConfig) => ({ enabled: true, config }),
  enablePluginWithCapabilityConsent: async (config: OpenClawConfig) => ({
    enabled: true,
    config,
  }),
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

function detectWithProvider(
  detect: NonNullable<ProviderPlugin["auth"][number]["appGuidedSetup"]>["detect"],
  nativeCandidates: InferenceBackendCandidate[] = [],
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
      detectInferenceBackends: async () => nativeCandidates,
      probeLocalCommand: async (command) => ({ command, found: false }),
    },
    "main",
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  fixture.loadAuthProfileStore.mockReturnValue({
    version: 1,
    profiles: {
      "fixture:saved": {
        type: "api_key",
        provider: "fixture",
        key: "fixture-key",
        setup: {
          replacement: true,
          modelRef: "fixture/saved-model",
          configJson: "{}",
          authChoice: choice.choiceId,
          pluginId: choice.pluginId,
        },
      },
    },
  });
  fixture.withSetupProviderAuthMethod.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("setup inference discovery deadline", () => {
  it.each([
    { name: "unavailable", modelRef: undefined, eligible: false },
    { name: "another model available", modelRef: "fixture/other-model", eligible: false },
    { name: "same model available", modelRef: "fixture/saved-model", eligible: true },
  ])(
    "gates saved and configured detected-only routes while $name",
    async ({ modelRef, eligible }) => {
      const partials: SetupInferenceDetection[] = [];
      const result = await detectWithProvider(
        async () => (modelRef ? { modelRef } : null),
        [
          {
            kind: "existing-model",
            modelRef: "fixture/saved-model",
            label: "Configured model",
            detail: "Configured",
            credentials: true,
          },
        ],
        {
          choices: [{ ...choice, assistantVisibility: "detected-only" }],
          onPartial: (partial) => partials.push(partial),
        },
      );
      expect(partials.every((partial) => partial.candidates.length === 0)).toBe(true);
      expect(result.candidates.some((candidate) => candidate.kind === "existing-model")).toBe(
        eligible,
      );
      expect(result.candidates.some((candidate) => candidate.kind.startsWith("saved-auth:"))).toBe(
        eligible,
      );
      expect(result).toMatchObject({ configuredModel: "fixture/saved-model", setupComplete: true });
      expect(result.manualProviders).toEqual([]);
      expect(result.prepareOptions).toEqual([]);
    },
  );

  it("does not offer disabled or unsupported detected-only configured routes", async () => {
    const detect = vi.fn(async () => ({ modelRef: "fixture/saved-model" }));
    for (const unavailable of ["disabled", "platform"] as const) {
      const result = await detectWithProvider(
        detect,
        [
          {
            kind: "existing-model",
            modelRef: "fixture/saved-model",
            label: "Configured",
            detail: "Configured",
            credentials: true,
          },
        ],
        {
          choices: [
            {
              ...choice,
              assistantVisibility: "detected-only",
              ...(unavailable === "platform" ? { platforms: [] } : {}),
            },
          ],
          ...(unavailable === "disabled"
            ? {
                enablePluginInConfig: (config) => ({
                  config,
                  pluginId: "fixture",
                  enabled: false,
                  reason: "disabled",
                }),
              }
            : {}),
        },
      );
      expect(result.candidates).toEqual([]);
      expect(result.authOptions.map((option) => option.id)).toEqual(["custom-api-key"]);
      expect(result).toMatchObject({ configuredModel: "fixture/saved-model", setupComplete: true });
    }
    expect(detect).not.toHaveBeenCalled();
  });

  it("preserves ordinary configured routes in a provider with a detected-only sibling", async () => {
    const result = await detectWithProvider(
      async () => null,
      [
        {
          kind: "existing-model",
          modelRef: "fixture/saved-model",
          label: "Configured",
          detail: "Configured",
          credentials: true,
        },
      ],
      {
        choices: [
          { ...choice, assistantVisibility: "detected-only" },
          { ...choice, methodId: "remote", choiceId: "fixture-remote", appGuidedDiscovery: false },
        ],
      },
    );
    expect(result.candidates.some((candidate) => candidate.kind === "existing-model")).toBe(true);
  });
  it("returns saved choices and aborts a stalled hook without accepting its late result", async () => {
    const hookStarted = createDeferred<AbortSignal | undefined>();
    const hookResult = createDeferred<ProviderAppGuidedSetupCandidate | null>();
    const detection = detectWithProvider(
      ({ signal }) => {
        hookStarted.resolve(signal);
        return hookResult.promise;
      },
      [
        {
          kind: "openai-api-key",
          modelRef: "fixture/environment-model",
          label: "Environment sign-in",
          detail: "Available from the environment",
          credentials: true,
        },
      ],
    );
    const discoverySignal = await hookStarted.promise;
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await detection;
    expect(result.candidates).toEqual([
      expect.objectContaining({ modelRef: "fixture/environment-model" }),
      expect.objectContaining({ modelRef: "fixture/saved-model" }),
    ]);
    expect(result.authOptions).toContainEqual(expect.objectContaining({ id: "custom-api-key" }));
    expect(discoverySignal?.aborted).toBe(true);
    hookResult.resolve({ modelRef: "fixture/late-model" });
    await vi.advanceTimersByTimeAsync(0);
    expect(result.candidates).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps manual setup available when loading a saved sign-in stalls", async () => {
    const loading = createDeferred();
    fixture.loadAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "fixture:saved": { type: "api_key", provider: "fixture", key: "fixture-key" },
      },
    });
    fixture.withSetupProviderAuthMethod.mockImplementation(() => {
      loading.resolve();
      return new Promise(() => {});
    });
    const detection = detectWithProvider(async () => null);
    await loading.promise;
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await detection;
    expect(result.candidates).toEqual([]);
    expect(result.authOptions).toContainEqual(expect.objectContaining({ id: "custom-api-key" }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns completed discovery immediately and releases its deadline", async () => {
    const result = await detectWithProvider(async () => ({ modelRef: "fixture/available-model" }));
    expect(result.candidates).toContainEqual(
      expect.objectContaining({ modelRef: "fixture/available-model" }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains a valid choice that needs more than ten seconds to discover", async () => {
    const started = createDeferred();
    const available = createDeferred<ProviderAppGuidedSetupCandidate | null>();
    const detection = detectWithProvider(() => {
      started.resolve();
      return available.promise;
    });
    await started.promise;
    await vi.advanceTimersByTimeAsync(20_000);
    available.resolve({ modelRef: "fixture/slow-model" });
    const result = await detection;
    expect(result.candidates).toContainEqual(
      expect.objectContaining({ modelRef: "fixture/slow-model" }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
