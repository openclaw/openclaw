import { Worker } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createModelPickerRecommendationRank } from "../agents/model-catalog-order.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  captureRemoteModelCatalogStartupSnapshot,
  prepareRemoteModelCatalogStartupSnapshot,
  publishRemoteModelCatalogSnapshot,
  readRemoteModelCatalogUpdate,
  withRemoteModelCatalogSnapshot,
  getActiveRemoteModelCatalog,
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
const defaultUrl = "https://catalog.openclaw.ai/models/v2/catalog.json";
const mirrorConfig = {
  models: { catalogRefresh: { url: "https://mirror.example.test/catalog.json" } },
};
const disabledConfig = { models: { catalogRefresh: { enabled: false } } };
const stored = (value: unknown = bundle, source_url = defaultUrl) => ({
  bundle_json: JSON.stringify(value),
  source_url,
});
const overlay = (config: OpenClawConfig = {}) =>
  getRemoteModelCatalogProviderOverlay(config, "anthropic");
const price = () => getActiveRemoteModelCatalog({})?.pricing?.["openai/gpt-external"];
function expectAcceptedPair() {
  expect(overlay()?.models).toEqual([{ id: "new" }]);
  expect(price()?.cost.input).toBe(2.5);
}

beforeEach(() => {
  mocks.builtAt.mockReset().mockReturnValue(100);
  mocks.read.mockReset().mockReturnValue(stored());
  setRemoteModelCatalogOverlaySourcesForTest({
    bundledGeneratedAt: mocks.builtAt,
    readStoredCatalog: mocks.read,
  });
});

afterEach(() => {
  setRemoteModelCatalogOverlaySourcesForTest();
});

