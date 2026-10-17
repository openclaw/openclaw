import { setImmediate } from "node:timers/promises";
import { beforeEach, expect, it, vi } from "vitest";
import { prepareSyntheticLocalProviderAuth as prepareLocalAuth } from "../agents/model-auth-runtime.js";
import type { ModelProviderConfig } from "../config/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { ProviderPlugin } from "./provider-plugin.types.js";

const nativeProvider = vi.hoisted(() => ({
  id: "native-auth",
  label: "Native auth",
  aliases: ["native-alias"],
  auth: [],
  prepareSyntheticAuth: vi.fn<NonNullable<ProviderPlugin["prepareSyntheticAuth"]>>(),
}));

const resolveProviderRuntimePlugin = vi.hoisted(() => vi.fn<() => ProviderPlugin | undefined>());
const resolvePluginDiscoveryProvidersRuntime = vi.hoisted(() =>
  vi.fn<() => ProviderPlugin[]>(() => [
    nativeProvider,
    {
      id: "ollama",
      label: "Ollama",
      auth: [],
      resolveSyntheticAuth: ({
        provider,
        providerConfig,
      }: Parameters<NonNullable<ProviderPlugin["resolveSyntheticAuth"]>>[0]) =>
        providerConfig?.api === "ollama" && providerConfig.baseUrl?.startsWith("http://10.")
          ? {
              apiKey: "ollama-local",
              source: `models.providers.${provider} (synthetic local key)`,
              mode: "api-key" as const,
            }
          : undefined,
    },
  ]),
);

vi.mock("./provider-hook-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./provider-hook-runtime.js")>()),
  resolveProviderRuntimePlugin,
}));

vi.mock("./provider-discovery.runtime.js", () => ({ resolvePluginDiscoveryProvidersRuntime }));

const resolveProviderOwnerIds = vi.hoisted(
  () =>
    ({ provider }: { provider: string }) =>
      provider === "ollama"
        ? ["ollama"]
        : provider === "native-auth" || provider === "native-alias"
          ? ["native-auth"]
          : [],
);

vi.mock("./providers.js", () => ({
  resolveCatalogHookProviderPluginIds: vi.fn(() => []),
  resolveExternalAuthProfileProviderPluginIds: vi.fn(() => []),
  resolveOwningPluginIdsForProvider: resolveProviderOwnerIds,
  resolveOwningPluginIdsForProviderRef: resolveProviderOwnerIds,
}));

import {
  captureProviderSyntheticAuthFacts as captureFacts,
  prepareProviderSyntheticAuthWithPlugin as prepareAuth,
  resolveProviderSyntheticAuthWithPlugin as readAuth,
} from "./provider-runtime.js";
import {
  prepareSyntheticAuthWithProvider as prepareProviderAuth,
  resolveSyntheticAuthWithProvider as readProviderAuth,
  restorePreparedSyntheticAuthFacts as restoreFacts,
} from "./provider-synthetic-auth.js";

function pureProvider(
  resolveSyntheticAuth: NonNullable<ProviderPlugin["resolveSyntheticAuth"]>,
  provider: ProviderPlugin = { id: "config-auth", label: "Config auth", auth: [] },
): ProviderPlugin {
  return { ...provider, prepareSyntheticAuth: undefined, resolveSyntheticAuth };
}

function configuredProvider(id: string, config: ModelProviderConfig) {
  return { models: { providers: { [id]: config } } };
}

const nativeAuth = { apiKey: "native-marker", source: "native auth", mode: "oauth" as const };

function nativeParams(provider = "native-auth") {
  const config = {};
  const context = { config, provider };
  return { config, env: {}, workspaceDir: "/workspace", provider, context };
}

const prepareNativeAuth = nativeProvider.prepareSyntheticAuth;

beforeEach(() => {
  vi.clearAllMocks();
  resolveProviderRuntimePlugin.mockReset();
  resolvePluginDiscoveryProvidersRuntime.mockReset();
  prepareNativeAuth.mockReset().mockResolvedValue(nativeAuth);
});

it("uses the configured provider api as the synthetic-auth hook owner", () => {
  expect(
    readAuth({
      provider: "ollama-remote",
      context: {
        provider: "ollama-remote",
        providerConfig: {
          api: "ollama",
          baseUrl: "http://10.0.0.8:11434",
          models: [],
        },
      },
    }),
  ).toEqual({
    apiKey: "ollama-local",
    source: "models.providers.ollama-remote (synthetic local key)",
    mode: "api-key",
  });
});

