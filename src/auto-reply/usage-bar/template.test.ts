import { renameSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as observation from "@openclaw/fs-safe/watch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { DEFAULT_USAGE_BAR_TEMPLATE } from "./default-template.js";
import { loadUsageBarTemplate } from "./template.js";
import { clearUsageBarTemplateCacheForTest } from "./template.test-support.js";

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: warnSpy }),
}));
vi.mock("@openclaw/fs-safe/watch", async () => {
  const { createRequire } = await import("node:module");
  return { ...createRequire(import.meta.url)("@openclaw/fs-safe/watch") };
});
const temp = useAutoCleanupTempDirTracker(afterEach);
const subscriptions: observation.WatchSubscription[] = [];
let created = createDeferredCore<observation.WatchSubscription>();
beforeEach(() => {
  created = createDeferredCore<observation.WatchSubscription>();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const original = observation.watch;
  vi.spyOn(observation, "watch").mockImplementation((authority, options) => {
    expect(options.persistent).toBe(false);
    const subscription = original(authority, { ...options, mode: "poll" });
    subscriptions.push(subscription);
    created.resolve(subscription);
    created = createDeferredCore<observation.WatchSubscription>();
    return subscription;
  });
});
afterEach(async () => {
  await clearUsageBarTemplateCacheForTest();
  await Promise.all(subscriptions.splice(0).map((subscription) => subscription.close()));
  warnSpy.mockClear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const tplA = { segments: [{ text: "A" }] };
const tplB = { output: { default: [{ text: "B" }] } };
const warning = "configured usage template could not be used; using built-in footer";
const tmpDir = () => temp.make("usage-template-");
const writeTemplate = (file: string, template: object) =>
  writeFileSync(file, JSON.stringify(template));
function expectTemplate(file: string | undefined, template: object) {
  expect(loadUsageBarTemplate(file)).toEqual(template);
}
function expectWarningCount(file: string, count: number) {
  expect(loadUsageBarTemplate(file)).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
  expect(warnSpy).toHaveBeenCalledTimes(count);
}
function tmpFile(name: string, contents: string): string {
  const file = join(tmpDir(), name);
  writeFileSync(file, contents);
  return file;
}

async function loadObservedTemplate(path: string) {
  const started = created.promise;
  const template = loadUsageBarTemplate(path);
  const subscription = await started;
  await subscription.ready;
  return { template, subscription };
}

describe("loadUsageBarTemplate", () => {
  it("returns the built-in template when unset", () => {
    expect(loadUsageBarTemplate(undefined)).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
  });

  it("falls back to the built-in template for an unusable inline object", () => {
    expect(loadUsageBarTemplate({ nope: true })).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]).toMatchObject([
      warning,
      { source: "inline", reason: "unsupported-shape" },
    ]);
  });

  it("falls back to the built-in template for an empty template file", () => {
    const path = tmpFile("empty.json", JSON.stringify({ output: { default: [] } }));
    expect(loadUsageBarTemplate(path)).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("reloads a path after invalid JSON is fixed", () => {
    const path = tmpFile("bad.json", "{ not json");
    expectWarningCount(path, 1);
    writeTemplate(path, tplB);
    expect(loadUsageBarTemplate(path)).toMatchObject(tplB);
  });

  it("bounds invalid-template warnings by least-recently-used path", () => {
    const dir = tmpDir();
    const paths = Array.from({ length: 257 }, (_, i) => join(dir, `bad-${i}.json`));
    for (const path of paths) {
      writeFileSync(path, "{ not json");
    }
    for (const path of paths.slice(0, 256)) {
      expect(loadUsageBarTemplate(path)).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
    }
    expect(warnSpy).toHaveBeenCalledTimes(256);

    // Refresh the oldest warning before overflow so the next key becomes the LRU victim.
    expectWarningCount(paths[0]!, 256);
    expectWarningCount(paths[256]!, 257);
    expectWarningCount(paths[0]!, 257);
    expectWarningCount(paths[1]!, 258);
    expect(warnSpy).toHaveBeenLastCalledWith(warning, {
      source: "file",
      reason: "invalid-json",
      path: paths[1],
    });
  });

  it("refreshes atomic replacements and restored files, then rereads after loss of coverage", async () => {
    const directory = tmpDir();
    const file = join(directory, "template.json");
    writeTemplate(file, tplA);
    const { template: first, subscription } = await loadObservedTemplate(file);
    await subscription.reconcile();
    expect(loadUsageBarTemplate(file)).toBe(first);

    const staged = join(directory, "staged.json");
    for (const next of [tplB, tplA]) {
      writeTemplate(staged, next);
      renameSync(staged, file);
      await subscription.reconcile();
      expectTemplate(file, next);
    }
    unlinkSync(file);
    await subscription.reconcile();
    expect(loadUsageBarTemplate(file)).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
    writeTemplate(file, tplA);
    await subscription.reconcile();
    expectTemplate(file, tplA);
    writeTemplate(staged, tplB);
    renameSync(staged, file);
    await subscription.reconcile();
    expectTemplate(file, tplB);
    expect(warnSpy).not.toHaveBeenCalled();

    renameSync(directory, join(tmpDir(), "retired"));
    await expect(subscription.reconcile()).rejects.toThrow();
    mkdirSync(directory);
    writeTemplate(file, tplB);
    const replacement = await loadObservedTemplate(file);
    expect(replacement.template).toEqual(tplB);
    await replacement.subscription.reconcile();
    expect(subscription.health().state).toBe("closed");
  });

  it("evicts the oldest path with its observation, but retains entries when retrying a miss", async () => {
    const directory = tmpDir();
    const files = Array.from({ length: 65 }, (_, i) => join(directory, `template-${i}.json`));
    for (const file of files.slice(0, 63)) {
      writeTemplate(file, tplA);
      expect((await loadObservedTemplate(file)).template).toEqual(tplA);
    }
    const miss = files[63]!;
    expect(loadUsageBarTemplate(miss)).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
    writeTemplate(miss, tplB);
    expect((await loadObservedTemplate(miss)).template).toEqual(tplB);
    expect(subscriptions).toHaveLength(64);
    const oldest = subscriptions[0]!;
    writeTemplate(files[0]!, tplB);
    expectTemplate(files[0], tplA);

    writeTemplate(files[64]!, tplA);
    expect((await loadObservedTemplate(files[64]!)).template).toEqual(tplA);
    expect(oldest.health().state).toBe("closed");
    for (const subscription of subscriptions.filter((entry) => entry !== oldest)) {
      expect(subscription.health().state).toBe("ready");
    }
    expect((await loadObservedTemplate(files[0]!)).template).toEqual(tplB);
    await clearUsageBarTemplateCacheForTest();
    for (const subscription of subscriptions) {
      expect(subscription.health().state).toBe("closed");
    }
  });
});
