import type { ModelCatalogProvider } from "@openclaw/model-catalog-core/model-catalog-types";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  captureProviderCatalogExpiries as capture,
  recordLiveCatalogExpiry,
  withProviderCatalogExpiry as withExpiry,
} from "../plugins/provider-catalog-expiry.js";
import { getLiveCatalogRetainedData } from "../plugins/provider-live-catalog-cache.js";
import {
  applyProviderNativeStreamingUsageCompat,
  buildManifestModelProviderConfig as buildManifest,
  clearLiveCatalogCacheForTests,
  getCachedLiveCatalogValue,
  readConfiguredProviderCatalogEntries as readConfigured,
  readManifestProviderDefaultModelRef as readDefaultModel,
} from "./provider-catalog-shared.js";
import { buildCatalogModel, catalogFixture } from "./provider-catalog.test-support.js";
import type { ModelDefinitionConfig } from "./provider-model-shared.js";

function buildModel(id: string, supportsUsageInStreaming?: boolean): ModelDefinitionConfig {
  return buildCatalogModel(id, {
    contextWindow: 1024,
    maxTokens: 1024,
    ...(supportsUsageInStreaming === undefined ? {} : { compat: { supportsUsageInStreaming } }),
  });
}

function expectRetained(sourceEntries: number, requests: number, populated = false) {
  expect(getLiveCatalogRetainedData()).toEqual([
    {
      structure: "catalog-source",
      entries: sourceEntries,
      approximateBytes: populated ? 50 : 0,
      stringBytes: populated ? 26 : 0,
      objects: populated ? 1 : 0,
      truncated: false,
    },
    { structure: "catalog-request", entries: requests, approximateBytes: 0 },
  ]);
}

function cache<T>(
  keyParts: readonly unknown[],
  load: (signal?: AbortSignal) => Promise<T>,
  options: Omit<Parameters<typeof getCachedLiveCatalogValue<T>>[0], "keyParts" | "load"> = {},
) {
  return getCachedLiveCatalogValue({ keyParts, load, ...options });
}

beforeEach(() => clearLiveCatalogCacheForTests());

it("reports only cache sizes across pending, shared-value, and cleared states", async () => {
  const completion = createDeferred<string[]>();
  const load = vi.fn(() => completion.promise);
  const first = cache(["PRIVATE_CACHE_KEY"], load);
  const joined = cache(["PRIVATE_CACHE_KEY"], load);
  expectRetained(0, 1);

  const payload = ["PRIVATE_MODEL"];
  completion.resolve(payload);
  expect(await first).toBe(payload);
  expect(await joined).toBe(payload);
  expect(load).toHaveBeenCalledOnce();
  await cache(["ANOTHER_PRIVATE_KEY"], async () => payload);
  // Both entries retain one array: array + slot + UTF-16 string.
  expectRetained(2, 0, true);
  clearLiveCatalogCacheForTests();
  expectRetained(0, 0);
});

it("samples cached plugin data without invoking proxy traps or custom iterators", async () => {
  const executePlugin = vi.fn(() => {
    throw new Error("diagnostics invoked plugin behavior");
  });
  const opaque = new Proxy({}, { ownKeys: executePlugin });
  const collections = [new Map<string, string>(), new Set<string>(), ["model"]].map((value) =>
    Object.defineProperty(value, Symbol.iterator, { value: executePlugin }),
  );
  const payload = { opaque, collections };
  await expect(cache(["opaque-plugin-data"], async () => payload)).resolves.toBe(payload);
  expect(getLiveCatalogRetainedData()[0]).toMatchObject({
    structure: "catalog-source",
    entries: 1,
    truncated: true,
  });
  expect(executePlugin).not.toHaveBeenCalled();
});

it("does not admit a cancelled catalog consumer", async () => {
  const reason = new Error("catalog owner closed");
  const load = vi.fn(async () => "unexpected");
  const result = cache(["cancelled"], load, { signal: AbortSignal.abort(reason) });
  await expect(result).rejects.toBe(reason);
  expect(load).not.toHaveBeenCalled();
});

it("allows unrelated catalogs while abandoned loads remain unsettled", async () => {
  const completion = createDeferred<string>();
  const controllers = Array.from({ length: 99 }, () => new AbortController());
  const load = vi.fn(() => completion.promise);
  const pending = controllers.map((controller, index) =>
    cache(["pending"], load, {
      signal: controller.signal,
      ttlMs: 1,
      now: () => index * 2,
    }),
  );
  const retained = cache(["pending"], load, {
    ttlMs: 1,
    now: () => 198,
  });
  try {
    controllers.forEach((controller) => controller.abort(new Error("observer closed")));
    await Promise.allSettled(pending);
    expect(load).toHaveBeenCalledTimes(100);
    await expect(cache(["overflow"], async () => "ready")).resolves.toBe("ready");
  } finally {
    completion.resolve("settled");
    await Promise.allSettled([...pending, retained]);
  }
});

it("preserves consumers when pending entries are evicted without rewarming them", async () => {
  const controller = new AbortController();
  const completion = createDeferred<string>();
  const load = vi.fn(() => completion.promise);
  const keyParts = ["evicted", 0];
  const first = cache(keyParts, load, { signal: controller.signal });
  const survivor = cache(keyParts, load);
  const pending = Array.from({ length: 99 }, (_, index) => cache(["evicted", index + 1], load));
  const settled = Promise.allSettled([first, survivor, ...pending]);
  try {
    await expect(cache(["overflow"], async () => "ready")).resolves.toBe("ready");
    const reason = new Error("evicted consumer closed");
    controller.abort(reason);
    await expect(first).rejects.toBe(reason);
    expect(load).toHaveBeenCalledTimes(100);
    completion.resolve("original");
    await expect(survivor).resolves.toBe("original");
    await settled;
    await expect(cache(keyParts, async () => "replacement")).resolves.toBe("replacement");
  } finally {
    completion.resolve("original");
    controller.abort();
    await settled;
  }
});

