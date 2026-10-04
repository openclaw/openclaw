import type { ModelCatalogProvider } from "@openclaw/model-catalog-core/model-catalog-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  captureProviderCatalogExpiries,
  recordLiveCatalogExpiry,
  withProviderCatalogExpiry,
} from "../plugins/provider-catalog-expiry.js";
import {
  applyProviderNativeStreamingUsageCompat,
  buildManifestModelProviderConfig,
  clearLiveCatalogCacheForTests,
  getCachedLiveCatalogValue,
  readConfiguredProviderCatalogEntries,
  readManifestProviderDefaultModelRef,
} from "./provider-catalog-shared.js";
import type { ModelDefinitionConfig } from "./provider-model-shared.js";

function buildModel(id: string, supportsUsageInStreaming?: boolean): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1024,
    maxTokens: 1024,
    ...(supportsUsageInStreaming === undefined ? {} : { compat: { supportsUsageInStreaming } }),
  };
}

describe("provider-catalog-shared live catalog cache", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });

  it("does not admit a cancelled catalog consumer", async () => {
    const reason = new Error("catalog owner closed");
    const load = vi.fn(async () => "unexpected");
    await expect(
      getCachedLiveCatalogValue({
        keyParts: ["cancelled"],
        load,
        signal: AbortSignal.abort(reason),
      }),
    ).rejects.toBe(reason);
    expect(load).not.toHaveBeenCalled();
  });

  it.each([
    { survivor: true, reason: new Error("first consumer closed") },
    { survivor: true, reason: { source: "catalog closed" } },
    { survivor: false, reason: new Error("last consumer left") },
    { survivor: false, reason: { source: "catalog closed" } },
  ])(
    "cancels a consumer without retaining abandoned work (survivor=$survivor, $reason)",
    async ({ survivor, reason }) => {
      const controller = new AbortController();
      const completion = createDeferred<string>();
      const started = createDeferred<AbortSignal | undefined>();
      const keyParts = ["shared"];
      const load = vi.fn((signal?: AbortSignal) => {
        started.resolve(signal);
        return completion.promise;
      });
      const first = getCachedLiveCatalogValue({ keyParts, load, signal: controller.signal });
      const second = survivor ? getCachedLiveCatalogValue({ keyParts, load }) : undefined;
      const acquisitionSignal = await started.promise;
      controller.abort(reason);
      expect(acquisitionSignal?.aborted).toBe(!survivor);
      if (!survivor) {
        expect(acquisitionSignal?.reason).toBe(reason);
      } else {
        await expect(first).rejects.toBe(reason);
      }
      completion.resolve("shared catalog");
      await expect(first).rejects.toBe(reason);
      if (second) {
        await expect(second).resolves.toBe("shared catalog");
      } else {
        const reload = vi.fn(async () => "replacement");
        await expect(getCachedLiveCatalogValue({ keyParts, load: reload })).resolves.toBe(
          "replacement",
        );
        expect(reload).toHaveBeenCalledOnce();
      }
      expect(load).toHaveBeenCalledOnce();
    },
  );

  it("allows unrelated catalogs while abandoned loads remain unsettled", async () => {
    const completion = createDeferred<string>();
    const controllers = Array.from({ length: 99 }, () => new AbortController());
    const signals: AbortSignal[] = [];
    const load = (signal?: AbortSignal) => {
      if (signal) {
        signals.push(signal);
      }
      return completion.promise;
    };
    const pending = controllers.map((controller, index) =>
      getCachedLiveCatalogValue({
        keyParts: ["pending"],
        load,
        signal: controller.signal,
        ttlMs: 1,
        now: () => index * 2,
      }),
    );
    const retained = getCachedLiveCatalogValue({
      keyParts: ["pending"],
      load,
      ttlMs: 1,
      now: () => 198,
    });
    try {
      controllers.forEach((controller) => controller.abort(new Error("observer closed")));
      await Promise.allSettled(pending);
      expect(signals.filter((signal) => signal.aborted)).toHaveLength(99);
      await expect(
        getCachedLiveCatalogValue({ keyParts: ["overflow"], load: async () => "ready" }),
      ).resolves.toBe("ready");
      expect(signals.at(-1)?.aborted).toBe(false);
    } finally {
      completion.resolve("settled");
      await Promise.allSettled([...pending, retained]);
    }
  });

  it("preserves consumers when pending entries are evicted without rewarming them", async () => {
    const controller = new AbortController();
    const completion = createDeferred<string>();
    const signals: AbortSignal[] = [];
    const load = (signal?: AbortSignal) => {
      if (signal) {
        signals.push(signal);
      }
      return completion.promise;
    };
    const keyParts = ["evicted", 0];
    const first = getCachedLiveCatalogValue({ keyParts, load, signal: controller.signal });
    const survivor = getCachedLiveCatalogValue({ keyParts, load });
    const pending = Array.from({ length: 99 }, (_, index) =>
      getCachedLiveCatalogValue({ keyParts: ["evicted", index + 1], load }),
    );
    const settled = Promise.allSettled([first, survivor, ...pending]);
    try {
      await expect(
        getCachedLiveCatalogValue({ keyParts: ["overflow"], load: async () => "ready" }),
      ).resolves.toBe("ready");
      const reason = new Error("evicted consumer closed");
      controller.abort(reason);
      await expect(first).rejects.toBe(reason);
      expect(signals).toHaveLength(100);
      expect(signals.every((signal) => !signal.aborted)).toBe(true);
      completion.resolve("original");
      await expect(survivor).resolves.toBe("original");
      await settled;
      await expect(
        getCachedLiveCatalogValue({ keyParts, load: async () => "replacement" }),
      ).resolves.toBe("replacement");
    } finally {
      completion.resolve("original");
      controller.abort();
      await settled;
    }
  });

  it("replaces an abandoned load before physical settlement without losing the replacement", async () => {
    const controller = new AbortController();
    const completion = createDeferred<string>();
    const load = vi.fn(() => completion.promise);
    const keyParts = ["cancelled-shared"];
    const first = getCachedLiveCatalogValue({ keyParts, load, signal: controller.signal });
    const reason = new Error("last consumer left");
    try {
      controller.abort(reason);
      const replacementLoad = vi.fn(async () => "replacement");
      const replacement = getCachedLiveCatalogValue({ keyParts, load: replacementLoad });
      const startedBeforeSettlement = replacementLoad.mock.calls.length;
      completion.resolve("abandoned result");
      await Promise.allSettled([first, replacement]);
      await expect(first).rejects.toBe(reason);
      expect(startedBeforeSettlement).toBe(1);
      await expect(replacement).resolves.toBe("replacement");
      expect(load).toHaveBeenCalledOnce();
      await expect(getCachedLiveCatalogValue({ keyParts, load })).resolves.toBe("replacement");
      expect(load).toHaveBeenCalledOnce();
    } finally {
      completion.resolve("abandoned result");
      await Promise.allSettled([first, completion.promise]);
    }
  });

  it.each([undefined, 64_000])(
    "retains slow successful catalogs without extending absolute expiry %s",
    async (absoluteExpiry) => {
      let now = 1_000;
      const pending = createDeferred<string>();
      const load = vi.fn(() => pending.promise);
      const read = () =>
        captureProviderCatalogExpiries(() =>
          withProviderCatalogExpiry(
            async () => {
              if (absoluteExpiry !== undefined) {
                recordLiveCatalogExpiry(absoluteExpiry);
              }
              return getCachedLiveCatalogValue({
                keyParts: ["slow-provider", absoluteExpiry],
                load,
                now: () => now,
              });
            },
            () => ["fixture"],
          ),
        );

      const first = read();
      now = 63_600;
      pending.resolve("usable");
      const completed = await first;
      expect(completed.value).toBe("usable");
      const expectedExpiry = absoluteExpiry ?? 93_600;
      expect(completed.providerExpiries.get("fixture")).toBe(expectedExpiry);

      now = 63_800;
      const cached = await read();
      expect(cached.value).toBe("usable");
      expect(cached.providerExpiries.get("fixture")).toBe(expectedExpiry);
      expect(load).toHaveBeenCalledOnce();

      now = 93_600;
      await read();
      expect(load).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["resolve", "reject", "throw", "overflow"] as const)(
    "bypasses a warm cache without modifying it when the uncached loader will %s",
    async (outcome) => {
      const keyParts = ["provider", "models"];
      await getCachedLiveCatalogValue({ keyParts, load: async () => "cached" });
      const controller = new AbortController();
      const error = new Error("uncached failure");
      let calls = 0;
      const load = vi.fn((signal?: AbortSignal) => {
        expect(signal).toBe(controller.signal);
        if (outcome === "throw") {
          throw error;
        }
        return outcome === "reject"
          ? Promise.reject(error)
          : Promise.resolve(
              outcome === "overflow" ? (++calls === 1 ? "first" : "second") : "fresh",
            );
      });
      const shouldCache = vi.fn(() => false);
      const reads = outcome === "overflow" ? 2 : 1;
      for (let index = 0; index < reads; index++) {
        const fresh = getCachedLiveCatalogValue({
          keyParts,
          load,
          shouldCache,
          signal: controller.signal,
          ttlMs: outcome === "overflow" ? 1 : 0,
          ...(outcome === "overflow" ? { now: () => 8_640_000_000_000_000 } : {}),
        });
        if (outcome === "reject" || outcome === "throw") {
          await expect(fresh).rejects.toBe(error);
        } else {
          await expect(fresh).resolves.toBe(
            outcome === "overflow" ? (index === 0 ? "first" : "second") : "fresh",
          );
        }
      }
      expect(shouldCache).not.toHaveBeenCalled();
      await expect(getCachedLiveCatalogValue({ keyParts, load })).resolves.toBe("cached");
      expect(load).toHaveBeenCalledTimes(reads);
    },
  );

  it.each(["resolve", "reject", "predicate-false", "predicate-throw", "same-promise"] as const)(
    "preserves a replacement cache entry after expired work finishes with %s",
    async (outcome) => {
      let now = 1_000;
      const keyParts = ["provider", "models"];
      const pending = createDeferred<string>();
      const error = new Error("expired failure");
      const first = getCachedLiveCatalogValue({
        keyParts,
        load: () => pending.promise,
        ttlMs: 100,
        now: () => now,
        shouldCache: () => {
          if (outcome === "predicate-throw") {
            throw error;
          }
          return outcome === "resolve";
        },
      });
      now = 1_101;
      const replacement = getCachedLiveCatalogValue({
        keyParts,
        load: () => (outcome === "same-promise" ? pending.promise : Promise.resolve("replacement")),
        ttlMs: 100,
        now: () => now,
      });
      if (outcome === "reject") {
        pending.reject(error);
      } else {
        pending.resolve("expired");
      }
      if (outcome === "reject" || outcome === "predicate-throw") {
        await expect(first).rejects.toBe(error);
      } else {
        await expect(first).resolves.toBe("expired");
      }
      const expected = outcome === "same-promise" ? "expired" : "replacement";
      await expect(replacement).resolves.toBe(expected);
      const load = vi.fn(async () => "unnecessary reload");
      await expect(getCachedLiveCatalogValue({ keyParts, load, now: () => now })).resolves.toBe(
        expected,
      );
      expect(load).not.toHaveBeenCalled();
    },
  );
});

