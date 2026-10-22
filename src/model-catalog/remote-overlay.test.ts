import { once } from "node:events";
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
  captureRemoteModelCatalogStartupSnapshot as captureStartup,
  prepareRemoteModelCatalogStartupSnapshot as prepareStartup,
  publishRemoteModelCatalogSnapshot as publishSnapshot,
  readRemoteModelCatalogUpdate as readUpdate,
  withRemoteModelCatalogSnapshot as withSnapshot,
  getActiveRemoteModelCatalog as activeCatalog,
  getRemoteModelCatalogProviderOverlay,
} from "./remote-overlay.js";
import { setRemoteModelCatalogOverlaySourcesForTest } from "./remote-overlay.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const builtAt = vi.fn<() => number | undefined>();
const read = vi.fn();

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
function stageBundle(value: unknown = bundle, source_url = defaultUrl) {
  read.mockReturnValue({ bundle_json: JSON.stringify(value), source_url });
}
const overlay = (config: OpenClawConfig = {}) =>
  getRemoteModelCatalogProviderOverlay(config, "anthropic");
const price = () => activeCatalog({})?.pricing?.["openai/gpt-external"];
function expectPair(
  expected: [Array<{ id: string }> | undefined, number | undefined] = [[{ id: "new" }], 2.5],
) {
  expect([overlay()?.models, price()?.cost.input]).toEqual(expected);
}

beforeEach(() => {
  builtAt.mockReset().mockReturnValue(100);
  read.mockReset();
  stageBundle();
  setRemoteModelCatalogOverlaySourcesForTest({
    bundledGeneratedAt: builtAt,
    readStoredCatalog: read,
  });
});

afterEach(() => setRemoteModelCatalogOverlaySourcesForTest());