it("retains slow successful catalogs without extending absolute expiry", async () => {
  const absoluteExpiry = 64_000;
  let now = 1_000;
  const pending = createDeferred<string>();
  const load = vi.fn(() => pending.promise);
  const read = () =>
    capture(() =>
      withExpiry(
        async () => {
          recordLiveCatalogExpiry(absoluteExpiry);
          return cache(["slow-provider", absoluteExpiry], load, {
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
  expect(completed.providerExpiries.get("fixture")).toBe(absoluteExpiry);

  now = 63_800;
  const cached = await read();
  expect(cached.value).toBe("usable");
  expect(cached.providerExpiries.get("fixture")).toBe(absoluteExpiry);
  expect(load).toHaveBeenCalledOnce();

  now = 93_600;
  await read();
  expect(load).toHaveBeenCalledTimes(2);
});

it.each([
  { outcome: "resolve", ttlMs: 0, now: () => 1_000, values: ["fresh"] },
  { outcome: "overflow", ttlMs: 1, now: () => 8_640_000_000_000_000, values: ["first", "second"] },
])(
  "bypasses a warm cache without modifying it when the uncached loader will $outcome",
  async ({ ttlMs, now, values }) => {
    const keyParts = ["provider", "models"];
    await cache(keyParts, async () => "cached");
    const controller = new AbortController();
    let calls = 0;
    const load = vi.fn((signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      return Promise.resolve(values[calls++]);
    });
    const shouldCache = vi.fn(() => false);
    for (const expected of values) {
      await expect(
        cache(keyParts, load, { shouldCache, signal: controller.signal, ttlMs, now }),
      ).resolves.toBe(expected);
    }
    expect(shouldCache).not.toHaveBeenCalled();
    await expect(cache(keyParts, load)).resolves.toBe("cached");
    expect(load).toHaveBeenCalledTimes(values.length);
  },
);

it.each(["resolve", "predicate-throw", "same-promise"] as const)(
  "preserves a replacement cache entry after expired work finishes with %s",
  async (outcome) => {
    let now = 1_000;
    const keyParts = ["provider", "models"];
    const pending = createDeferred<string>();
    const error = new Error("expired failure");
    const first = cache(keyParts, () => pending.promise, {
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
    const replacement = cache(
      keyParts,
      () => (outcome === "same-promise" ? pending.promise : Promise.resolve("replacement")),
      { ttlMs: 100, now: () => now },
    );
    pending.resolve("expired");
    if (outcome === "predicate-throw") {
      await expect(first).rejects.toBe(error);
    } else {
      await expect(first).resolves.toBe("expired");
    }
    const expected = outcome === "same-promise" ? "expired" : "replacement";
    await expect(replacement).resolves.toBe(expected);
    const load = vi.fn(async () => "unnecessary reload");
    await expect(cache(keyParts, load, { now: () => now })).resolves.toBe(expected);
    expect(load).not.toHaveBeenCalled();
  },
);
it.each([
  ["custom-qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1", true],
  ["custom-proxy", "https://proxy.example.com/v1", undefined],
] as const)(
  "applies %s endpoint capabilities while preserving overrides",
  (providerId, baseUrl, expected) => {
    const provider = applyProviderNativeStreamingUsageCompat({
      providerId,
      providerConfig: catalogFixture(providerId, baseUrl, [
        buildModel("default"),
        buildModel("override", false),
      ]).providerConfig,
    });
    expect(provider.models.map((model) => model.compat?.supportsUsageInStreaming)).toEqual([
      expected,
      false,
    ]);
  },
);
it("normalizes kilocode Gemini ids while preserving configured modalities", () => {
  const providerId = "kilocode";
  const input: ModelDefinitionConfig["input"] = ["text", "image", "video", "audio"];
  const attributes = {
    name: "Gemini 3 Pro Preview",
    input,
    reasoning: true,
    contextWindow: 1048576,
  };
  const provider = {
    baseUrl: "https://catalog.example/v1",
    models: [{ ...buildModel("google/gemini-3-pro-preview"), ...attributes, maxTokens: 65536 }],
  };
  expect(
    readConfigured({
      providerId,
      config: { models: { providers: { [providerId]: provider } } },
    }),
  ).toEqual([
    {
      provider: providerId,
      id: "google/gemini-3.1-pro-preview",
      ...attributes,
    },
  ]);
});
it("converts manifest rows and reads the default model reference", () => {
  const model: ModelCatalogProvider["models"][number] = {
    id: "example-model",
    name: "Example Model",
    input: ["text", "image", "video"],
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
  const providerId = "example";
  const catalog: ModelCatalogProvider = {
    baseUrl: "https://api.example.test/v1",
    api: "openai-completions",
    defaultModel: " example-model ",
    headers: { "x-provider": "example" },
    models: [model],
  };
  expect(buildManifest({ providerId, catalog })).toEqual({
    baseUrl: catalog.baseUrl,
    api: "openai-completions",
    headers: { "x-provider": "example" },
    models: [model],
  });
  expect(readDefaultModel({ modelCatalog: { providers: { example: catalog } } }, "example")).toBe(
    "example/example-model",
  );
});