describe("provider-catalog-shared native streaming usage compat", () => {
  it.each([
    ["custom-qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1", true],
    ["custom-kimi", "https://api.moonshot.ai/v1", true],
    ["custom-proxy", "https://proxy.example.com/v1", undefined],
  ] as const)(
    "applies %s endpoint capabilities while preserving overrides",
    (providerId, baseUrl, expected) => {
      const provider = applyProviderNativeStreamingUsageCompat({
        providerId,
        providerConfig: {
          api: "openai-completions",
          baseUrl,
          models: [buildModel("default"), buildModel("override", false)],
        },
      });
      expect(provider.models[0]?.compat?.supportsUsageInStreaming).toBe(expected);
      expect(provider.models[1]?.compat?.supportsUsageInStreaming).toBe(false);
    },
  );
});

describe("provider-catalog-shared configured catalog entries", () => {
  it.each([
    { providerId: "google", prefix: "", input: ["text", "image"] },
    { providerId: "kilocode", prefix: "google/", input: ["text", "image", "video", "audio"] },
  ] satisfies Array<{ providerId: string; prefix: string; input: ModelDefinitionConfig["input"] }>)(
    "normalizes $providerId Gemini ids while preserving configured modalities",
    ({ providerId, prefix, input }) => {
      expect(
        readConfiguredProviderCatalogEntries({
          providerId,
          config: {
            models: {
              providers: {
                [providerId]: {
                  baseUrl: "https://catalog.example/v1",
                  models: [
                    {
                      ...buildModel(`${prefix}gemini-3-pro-preview`),
                      name: "Gemini 3 Pro Preview",
                      input,
                      reasoning: true,
                      contextWindow: 1048576,
                      maxTokens: 65536,
                    },
                  ],
                },
              },
            },
          },
        }),
      ).toEqual([
        {
          provider: providerId,
          id: `${prefix}gemini-3.1-pro-preview`,
          name: "Gemini 3 Pro Preview",
          input,
          reasoning: true,
          contextWindow: 1048576,
        },
      ]);
    },
  );
});