it("publishes and reuses native unavailability through runtime wrappers", async () => {
  const params = nativeParams();
  prepareNativeAuth.mockResolvedValue(undefined);
  resolveProviderRuntimePlugin.mockImplementation(() => ({ ...nativeProvider }));
  resolvePluginDiscoveryProvidersRuntime.mockReturnValue([]);
  expect(readAuth(params)).toBeUndefined();
  expect(prepareNativeAuth).not.toHaveBeenCalled();
  expect(await Promise.all([prepareAuth(params), prepareAuth(params)])).toEqual([
    undefined,
    undefined,
  ]);
  expect(await prepareAuth({ ...params, signal: new AbortController().signal })).toBeUndefined();
  expect(readAuth(params)).toBeUndefined();
  expect(prepareNativeAuth).toHaveBeenCalledOnce();
});

it("keeps pure runtime auth ahead of unrelated discovery", async () => {
  const resolveSyntheticAuth = vi.fn(() => nativeAuth);
  resolveProviderRuntimePlugin.mockReturnValue(pureProvider(resolveSyntheticAuth));
  resolvePluginDiscoveryProvidersRuntime.mockImplementation(() => {
    throw new Error("Unrelated provider discovery must stay lazy");
  });
  expect(await prepareLocalAuth({ cfg: {}, provider: "config-auth" })).toEqual(nativeAuth);
  expect(resolveSyntheticAuth).toHaveBeenCalledOnce();
});

it("limits direct auth lookup to non-secret synthetic markers", async () => {
  const marker = {
    apiKey: "custom-local",
    source: "configured headers",
    mode: "api-key" as const,
  };
  const blockedConfig = configuredProvider("config-auth", {
    apiKey: { source: "env", provider: "default", id: "MISSING_KEY" },
    baseUrl: "https://fixture.example/v1",
    models: [],
  });
  for (const [result, cfg, expected] of [
    [marker, {}, marker],
    [{ ...marker, apiKey: "fixture-real-key" }, {}, null],
    [{ ...marker, apiKey: "secretref-env:FIXTURE_KEY" }, {}, null],
    [{ ...marker, mode: "oauth" as const }, {}, null],
    [{ ...marker, nativeAuth: { runtime: "fixture", mode: "api-key" as const } }, {}, null],
    [marker, blockedConfig, null],
  ] as const) {
    resolveProviderRuntimePlugin.mockReturnValue(pureProvider(() => result));
    resolvePluginDiscoveryProvidersRuntime.mockReturnValue([]);
    expect(
      await prepareLocalAuth({ cfg, provider: "config-auth", allowPluginSyntheticAuth: false }),
    ).toEqual(expected);
  }
});

it("reuses a prepared non-secret marker without starting external auth", async () => {
  const params = nativeParams();
  const marker = { apiKey: "custom-local", source: "prepared headers", mode: "api-key" as const };
  prepareNativeAuth.mockResolvedValue(marker);
  const { config: cfg, provider, env, workspaceDir } = params;
  const directParams = { cfg, provider, env, workspaceDir, allowPluginSyntheticAuth: false };
  expect(await prepareLocalAuth(directParams)).toBeNull();
  expect(prepareNativeAuth).not.toHaveBeenCalled();

  await prepareAuth(params);
  expect(await prepareLocalAuth(directParams)).toEqual(marker);
  expect(prepareNativeAuth).toHaveBeenCalledOnce();
});

it.each(["config", "env", "workspace", "provider generation"])(
  "does not reuse native facts across a changed %s",
  async (changed) => {
    const params = nativeParams();
    await prepareAuth(params);
    prepareNativeAuth.mockResolvedValue(undefined);
    const replacement =
      changed === "provider generation"
        ? { ...nativeProvider, prepareSyntheticAuth: vi.fn(async () => undefined) }
        : nativeProvider;
    const next = {
      ...params,
      ...(changed === "config" ? { config: {} } : {}),
      ...(changed === "env" ? { env: {} } : {}),
      ...(changed === "workspace" ? { workspaceDir: "/other-workspace" } : {}),
    };
    const context = { config: next.config, provider: next.provider };
    expect(readProviderAuth(replacement, context, next)).toBeUndefined();
    expect(await prepareProviderAuth(replacement, context, next)).toBeUndefined();
    expect(replacement.prepareSyntheticAuth).toHaveBeenCalledTimes(
      changed === "provider generation" ? 1 : 2,
    );
    expect(readAuth(params)).toEqual(nativeAuth);
  },
);

