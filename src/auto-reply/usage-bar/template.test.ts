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
    expect(options.persistent).toBe(false);
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
function writeTemplate(data: object | string, file = join(directory, "template.json")) {
  writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
  return file;
}
function expectWarningCount(file: string, count: number) {
  expect(loadUsageBarTemplate(file)).toBe(defaultTemplate);
  expect(warnSpy).toHaveBeenCalledTimes(count);
}
async function loadObservedTemplate(path: string, expected: object) {
  created = createDeferredCore<observation.WatchSubscription>();
  expect(loadUsageBarTemplate(path)).toEqual(expected);
  const subscription = await created.promise;
  await subscription.ready;
  return subscription;
}
it.each([
  [() => ({ nope: true }), 1],
  [() => writeTemplate({ output: { default: [] } }), 0],
] as const)("uses the built-in template for input %#", (configured, warnings) => {
  expect(loadUsageBarTemplate(configured())).toBe(defaultTemplate);
  expect(warnSpy).toHaveBeenCalledTimes(warnings);
});
it("bounds invalid-template warnings by LRU path and reloads corrected JSON", () => {
  const paths = Array.from({ length: 257 }, (_, i) =>
    writeTemplate("{ not json", join(directory, `${i}.json`)),
  );
  paths.slice(0, 256).forEach(loadUsageBarTemplate);
  expectWarningCount(paths[0]!, 256); // Keep the oldest key hot before overflowing.
  expectWarningCount(paths[256]!, 257);
  expectWarningCount(paths[0]!, 257);
  expectWarningCount(paths[1]!, 258);
  writeTemplate(tplB, paths[1]);
  expect(loadUsageBarTemplate(paths[1])).toMatchObject(tplB);
});
it("refreshes atomic replacements and restored files, then rereads after loss of coverage", async () => {
  const file = join(directory, "template.json");
  const subscription = await loadObservedTemplate(writeTemplate(tplA, file), tplA);
  const first = loadUsageBarTemplate(file);
  await subscription.reconcile();
  expect(loadUsageBarTemplate(file)).toBe(first);
  for (const [change, expected] of [
    [() => renameSync(writeTemplate(tplB, `${file}.new`), file), tplB],
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
  await loadObservedTemplate(writeTemplate(tplB, file), tplB);
  expect(subscription.health().state).toBe("closed");
});
it("evicts the oldest path with its observation, but retains entries when retrying a miss", async () => {
  const files = Array.from({ length: 65 }, (_, i) => join(directory, `template-${i}.json`));
  for (const file of files.slice(0, 63)) {
    await loadObservedTemplate(writeTemplate(tplA, file), tplA);
  }
  expect(loadUsageBarTemplate(files[63])).toBe(defaultTemplate);
  await loadObservedTemplate(writeTemplate(tplB, files[63]!), tplB);
  writeTemplate(tplB, files[0]!);
  expect(loadUsageBarTemplate(files[0])).toEqual(tplA);
  await loadObservedTemplate(writeTemplate(tplA, files[64]!), tplA);
  expect(states()).toEqual(["closed", ...Array(64).fill("ready")]);
  await loadObservedTemplate(files[0]!, tplB);
  await clearUsageBarTemplateCacheForTest();
  expect(states()).toEqual(Array(66).fill("closed"));
});