describe("provider-catalog-shared manifest provider configs", () => {
  it.each([false, true])(
    "converts manifest rows and normalizes retired ids (retired=%s)",
    (retired) => {
      const model: ModelCatalogProvider["models"][number] = retired
        ? {
            id: "google/gemini-3-pro-preview",
            name: "Gemini 3 Pro Preview",
            input: ["text", "image"],
            reasoning: true,
            contextWindow: 1_048_576,
            maxTokens: 65_536,
          }
        : {
            id: "example-model",
            name: "Example Model",
            input: ["text", "image"],
            reasoning: true,
            contextWindow: 128_000,
            contextTokens: 64_000,
            contextWindows: [{ id: "128k", label: "128K", contextWindow: 128000 }],
            contextWindowDefault: "128k",
            maxTokens: 8192,
            thinkingLevelMap: { off: null, minimal: "low", max: "max" },
            mediaInput: { image: { maxSidePx: 2048, preferredSidePx: 1024, tokenMode: "detail" } },
            cost: {
              input: 1,
              output: 2,
              cacheRead: 0.25,
              cacheWrite: 0.5,
              tieredPricing: [
                { input: 0.5, output: 1, cacheRead: 0.1, cacheWrite: 0.2, range: [0, 1_000_000] },
              ],
            },
            compat: { supportsUsageInStreaming: true },
          };
      const providerId = retired ? "kilocode" : "example";
      const catalog: ModelCatalogProvider = {
        baseUrl: retired ? "https://api.kilo.ai/api/gateway/" : "https://api.example.test/v1",
        api: "openai-completions",
        ...(retired
          ? {}
          : { defaultModel: " example-model ", headers: { "x-provider": "example" } }),
        models: [model],
      };
      expect(buildManifestModelProviderConfig({ providerId, catalog })).toEqual({
        baseUrl: catalog.baseUrl,
        api: "openai-completions",
        ...(retired ? {} : { headers: { "x-provider": "example" } }),
        models: [
          {
            ...model,
            id: retired ? "google/gemini-3.1-pro-preview" : "example-model",
            cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      });
      if (!retired) {
        expect(
          readManifestProviderDefaultModelRef(
            { modelCatalog: { providers: { example: catalog } } },
            "example",
          ),
        ).toBe("example/example-model");
      }
    },
  );

  it.each([
    {
      catalog: {
        baseUrl: "https://api.example.test/v1",
        models: [{ id: "missing-context", maxTokens: 8192 }],
      },
      error: "missing contextWindow",
    },
    {
      catalog: { models: [{ id: "missing-base-url", contextWindow: 1024, maxTokens: 1024 }] },
      error: "providers.example.baseUrl",
    },
    {
      catalog: {
        baseUrl: "https://api.example.test/v1",
        models: [
          { id: "document-model", input: ["document"], contextWindow: 1024, maxTokens: 1024 },
        ],
      },
      error: "unsupported runtime input document",
    },
    {
      catalog: {
        baseUrl: "https://api.example.test/v1",
        models: [buildModel("valid"), buildModel("")],
      },
      error: "providers.example.models",
    },
  ])("rejects invalid manifest catalog: $error", ({ catalog, error }) => {
    expect(() => buildManifestModelProviderConfig({ providerId: "example", catalog })).toThrow(
      error,
    );
  });
});
