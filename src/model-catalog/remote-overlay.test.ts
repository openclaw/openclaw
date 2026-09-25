import { Worker } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  captureRemoteModelCatalogStartupSnapshot,
  prepareRemoteModelCatalogStartupSnapshot,
  publishRemoteModelCatalogSnapshot,
  readRemoteModelCatalogUpdate,
  withRemoteModelCatalogSnapshot,
  getRemoteModelCatalogPricing,
  getRemoteModelCatalogProviderOverlay,
} from "./remote-overlay.js";
import { setRemoteModelCatalogOverlaySourcesForTest } from "./remote-overlay.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const mocks = {
  builtAt: vi.fn<() => number | undefined>(),
  read: vi.fn(),
};

const bundle = {
  schemaVersion: 1,
  generatedAt: 200,
  minVersion: "2026.7.0",
  sourceCommit: "abc",
  providers: { anthropic: { models: [{ id: "new" }] } },
  pricing: { "openai/gpt-external": { input: 2.5, output: 10 } },
};

beforeEach(() => {
  mocks.builtAt.mockReset().mockReturnValue(100);
  mocks.read.mockReset().mockReturnValue({
    bundle_json: JSON.stringify(bundle),
    source_url: "https://catalog.openclaw.ai/models/v2/catalog.json",
  });
  setRemoteModelCatalogOverlaySourcesForTest({
    bundledGeneratedAt: mocks.builtAt,
    readStoredCatalog: mocks.read,
  });
});

afterEach(() => {
  setRemoteModelCatalogOverlaySourcesForTest();
});