it("joins each cancellation scope without cancelling or evicting another probe", async () => {
  const started = createDeferredCore();
  const cleanup = createDeferredCore();
  const available = createDeferredCore();
  const controller = new AbortController();
  const otherController = new AbortController();
  const reason = new Error("native preparation cancelled");
  prepareNativeAuth
    .mockImplementationOnce(async ({ signal }) => {
      started.resolve(undefined);
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      await cleanup.promise;
    })
    .mockImplementationOnce(async () => {
      await available.promise;
      return nativeAuth;
    });
  const params = nativeParams();
  let settled = false;
  const pending = prepareAuth({ ...params, signal: controller.signal }).finally(() => {
    settled = true;
  });
  const rejected = expect(pending).rejects.toBe(reason);
  await started.promise;
  const otherParams = { ...params, signal: otherController.signal };
  const active = prepareAuth(otherParams);
  const activeResult = Promise.allSettled([active]);
  const calls = [pending, active];
  try {
    controller.abort(reason);
    await setImmediate();
    expect(settled).toBe(false);
    cleanup.resolve(undefined);
    await rejected;
    expect(readAuth(params)).toBeUndefined();

    const follower = prepareAuth(otherParams);
    calls.push(follower);
    const followerResult = Promise.allSettled([follower]);
    available.resolve(undefined);
    expect(await activeResult).toEqual([{ status: "fulfilled", value: nativeAuth }]);
    expect(await followerResult).toEqual([{ status: "fulfilled", value: nativeAuth }]);
    expect(readAuth(params)).toEqual(nativeAuth);
    expect(prepareNativeAuth).toHaveBeenCalledTimes(2);
  } finally {
    controller.abort();
    otherController.abort();
    cleanup.resolve(undefined);
    available.resolve(undefined);
    await Promise.allSettled(calls);
  }
});

it("captures fresh known-empty facts and keeps restored workers closed to probing", async () => {
  const params = nativeParams();
  const capture = () => captureFacts({ ...params, providerRefs: ["native-auth"] });
  expect((await capture())[0]?.result).toEqual(nativeAuth);
  prepareNativeAuth.mockResolvedValue(undefined);
  const unavailable = await capture();
  expect(unavailable[0]?.result).toBeNull();
  expect(prepareNativeAuth).toHaveBeenCalledTimes(2);

  const worker = nativeParams();
  restoreFacts(worker.config, unavailable, worker);
  expect([await prepareAuth(worker), readAuth(worker)]).toEqual([undefined, undefined]);
  await expect(
    prepareAuth({
      ...worker,
      provider: "native-alias",
      context: { config: worker.config, provider: "native-alias" },
    }),
  ).rejects.toThrow("Prepared synthetic auth is missing");
  await expect(prepareAuth({ ...worker, env: {} })).rejects.toThrow(
    "environment or workspace does not match",
  );
  expect(prepareNativeAuth).toHaveBeenCalledTimes(2);
});

it.each([nativeAuth, undefined])(
  "reads captured alias outcomes before reopening worker discovery: %j",
  async (result) => {
    prepareNativeAuth.mockResolvedValue(result);
    const facts = await captureFacts({ ...nativeParams(), providerRefs: ["native-alias"] });
    const worker = nativeParams("native-alias");
    restoreFacts(worker.config, facts, worker);
    const workerHook = vi.fn(() => ({ ...nativeAuth, apiKey: "unexpected-worker-probe" }));
    const workerProvider = pureProvider(workerHook, nativeProvider);
    resolvePluginDiscoveryProvidersRuntime.mockClear().mockReturnValue([workerProvider]);
    expect(readAuth(worker)).toEqual(result);
    expect(await prepareAuth(worker)).toEqual(result);
    expect(readProviderAuth(workerProvider, worker.context, worker)).toEqual(result);
    expect(resolvePluginDiscoveryProvidersRuntime).not.toHaveBeenCalled();
    expect(workerHook).not.toHaveBeenCalled();
  },
);

it("captures the canonical pure result when it precedes an async alias fallback", async () => {
  const config = configuredProvider("custom-native", {
    api: "ollama",
    baseUrl: "http://localhost",
    models: [],
  });
  const resolveSyntheticAuth = vi.fn(() => nativeAuth);
  resolveProviderRuntimePlugin
    .mockReturnValueOnce(pureProvider(resolveSyntheticAuth, nativeProvider))
    .mockReturnValueOnce({ ...nativeProvider, id: "ollama" });
  resolvePluginDiscoveryProvidersRuntime.mockReturnValue([]);
  expect(await captureFacts({ config, providerRefs: ["custom-native"] })).toEqual([
    { providerRef: "custom-native", result: nativeAuth },
  ]);
  expect(resolveSyntheticAuth).toHaveBeenCalledOnce();
  expect(prepareNativeAuth).not.toHaveBeenCalled();
});
