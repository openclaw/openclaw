import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  captureRemoteModelCatalogStartupSnapshot,
  prepareRemoteModelCatalogStartupSnapshot,
  checkRemoteModelCatalogUpdate,
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
  it("inspects pending generations without replacing the startup snapshot, rows, or prices", () => {
    const sourceUrl = "https://catalog.openclaw.ai/models/v2/catalog.json";
    const snapshot = captureRemoteModelCatalogStartupSnapshot();
    const overlay = getRemoteModelCatalogProviderOverlay({}, "anthropic");
    const pricing = getRemoteModelCatalogPricing({});
    expect(overlay?.models).toEqual([{ id: "new" }]);
    expect(pricing?.["openai/gpt-external"]).toEqual({
      cost: { input: 2.5, output: 10 },
      explicit: false,
    });
    expect(checkRemoteModelCatalogUpdate({}, { sourceUrl, generatedAt: 200 })).toBe("unchanged");
    expect(mocks.read).toHaveBeenCalledOnce();

    mocks.read.mockReturnValue({
      source_url: sourceUrl,
      bundle_json: JSON.stringify({
        ...bundle,
        generatedAt: 300,
        providers: { anthropic: { models: [{ id: "downloaded" }] } },
        pricing: { "openai/gpt-external": { input: 5, output: 20 } },
      }),
    });
    expect(checkRemoteModelCatalogUpdate({}, { sourceUrl, generatedAt: 300 })).toBe(
      "restart-required",
    );
    expect(captureRemoteModelCatalogStartupSnapshot()).toBe(snapshot);
    expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")).toBe(overlay);
    expect(getRemoteModelCatalogPricing({})).toBe(pricing);
  });

  it.each([{ enabled: false }, { url: "https://mirror.example.test/catalog.json" }])(
    "rejects a check superseded by config %j without reading stored data",
    (catalogRefresh) => {
      expect(
        checkRemoteModelCatalogUpdate(
          { models: { catalogRefresh } },
          { sourceUrl: "https://catalog.openclaw.ai/models/v2/catalog.json", generatedAt: 300 },
        ),
      ).toBe("superseded");
      expect(mocks.read).not.toHaveBeenCalled();
    },
  );

  it.each([
    { sourceUrl: "https://mirror.example.test/catalog.json", generatedAt: 300 },
    { sourceUrl: "https://catalog.openclaw.ai/models/v2/catalog.json", generatedAt: 400 },
  ])("rejects a stored check superseded by %j", ({ sourceUrl, generatedAt }) => {
    const snapshot = captureRemoteModelCatalogStartupSnapshot();
    mocks.read.mockReturnValue({
      source_url: sourceUrl,
      bundle_json: JSON.stringify({ ...bundle, generatedAt }),
    });
    expect(
      checkRemoteModelCatalogUpdate(
        {},
        {
          sourceUrl: "https://catalog.openclaw.ai/models/v2/catalog.json",
          generatedAt: 300,
        },
      ),
    ).toBe("superseded");
    expect(captureRemoteModelCatalogStartupSnapshot()).toBe(snapshot);
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
  ])("reports $name without replacing a valid startup snapshot", ({ bundleJson, error }) => {
    const snapshot = captureRemoteModelCatalogStartupSnapshot();
    const overlay = getRemoteModelCatalogProviderOverlay({}, "anthropic");
    const pricing = getRemoteModelCatalogPricing({});
    const stored = Object.freeze({
      source_url: "https://catalog.openclaw.ai/models/v2/catalog.json",
      bundle_json: bundleJson,
    });
    mocks.read.mockReturnValue(stored);
    expect(() =>
      checkRemoteModelCatalogUpdate(
        {},
        {
          sourceUrl: "https://catalog.openclaw.ai/models/v2/catalog.json",
          generatedAt: 300,
        },
      ),
    ).toThrow(error);
    expect(captureRemoteModelCatalogStartupSnapshot()).toBe(snapshot);
    expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")).toBe(overlay);
    expect(getRemoteModelCatalogPricing({})).toBe(pricing);
    expect(stored.bundle_json).toBe(bundleJson);
  });

  it.each([
    { name: "equal bundled generation", change: { generatedAt: 100 } },
    { name: "older bundled generation", change: { generatedAt: 99 } },
    { name: "incompatible minimum version", change: { minVersion: "9999.1.1" } },
    { name: "invalid minimum version", change: { minVersion: "not-a-version" } },
  ])("keeps the startup pair when pending data has $name", ({ change }) => {
    const snapshot = captureRemoteModelCatalogStartupSnapshot();
    const overlay = getRemoteModelCatalogProviderOverlay({}, "anthropic");
    const pricing = getRemoteModelCatalogPricing({});
    mocks.read.mockReturnValue({
      source_url: "https://catalog.openclaw.ai/models/v2/catalog.json",
      bundle_json: JSON.stringify({ ...bundle, generatedAt: 300, ...change }),
    });
    expect(
      checkRemoteModelCatalogUpdate(
        {},
        { sourceUrl: "https://catalog.openclaw.ai/models/v2/catalog.json", generatedAt: 300 },
      ),
    ).toBe("unchanged");
    expect(captureRemoteModelCatalogStartupSnapshot()).toBe(snapshot);
    expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")).toBe(overlay);
    expect(getRemoteModelCatalogPricing({})).toBe(pricing);
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

  it("serves a released default install's v1 download until its v2 download is active", () => {
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
    // The first v2 download of the same generation still needs a restart to take over.
    mocks.read.mockReturnValue({ bundle_json: JSON.stringify(bundle), source_url: v2Default });
    expect(
      checkRemoteModelCatalogUpdate({}, { sourceUrl: v2Default, generatedAt: bundle.generatedAt }),
    ).toBe("restart-required");
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