describe("remote model catalog overlay", () => {
  it.each([false, true])("avoids unprepared reads (stamp missing=%s)", async (missingStamp) => {
    if (missingStamp) {
      builtAt.mockReturnValue(undefined);
      await prepareStartup();
    }
    expect(captureStartup()).toBeNull();
    expect(overlay()).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps older hosted recommendations only for currently served rows", async () => {
    builtAt.mockReturnValue(300);
    stageBundle({
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
    });
    await prepareStartup();
    const rank = createModelPickerRecommendationRank({});
    const current = { provider: "anthropic", id: "current" };
    expect([rank(current), rank({ provider: "anthropic", id: "other" })]).toEqual([1, undefined]);
    expect(overlay()).toBeUndefined();
    expect(activeCatalog({})?.pricing).toEqual({});
    expect(activeCatalog({})?.upstreamPricing).toEqual({});
    expect(createModelPickerRecommendationRank(disabledConfig)(current)).toBeUndefined();
  });

  it.each([false, true])(
    "publishes valid rows and prices, skipping duplicates while retaining startup absence=%s",
    async (absent) => {
      if (absent) {
        read.mockReturnValue(undefined);
      }
      const oldModels = absent ? undefined : [{ id: "new" }];
      const oldPrice = absent ? undefined : 2.5;
      const previous = await prepareStartup();
      stageBundle({
        ...bundle,
        generatedAt: 300,
        providers: {
          anthropic: {
            models: [{ id: "downloaded" }, { id: "downloaded", name: "ignored duplicate" }],
          },
        },
        pricing: { "openai/gpt-external": { input: 5, output: 20 } },
      });
      const next = expectDefined(await readUpdate({}), "compatible catalog");
      expectPair([oldModels, oldPrice]);
      expect(publishSnapshot(next, previous)).toBe(true);
      expectPair([[{ id: "downloaded" }], 5]);
      withSnapshot(previous, () => expectPair([oldModels, oldPrice]));
      expect(publishSnapshot(next, previous)).toBe(false);
      expect(overlay()?.models).toEqual([{ id: "downloaded" }]);
    },
  );

  it("does not adopt a stored bundle belonging to another source", async () => {
    const previous = await prepareStartup();
    stageBundle({ ...bundle, generatedAt: 300 }, mirrorConfig.models.catalogRefresh.url);
    expect(await readUpdate({})).toBeUndefined();
    expect(captureStartup()).toBe(previous);
  });

  it.each([
    ["invalid JSON", "{", SyntaxError],
    ["invalid pricing", { pricing: { "openai/gpt-external": { input: -1, output: 2 } } }, ZodError],
    ["equal generation", { generatedAt: 100 }, undefined],
    ["incompatible version", { minVersion: "9999.1.1" }, undefined],
    ["invalid version", { minVersion: "not-a-version" }, undefined],
  ] as const)("keeps the accepted pair after %s", async (_name, change, error) => {
    await prepareStartup();
    read.mockReturnValue({
      source_url: defaultUrl,
      bundle_json:
        typeof change === "string"
          ? change
          : JSON.stringify({ ...bundle, generatedAt: 300, ...change }),
    });
    const update = readUpdate({});
    if (error) {
      await expect(update).rejects.toThrow(error);
    } else {
      expect(await update).toBeUndefined();
    }
    expectPair();
  });

  it("does not publish startup absence after its original read scope retires", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-retired-catalog-") };
    const original = captureOpenClawStateWorkerContext({ env });
    const reading = createDeferredCore<undefined>();
    read.mockReturnValue(reading.promise);
    const preparing = prepareStartup({ env });
    const rejected = expect(preparing).rejects.toThrow();
    await closeOpenClawStateDatabaseAsync();
    expect(() => original.admission.assertCurrent()).toThrow();
    reading.resolve(undefined);
    await rejected;
    stageBundle();
    await prepareStartup();
    expect(captureStartup()?.pricing).toEqual({
      "openai/gpt-external": { cost: bundle.pricing["openai/gpt-external"], explicit: false },
    });
  });

  it("keeps the first published startup pair when asynchronous preparation completes later", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-first-catalog-") };
    const pendingRead = createDeferredCore<undefined>();
    read.mockReturnValueOnce(pendingRead.promise);
    const preparing = prepareStartup({ env });
    stageBundle({
      ...bundle,
      generatedAt: 300,
      pricing: { "openai/gpt-external": { input: 5, output: 20 } },
    });
    const winner = await prepareStartup({ env });
    pendingRead.resolve(undefined);
    expect(await preparing).toBe(winner);
    expect(await prepareStartup({ env })).toBe(winner);
    expect(price()).toEqual({
      cost: { input: 5, output: 20 },
      explicit: false,
    });
  });

  it("serves a released default install's v1 download until its v2 download is active", async () => {
    const v1Default = "https://catalog.openclaw.ai/models/v1/catalog.json";
    stageBundle(bundle, v1Default);
    await prepareStartup();
    expect(overlay()).toHaveProperty("models");
    expect(price()).toEqual({
      cost: { input: 2.5, output: 10 },
      explicit: false,
    });
    expect(activeCatalog(mirrorConfig)?.pricing).toBeUndefined();
    const previous = await prepareStartup();
    stageBundle();
    const next = expectDefined(await readUpdate({}), "v2 catalog");
    expect(captureStartup()?.sourceUrl).toBe(v1Default);
    expect(publishSnapshot(next, previous)).toBe(true);
    expect(captureStartup()?.sourceUrl).toBe(defaultUrl);
  });

  it("keeps invalid startup metadata absent after a successful download", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-optional-catalog-") };
    const valid = read();
    read.mockReturnValue({ ...valid, bundle_json: "{" });
    expect(await prepareStartup({ env })).toBeNull();
    read.mockReturnValue(valid);
    expect(overlay()).toBeUndefined();
    expect(activeCatalog({})?.pricing).toBeUndefined();
  });

  it("passes the same startup rows and prices to later workers", async () => {
    await prepareStartup();
    const expected = { overlay: overlay(), pricing: activeCatalog({})?.pricing };
    read.mockReturnValue(undefined);
    const worker = new Worker(new URL("./remote-overlay.worker.test-support.ts", import.meta.url), {
      execArgv: ["--import", "tsx"],
    });
    try {
      const [actual] = await once(worker, "message");
      expect(actual).toEqual(expected);
    } finally {
      await worker.terminate();
    }
  });

  it("does not reuse a cached overlay after disablement or a URL change", async () => {
    await prepareStartup();
    const previous = captureStartup();
    expect(overlay()).toHaveProperty("models");
    expect(overlay(disabledConfig)).toBeUndefined();
    expect(overlay(mirrorConfig)).toBeUndefined();
    expectPair();
    expect(captureStartup()).toBe(previous);
    expect(read).toHaveBeenCalledOnce();
  });
});