describe("remote model catalog overlay", () => {
  it.each([false, true])(
    "publishes a paired generation while retaining startup absence=%s",
    async (absent) => {
      if (absent) {
        mocks.read.mockReturnValue(undefined);
      }
      const oldModels = absent ? undefined : [{ id: "new" }];
      const oldPrice = absent ? undefined : 2.5;
      const previous = captureRemoteModelCatalogStartupSnapshot();
      mocks.read.mockReturnValue({
        source_url: "https://catalog.openclaw.ai/models/v2/catalog.json",
        bundle_json: JSON.stringify({
          ...bundle,
          generatedAt: 300,
          providers: { anthropic: { models: [{ id: "downloaded" }] } },
          pricing: { "openai/gpt-external": { input: 5, output: 20 } },
        }),
      });
      const next = expectDefined(await readRemoteModelCatalogUpdate({}), "compatible catalog");
      expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")?.models).toEqual(oldModels);
      expect(getRemoteModelCatalogPricing({})?.["openai/gpt-external"]?.cost.input).toBe(oldPrice);
      expect(publishRemoteModelCatalogSnapshot(next, previous)).toBe(true);
      expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")?.models).toEqual([
        { id: "downloaded" },
      ]);
      expect(getRemoteModelCatalogPricing({})?.["openai/gpt-external"]?.cost.input).toBe(5);
      withRemoteModelCatalogSnapshot(previous, () => {
        expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")?.models).toEqual(oldModels);
        expect(getRemoteModelCatalogPricing({})?.["openai/gpt-external"]?.cost.input).toBe(
          oldPrice,
        );
      });
      expect(publishRemoteModelCatalogSnapshot(next, previous)).toBe(false);
      expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")?.models).toEqual([
        { id: "downloaded" },
      ]);
    },
  );

  it("does not adopt a stored bundle belonging to another source", async () => {
    const previous = captureRemoteModelCatalogStartupSnapshot();
    mocks.read.mockReturnValue({
      source_url: "https://mirror.example.test/catalog.json",
      bundle_json: JSON.stringify({ ...bundle, generatedAt: 300 }),
    });
    expect(await readRemoteModelCatalogUpdate({})).toBeUndefined();
    expect(captureRemoteModelCatalogStartupSnapshot()).toBe(previous);
  });

  it.each([
    { name: "invalid JSON", bundleJson: "{", error: SyntaxError },
    {
      name: "duplicate nested model IDs",
      bundleJson: JSON.stringify({
        ...bundle,
        generatedAt: 300,
        providers: { anthropic: { models: [{ id: "duplicate" }, { id: "duplicate" }] } },
      }),
      error: ZodError,
    },
    {
      name: "invalid nested pricing",
      bundleJson: JSON.stringify({
        ...bundle,
        generatedAt: 300,
        pricing: { "openai/gpt-external": { input: -1, output: 2 } },
      }),
      error: ZodError,
    },
  ])("rejects $name while continuing to serve the accepted pair", async ({ bundleJson, error }) => {
    captureRemoteModelCatalogStartupSnapshot();
    mocks.read.mockReturnValue({
      source_url: "https://catalog.openclaw.ai/models/v2/catalog.json",
      bundle_json: bundleJson,
    });
    await expect(readRemoteModelCatalogUpdate({})).rejects.toThrow(error);
    expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")?.models).toEqual([{ id: "new" }]);
    expect(getRemoteModelCatalogPricing({})?.["openai/gpt-external"]?.cost.input).toBe(2.5);
  });

  it.each([
    { name: "equal bundled generation", change: { generatedAt: 100 } },
    { name: "older bundled generation", change: { generatedAt: 99 } },
    { name: "incompatible minimum version", change: { minVersion: "9999.1.1" } },
    { name: "invalid minimum version", change: { minVersion: "not-a-version" } },
  ])("keeps the accepted pair when pending data has $name", async ({ change }) => {
    captureRemoteModelCatalogStartupSnapshot();
    mocks.read.mockReturnValue({
      source_url: "https://catalog.openclaw.ai/models/v2/catalog.json",
      bundle_json: JSON.stringify({ ...bundle, generatedAt: 300, ...change }),
    });
    expect(await readRemoteModelCatalogUpdate({})).toBeUndefined();
    expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")?.models).toEqual([{ id: "new" }]);
    expect(getRemoteModelCatalogPricing({})?.["openai/gpt-external"]?.cost.input).toBe(2.5);
  });

  it("does not publish startup absence after its original read scope retires", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-retired-catalog-") };
    const original = captureOpenClawStateWorkerContext({ env });
    const reading = createDeferredCore<undefined>();
    mocks.read.mockReturnValue(reading.promise);
    const preparing = prepareRemoteModelCatalogStartupSnapshot({ env });
    const rejected = expect(preparing).rejects.toThrow();
    await closeOpenClawStateDatabaseAsync();
    expect(() => original.admission.assertCurrent()).toThrow();
    reading.resolve(undefined);
    await rejected;
    mocks.read.mockReturnValue({
      source_url: "https://catalog.openclaw.ai/models/v2/catalog.json",
      bundle_json: JSON.stringify(bundle),
    });
    expect(captureRemoteModelCatalogStartupSnapshot()?.pricing).toEqual({
      "openai/gpt-external": { cost: bundle.pricing["openai/gpt-external"], explicit: false },
    });
  });

  it("keeps the first published startup pair when asynchronous preparation completes later", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-first-catalog-") };
    const preparing = prepareRemoteModelCatalogStartupSnapshot({ env });
    mocks.read.mockReturnValue({
      source_url: "https://catalog.openclaw.ai/models/v2/catalog.json",
      bundle_json: JSON.stringify({
        ...bundle,
        generatedAt: 300,
        pricing: { "openai/gpt-external": { input: 5, output: 20 } },
      }),
    });
    const winner = captureRemoteModelCatalogStartupSnapshot();
    expect(await preparing).toBe(winner);
    expect(await prepareRemoteModelCatalogStartupSnapshot({ env })).toBe(winner);
    expect(getRemoteModelCatalogPricing({})?.["openai/gpt-external"]).toEqual({
      cost: { input: 5, output: 20 },
      explicit: false,
    });
  });

  it("loads a newer compatible bundle once", () => {
    expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")).toHaveProperty("models");
    expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")).toHaveProperty("models");
    expect(getRemoteModelCatalogPricing({})?.["openai/gpt-external"]).toEqual({
      cost: { input: 2.5, output: 10 },
      explicit: false,
    });
    expect(mocks.read).toHaveBeenCalledOnce();
  });

  it("keeps startup rows and prices when the configured source changes", () => {
    const overlay = getRemoteModelCatalogProviderOverlay({}, "anthropic");
    const pricing = getRemoteModelCatalogPricing({});
    mocks.read.mockReturnValue({
      bundle_json: JSON.stringify({
        ...bundle,
        generatedAt: 300,
        providers: { anthropic: { models: [{ id: "downloaded" }] } },
        pricing: { "openai/gpt-external": { input: 5, output: 20 } },
      }),
      source_url: "https://mirror.example.test/catalog.json",
    });
    expect(
      getRemoteModelCatalogProviderOverlay(
        { models: { catalogRefresh: { url: "https://mirror.example.test/catalog.json" } } },
        "anthropic",
      ),
    ).toBeUndefined();
    expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")).toEqual(overlay);
    expect(getRemoteModelCatalogPricing({})).toEqual(pricing);
  });

  it("serves a released default install's v1 download until its v2 download is active", async () => {
    const v1Default = "https://catalog.openclaw.ai/models/v1/catalog.json";
    const v2Default = "https://catalog.openclaw.ai/models/v2/catalog.json";
    mocks.read.mockReturnValue({ bundle_json: JSON.stringify(bundle), source_url: v1Default });
    // Offline after upgrading: the default config keeps the downloaded rows and prices.
    expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")).toHaveProperty("models");
    expect(getRemoteModelCatalogPricing({})?.["openai/gpt-external"]).toEqual({
      cost: { input: 2.5, output: 10 },
      explicit: false,
    });
    // A configured mirror never inherits the retired default's download.
    expect(
      getRemoteModelCatalogPricing({
        models: { catalogRefresh: { url: "https://mirror.example.test/catalog.json" } },
      }),
    ).toBeUndefined();
    const previous = captureRemoteModelCatalogStartupSnapshot();
    mocks.read.mockReturnValue({ bundle_json: JSON.stringify(bundle), source_url: v2Default });
    const next = expectDefined(await readRemoteModelCatalogUpdate({}), "v2 catalog");
    expect(captureRemoteModelCatalogStartupSnapshot()?.sourceUrl).toBe(v1Default);
    expect(publishRemoteModelCatalogSnapshot(next, previous)).toBe(true);
    expect(captureRemoteModelCatalogStartupSnapshot()?.sourceUrl).toBe(v2Default);
  });

  it("keeps invalid startup metadata absent after a successful download", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-optional-catalog-") };
    const valid = mocks.read();
    mocks.read.mockReturnValue({ ...valid, bundle_json: "{" });
    expect(await prepareRemoteModelCatalogStartupSnapshot({ env })).toBeNull();
    mocks.read.mockReturnValue(valid);
    expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")).toBeUndefined();
    expect(getRemoteModelCatalogPricing({})).toBeUndefined();
  });

  it("passes the same startup rows and prices to later workers", async () => {
    const expected = {
      overlay: getRemoteModelCatalogProviderOverlay({}, "anthropic"),
      pricing: getRemoteModelCatalogPricing({}),
    };
    mocks.read.mockReturnValue(undefined);
    const worker = new Worker(new URL("./remote-overlay.worker.test-support.ts", import.meta.url), {
      execArgv: ["--import", "tsx"],
    });
    try {
      const actual = await new Promise((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      });
      expect(actual).toEqual(expected);
    } finally {
      await worker.terminate();
    }
  });

  it("fails closed when disabled, stale, or missing a build stamp", () => {
    expect(
      getRemoteModelCatalogProviderOverlay(
        { models: { catalogRefresh: { enabled: false } } },
        "anthropic",
      ),
    ).toBeUndefined();
    expect(mocks.read).not.toHaveBeenCalled();
    mocks.builtAt.mockReturnValue(200);
    expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")).toBeUndefined();
    setRemoteModelCatalogOverlaySourcesForTest({
      bundledGeneratedAt: mocks.builtAt,
      readStoredCatalog: mocks.read,
    });
    mocks.builtAt.mockReturnValue(undefined);
    expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")).toBeUndefined();
  });

  it("does not reuse a cached overlay after disablement or a URL change", () => {
    expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")).toHaveProperty("models");
    expect(
      getRemoteModelCatalogProviderOverlay(
        { models: { catalogRefresh: { enabled: false } } },
        "anthropic",
      ),
    ).toBeUndefined();
    expect(
      getRemoteModelCatalogProviderOverlay(
        {
          models: { catalogRefresh: { url: "https://mirror.example.test/catalog.json" } },
        },
        "anthropic",
      ),
    ).toBeUndefined();
    expect(mocks.read).toHaveBeenCalledOnce();
  });
});
