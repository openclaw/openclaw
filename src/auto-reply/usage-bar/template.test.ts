import { renameSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as observation from "@openclaw/fs-safe/watch";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { loadUsageBarTemplate } from "./template.js";
import { clearUsageBarTemplateCacheForTest } from "./template.test-support.js";
const defaultTemplate = loadUsageBarTemplate(undefined);
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
const states = () => subscriptions.map((subscription) => subscription.health().state);
let created = createDeferredCore<observation.WatchSubscription>();
let directory: string;
beforeEach(() => {
  directory = temp.make("usage-template-");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const original = observation.watch;
  vi.spyOn(observation, "watch").mockImplementation((authority, options) => {
    const subscription = original(authority, { ...options, mode: "poll" });
    subscriptions.push(subscription);
    created.resolve(subscription);
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
function writeTemplate(data: object | string, file = join(directory, "template.json")) {
  writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
  return file;
}
function expectWarningCount(file: string, count: number) {
  expect(loadUsageBarTemplate(file)).toBe(defaultTemplate);
  expect(warnSpy).toHaveBeenCalledTimes(count);
}
async function loadObservedTemplate(path: string, expected: object, write = true) {
  created = createDeferredCore<observation.WatchSubscription>();
  if (write) {
    writeTemplate(expected, path);
  }
  const template = loadUsageBarTemplate(path);
  expect(template).toEqual(expected);
  const subscription = await created.promise;
  await subscription.ready;
  return { template, subscription };
}
it.each([
  [(): undefined => undefined, []],
  [() => ({ nope: true }), [[warning, { source: "inline", reason: "unsupported-shape" }]]],
  [() => writeTemplate({ output: { default: [] } }), []],
] as const)("uses the built-in template for input %#", (configured, warnings) => {
  expect(loadUsageBarTemplate(configured())).toBe(defaultTemplate);
  expect(warnSpy.mock.calls).toEqual(warnings);
});
it("bounds invalid-template warnings by LRU path and reloads corrected JSON", () => {
  const paths = Array.from({ length: 257 }, (_, i) =>
    writeTemplate("{ not json", join(directory, `${i}.json`)),
  );
  paths.slice(0, 256).forEach(loadUsageBarTemplate);
  expect(warnSpy).toHaveBeenCalledTimes(256);
  expectWarningCount(paths[0]!, 256); // Keep the oldest key hot before overflowing.
  expectWarningCount(paths[256]!, 257);
  expectWarningCount(paths[0]!, 257);
  expectWarningCount(paths[1]!, 258);
  expect(warnSpy.mock.lastCall).toEqual([
    warning,
    { source: "file", reason: "invalid-json", path: paths[1] },
  ]);
  writeTemplate(tplB, paths[1]);
  expect(loadUsageBarTemplate(paths[1])).toMatchObject(tplB);
});
it("refreshes atomic replacements and restored files, then rereads after loss of coverage", async () => {
  const file = join(directory, "template.json");
  const { template: first, subscription } = await loadObservedTemplate(file, tplA);
  await subscription.reconcile();
  expect(loadUsageBarTemplate(file)).toBe(first);
  const staged = join(directory, "staged.json");
  writeTemplate(tplB, staged);
  for (const [change, expected] of [
    [() => renameSync(staged, file), tplB],
    [() => unlinkSync(file), defaultTemplate],
    [() => writeTemplate(tplA, file), tplA],
  ] as const) {
    change();
    await subscription.reconcile();
    expect(loadUsageBarTemplate(file)).toEqual(expected);
    expect(loadUsageBarTemplate(file) === defaultTemplate).toBe(expected === defaultTemplate);
  }
  expect(warnSpy).not.toHaveBeenCalled();
  renameSync(directory, join(temp.make("usage-template-"), "retired"));
  await expect(subscription.reconcile()).rejects.toThrow();
  mkdirSync(directory);
  const replacement = await loadObservedTemplate(file, tplB);
  await replacement.subscription.reconcile();
  expect(subscription.health().state).toBe("closed");
});
it("evicts the oldest path with its observation, but retains entries when retrying a miss", async () => {
  const files = Array.from({ length: 65 }, (_, i) => join(directory, `template-${i}.json`));
  for (const file of files.slice(0, 63)) {
    await loadObservedTemplate(file, tplA);
  }
  const miss = files[63]!;
  expect(loadUsageBarTemplate(miss)).toBe(defaultTemplate);
  await loadObservedTemplate(miss, tplB);
  writeTemplate(tplB, files[0]!);
  expect([subscriptions.length, loadUsageBarTemplate(files[0])]).toEqual([64, tplA]);
  await loadObservedTemplate(files[64]!, tplA);
  expect(states()).toEqual(["closed", ...Array(64).fill("ready")]);
  await loadObservedTemplate(files[0]!, tplB, false);
  await clearUsageBarTemplateCacheForTest();
  expect(states()).toEqual(Array(66).fill("closed"));
});
