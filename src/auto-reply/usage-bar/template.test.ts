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
const writeJSON = (file: string, data: object) => writeFileSync(file, JSON.stringify(data));
function expectWarningCount(file: string, count: number) {
  expect(loadUsageBarTemplate(file)).toBe(defaultTemplate);
  expect(warnSpy).toHaveBeenCalledTimes(count);
}
function tmpFile(name: string, contents: string, directory = temp.make("usage-template-")): string {
  const file = join(directory, name);
  writeFileSync(file, contents);
  return file;
}
async function loadObservedTemplate(path: string, expected: object, write = true) {
  if (write) {
    writeJSON(path, expected);
  }
  const started = created.promise;
  const template = loadUsageBarTemplate(path);
  expect(template).toEqual(expected);
  const subscription = await started;
  await subscription.ready;
  return { template, subscription };
}
it.each([
  [(): undefined => undefined, []],
  [() => ({ nope: true }), [[warning, { source: "inline", reason: "unsupported-shape" }]]],
  [() => tmpFile("empty.json", '{"output":{"default":[]}}'), []],
] as const)("uses the built-in template for input %#", (configured, warnings) => {
  expect(loadUsageBarTemplate(configured())).toBe(defaultTemplate);
  expect(warnSpy.mock.calls).toEqual(warnings);
});
it("reloads a path after invalid JSON is fixed", () => {
  const path = tmpFile("bad.json", "{ not json");
  expectWarningCount(path, 1);
  writeJSON(path, tplB);
  expect(loadUsageBarTemplate(path)).toMatchObject(tplB);
});
it("bounds invalid-template warnings by least-recently-used path", () => {
  const dir = temp.make("usage-template-");
  const paths = Array.from({ length: 257 }, (_, i) => tmpFile(`${i}.json`, "{ not json", dir));
  for (const path of paths.slice(0, 256)) {
    expect(loadUsageBarTemplate(path)).toBe(defaultTemplate);
  }
  expect(warnSpy).toHaveBeenCalledTimes(256);
  expectWarningCount(paths[0]!, 256); // Keep the oldest key hot before overflowing.
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
  const directory = temp.make("usage-template-");
  const file = join(directory, "template.json");
  const { template: first, subscription } = await loadObservedTemplate(file, tplA);
  await subscription.reconcile();
  expect(loadUsageBarTemplate(file)).toBe(first);
  const staged = join(directory, "staged.json");
  async function update(next: object, atomic = false) {
    writeJSON(atomic ? staged : file, next);
    if (atomic) {
      renameSync(staged, file);
    }
    await subscription.reconcile();
    expect(loadUsageBarTemplate(file)).toEqual(next);
  }
  await update(tplB, true);
  await update(tplA, true);
  unlinkSync(file);
  await subscription.reconcile();
  expect(loadUsageBarTemplate(file)).toBe(defaultTemplate);
  await update(tplA);
  await update(tplB, true);
  expect(warnSpy).not.toHaveBeenCalled();
  renameSync(directory, join(temp.make("usage-template-"), "retired"));
  await expect(subscription.reconcile()).rejects.toThrow();
  mkdirSync(directory);
  const replacement = await loadObservedTemplate(file, tplB);
  await replacement.subscription.reconcile();
  expect(subscription.health().state).toBe("closed");
});
it("evicts the oldest path with its observation, but retains entries when retrying a miss", async () => {
  const directory = temp.make("usage-template-");
  const files = Array.from({ length: 65 }, (_, i) => join(directory, `template-${i}.json`));
  for (const file of files.slice(0, 63)) {
    await loadObservedTemplate(file, tplA);
  }
  const miss = files[63]!;
  expect(loadUsageBarTemplate(miss)).toBe(defaultTemplate);
  await loadObservedTemplate(miss, tplB);
  writeJSON(files[0]!, tplB);
  expect([subscriptions.length, loadUsageBarTemplate(files[0])]).toEqual([64, tplA]);
  await loadObservedTemplate(files[64]!, tplA);
  expect(states()).toEqual(["closed", ...Array(64).fill("ready")]);
  await loadObservedTemplate(files[0]!, tplB, false);
  await clearUsageBarTemplateCacheForTest();
  expect(states()).toEqual(Array(66).fill("closed"));
});