describe("remote model catalog overlay", () => {
  it("does not read persistent state from runtime getters before preparation", () => {
    expect(captureRemoteModelCatalogStartupSnapshot()).toBeNull();
    expect(overlay()).toBeUndefined();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("keeps older hosted recommendations only for currently served rows", async () => {
    mocks.builtAt.mockReturnValue(300);
    mocks.read.mockReturnValue(
      stored({
        schemaVersion: 2,
        generatedAt: 200,
        minVersion: "2026.7.0",
        sourceCommit: "recommendation-test",
        providers: { anthropic: { recommendedModels: ["retired", "current"] } },
        models: ["retired", "current"].map((id) => ({
          id,
          provider: "anthropic",
          pricing: {
            status: "known",
            currency: "USD",
            unit: "million_tokens",
            input: 9,
            output: 18,
          },
        })),
        upstreamPricing: { "anthropic/current": { input: 9, output: 18, source: "native" } },
      }),
    );
    await prepareRemoteModelCatalogStartupSnapshot();
    const rank = createModelPickerRecommendationRank({});
    const served = [
      { provider: "anthropic", id: "current" },
      { provider: "anthropic", id: "other" },
    ];
    expect(served.filter((entry) => rank(entry) !== undefined)).toEqual([served[0]]);
    expect(rank(served[0]!)).toBe(1);
    expect(overlay()).toBeUndefined();
    expect(getActiveRemoteModelCatalog({})?.pricing).toEqual({});
    expect(getActiveRemoteModelCatalog({})?.upstreamPricing).toEqual({});
    expect(createModelPickerRecommendationRank(disabledConfig)(served[0]!)).toBeUndefined();
  });

  it.each([false, true])(
    "publishes valid rows and prices, skipping duplicates while retaining startup absence=%s",
    async (absent) => {
      if (absent) {
        mocks.read.mockReturnValue(undefined);
      }
      const oldModels = absent ? undefined : [{ id: "new" }];
      const oldPrice = absent ? undefined : 2.5;
      const previous = await prepareRemoteModelCatalogStartupSnapshot();
      mocks.read.mockReturnValue(
        stored({
          ...bundle,
          generatedAt: 300,
          providers: {
            anthropic: {
              models: [{ id: "downloaded" }, { id: "downloaded", name: "ignored duplicate" }],
            },
          },
          pricing: { "openai/gpt-external": { input: 5, output: 20 } },
        }),
      );
      const next = expectDefined(await readRemoteModelCatalogUpdate({}), "compatible catalog");
      expect(overlay()?.models).toEqual(oldModels);
      expect(price()?.cost.input).toBe(oldPrice);
      expect(publishRemoteModelCatalogSnapshot(next, previous)).toBe(true);
      expect(overlay()?.models).toEqual([{ id: "downloaded" }]);
      expect(price()?.cost.input).toBe(5);
      withRemoteModelCatalogSnapshot(previous, () => {
        expect(overlay()?.models).toEqual(oldModels);
        expect(price()?.cost.input).toBe(oldPrice);
      });
      expect(publishRemoteModelCatalogSnapshot(next, previous)).toBe(false);
      expect(overlay()?.models).toEqual([{ id: "downloaded" }]);
    },
  );

  it("does not adopt a stored bundle belonging to another source", async () => {
    const previous = await prepareRemoteModelCatalogStartupSnapshot();
    mocks.read.mockReturnValue(
      stored({ ...bundle, generatedAt: 300 }, mirrorConfig.models.catalogRefresh.url),
    );
    expect(await readRemoteModelCatalogUpdate({})).toBeUndefined();
    expect(captureRemoteModelCatalogStartupSnapshot()).toBe(previous);
  });

  it.each([
    { name: "invalid JSON", bundleJson: "{", error: SyntaxError },
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
    await prepareRemoteModelCatalogStartupSnapshot();
    mocks.read.mockReturnValue({
      source_url: "https://catalog.openclaw.ai/models/v2/catalog.json",
      bundle_json: bundleJson,
    });
    await expect(readRemoteModelCatalogUpdate({})).rejects.toThrow(error);
    expectAcceptedPair();
  });

  it.each([
    { name: "equal bundled generation", change: { generatedAt: 100 } },
    { name: "incompatible minimum version", change: { minVersion: "9999.1.1" } },
    { name: "invalid minimum version", change: { minVersion: "not-a-version" } },
  ])("keeps the accepted pair when pending data has $name", async ({ change }) => {
    await prepareRemoteModelCatalogStartupSnapshot();
    mocks.read.mockReturnValue(stored({ ...bundle, generatedAt: 300, ...change }));
    expect(await readRemoteModelCatalogUpdate({})).toBeUndefined();
    expectAcceptedPair();
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
    mocks.read.mockReturnValue(stored());
    await prepareRemoteModelCatalogStartupSnapshot();
    expect(captureRemoteModelCatalogStartupSnapshot()?.pricing).toEqual({
      "openai/gpt-external": { cost: bundle.pricing["openai/gpt-external"], explicit: false },
    });
  });

  it("keeps the first published startup pair when asynchronous preparation completes later", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-first-catalog-") };
    const pendingRead = createDeferredCore<undefined>();
    mocks.read.mockReturnValueOnce(pendingRead.promise);
    const preparing = prepareRemoteModelCatalogStartupSnapshot({ env });
    mocks.read.mockReturnValue(
      stored({
        ...bundle,
        generatedAt: 300,
        pricing: { "openai/gpt-external": { input: 5, output: 20 } },
      }),
    );
    const winner = await prepareRemoteModelCatalogStartupSnapshot({ env });
    pendingRead.resolve(undefined);
    expect(await preparing).toBe(winner);
    expect(await prepareRemoteModelCatalogStartupSnapshot({ env })).toBe(winner);
    expect(price()).toEqual({
      cost: { input: 5, output: 20 },
      explicit: false,
    });
  });

  it("serves a released default install's v1 download until its v2 download is active", async () => {
    const v1Default = "https://catalog.openclaw.ai/models/v1/catalog.json";
    mocks.read.mockReturnValue(stored(bundle, v1Default));
    await prepareRemoteModelCatalogStartupSnapshot();
    // Offline after upgrading: the default config keeps the downloaded rows and prices.
    expect(overlay()).toHaveProperty("models");
    expect(price()).toEqual({
      cost: { input: 2.5, output: 10 },
      explicit: false,
    });
    // A configured mirror never inherits the retired default's download.
    expect(getActiveRemoteModelCatalog(mirrorConfig)?.pricing).toBeUndefined();
    const previous = await prepareRemoteModelCatalogStartupSnapshot();
    mocks.read.mockReturnValue(stored());
    const next = expectDefined(await readRemoteModelCatalogUpdate({}), "v2 catalog");
    expect(captureRemoteModelCatalogStartupSnapshot()?.sourceUrl).toBe(v1Default);
    expect(publishRemoteModelCatalogSnapshot(next, previous)).toBe(true);
    expect(captureRemoteModelCatalogStartupSnapshot()?.sourceUrl).toBe(defaultUrl);
  });

  it("keeps invalid startup metadata absent after a successful download", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-optional-catalog-") };
    const valid = mocks.read();
    mocks.read.mockReturnValue({ ...valid, bundle_json: "{" });
    expect(await prepareRemoteModelCatalogStartupSnapshot({ env })).toBeNull();
    mocks.read.mockReturnValue(valid);
    expect(overlay()).toBeUndefined();
    expect(getActiveRemoteModelCatalog({})?.pricing).toBeUndefined();
  });

  it("passes the same startup rows and prices to later workers", async () => {
    await prepareRemoteModelCatalogStartupSnapshot();
    const expected = {
      overlay: overlay(),
      pricing: getActiveRemoteModelCatalog({})?.pricing,
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

  it("fails closed without reading storage when the build stamp is missing", async () => {
    mocks.builtAt.mockReturnValue(undefined);
    await prepareRemoteModelCatalogStartupSnapshot();
    expect(overlay()).toBeUndefined();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("does not reuse a cached overlay after disablement or a URL change", async () => {
    await prepareRemoteModelCatalogStartupSnapshot();
    const previous = captureRemoteModelCatalogStartupSnapshot();
    expect(overlay()).toHaveProperty("models");
    expect(overlay(disabledConfig)).toBeUndefined();
    expect(overlay(mirrorConfig)).toBeUndefined();
    expectAcceptedPair();
    expect(captureRemoteModelCatalogStartupSnapshot()).toBe(previous);
    expect(mocks.read).toHaveBeenCalledOnce();
  });
});
