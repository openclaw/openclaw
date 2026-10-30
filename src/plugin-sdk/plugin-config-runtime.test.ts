import { afterEach, expect, it, vi } from "vitest";
import * as snapshots from "../config/runtime-snapshot.js";
import { captureRuntimeConfig } from "../config/runtime-source-projection.js";
import * as normalization from "../plugins/config-normalization-shared.js";
import { normalizePluginsConfig as readNormalizedPluginsConfig } from "../plugins/config-state.js";
import type { OpenClawConfig } from "./config-contracts.js";
import * as runtime from "./plugin-config-runtime.js";

afterEach(() => snapshots.clearRuntimeConfigSnapshot());
const configFor = (entries: NonNullable<OpenClawConfig["plugins"]>["entries"]): OpenClawConfig => ({
  plugins: { entries },
});

it("parses published and captured plugin configs once without retaining mutable inputs", () => {
  const parse = vi.fn((value: unknown) => structuredClone(value as { nested: { value: number } }));
  const read = runtime.createPluginConfigParser("demo", parse);
  const live = { nested: { value: 1 } };
  const config = configFor({ demo: { config: live } });
  snapshots.setRuntimeConfigSnapshot(config);
  const captured = runtime.resolvePluginConfigObject(captureRuntimeConfig(config), "demo");
  const first = read(live);
  const snapshot = read(captured);
  for (let i = 0; i < 3; i++) {
    expect(read(live)).toBe(first);
    expect(read(captured)).toBe(snapshot);
  }
  expect(parse).toHaveBeenCalledTimes(2);
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(first.nested)).toBe(true);

  live.nested.value = 2;
  snapshots.setRuntimeConfigSnapshot(config);
  expect(read(live)).toEqual({ nested: { value: 2 } });
  expect(read(captured)).toBe(snapshot);
  expect(first).toEqual({ nested: { value: 1 } });
  expect(parse).toHaveBeenCalledTimes(3);

  snapshots.clearRuntimeConfigSnapshot();
  live.nested.value = 3;
  expect(read(live)).toEqual({ nested: { value: 3 } });
  live.nested.value = 4;
  expect(read(live)).toEqual({ nested: { value: 4 } });
  expect(parse).toHaveBeenCalledTimes(5);
});

it("does not cache shallow-frozen configs or thrown parse errors", () => {
  const read = runtime.createPluginConfigParser("demo", (value: unknown) => {
    const record = value as { nested: { value: number } };
    if (record.nested.value < 0) {
      throw new Error("invalid value");
    }
    return structuredClone(record);
  });
  const value = Object.freeze({ nested: { value: 1 } });
  expect(read(value).nested.value).toBe(1);
  value.nested.value = 2;
  expect(read(value).nested.value).toBe(2);
  const invalid = Object.freeze({ nested: Object.freeze({ value: -1 }) });
  expect(() => read(invalid)).toThrow("invalid value");
  expect(() => read(invalid)).toThrow("invalid value");
});

it("reuses captured plugin policy across reads and keeps revisions independent", () => {
  using normalize = vi.spyOn(normalization, "normalizePluginsConfigWithResolverCore");
  const config = configFor({ " CODEX ": { config: { revision: 1 } } });
  const captured = captureRuntimeConfig(config);
  const payload = captured.plugins!.entries![" CODEX "]!.config;
  for (let i = 0; i < 10; i++) {
    expect(runtime.resolvePluginConfigObject(captured, "codex")).toBe(payload);
    expect(readNormalizedPluginsConfig(captured.plugins).entries.codex?.config).toBe(payload);
  }
  expect(normalize).toHaveBeenCalledTimes(1);

  config.plugins!.entries![" CODEX "]!.config = { revision: 2 };
  normalize.mockClear();
  const next = captureRuntimeConfig(config);
  expect(runtime.resolvePluginConfigObject(next, "codex")).toEqual({ revision: 2 });
  expect(readNormalizedPluginsConfig(next.plugins).entries.codex?.config).toEqual({ revision: 2 });
  expect(runtime.resolvePluginConfigObject(captured, "codex")).toBe(payload);
  expect(payload).toEqual({ revision: 1 });
  expect(normalize).toHaveBeenCalledTimes(1);
});

it("resolves live enablement from prepared policy and refreshes same-object publications", () => {
  using normalize = vi.spyOn(normalization, "normalizePluginsConfigWithResolverCore");
  const config = configFor({ " CODEX ": { enabled: true } });
  snapshots.setRuntimeConfigSnapshot(config);
  const resolve = () =>
    runtime.resolveEffectiveEnableState({ id: "codex", origin: "bundled", rootConfig: config });
  normalize.mockClear();
  for (let i = 0; i < 10; i++) {
    expect(resolve()).toEqual({ enabled: true });
  }
  expect(normalize).not.toHaveBeenCalled();

  config.plugins!.entries![" CODEX "]!.enabled = false;
  snapshots.setRuntimeConfigSnapshot(config);
  normalize.mockClear();
  expect(resolve()).toEqual({ enabled: false, reason: "disabled in config" });
  expect(normalize).not.toHaveBeenCalled();

  expect(
    runtime.resolveEffectiveEnableState({
      id: "codex",
      origin: "bundled",
      rootConfig: config,
      config: runtime.normalizePluginsConfig({ entries: { codex: { enabled: true } } }),
    }),
  ).toEqual({ enabled: true });
});

it("shares absent plugin policy without borrowing a later publication's entries", () => {
  using normalize = vi.spyOn(normalization, "normalizePluginsConfigWithResolverCore");
  const captured = captureRuntimeConfig({});
  for (let i = 0; i < 3; i++) {
    expect(runtime.resolvePluginConfigObject(captured, "demo")).toBeUndefined();
    expect(readNormalizedPluginsConfig(captured.plugins).entries).toEqual({});
  }
  expect(normalize.mock.calls.length).toBeLessThanOrEqual(1);

  const published = configFor({ demo: { config: { revision: 1 } } });
  snapshots.setRuntimeConfigSnapshot(published);
  expect(runtime.resolvePluginConfigObject(published, "demo")).toEqual({ revision: 1 });
  expect(runtime.resolvePluginConfigObject(captured, "demo")).toBeUndefined();

  snapshots.setRuntimeConfigSnapshot({});
  normalize.mockClear();
  expect(runtime.resolvePluginConfigObject(captured, "demo")).toBeUndefined();
  expect(readNormalizedPluginsConfig().entries).toEqual({});
  expect(normalize).not.toHaveBeenCalled();
});

it("keeps public normalized policy mutable without changing the published host policy", () => {
  const pluginConfig = { enabled: false, mode: "strict" };
  const config = configFor({ "google-gemini-cli": { enabled: true, config: pluginConfig } });
  config.plugins!.allow = ["google"];
  snapshots.setRuntimeConfigSnapshot(config);
  const policy = runtime.normalizePluginsConfig(config.plugins);
  policy.allow.push("other");
  policy.entries.google!.enabled = false;

  expect(readNormalizedPluginsConfig(config.plugins).allow).toEqual(["google"]);
  expect(readNormalizedPluginsConfig(config.plugins).entries.google?.enabled).toBe(true);
  expect(runtime.normalizePluginsConfig(config.plugins).entries.google?.enabled).toBe(true);
  expect(runtime.resolvePluginConfigObject(config, "google")).toBe(pluginConfig);
  expect(Object.isFrozen(pluginConfig)).toBe(false);
});

it("resolves normalized object configs and rejects missing or invalid configs", () => {
  const config = configFor({
    " CODEX ": { enabled: true, config: { supervision: { enabled: true } } },
    // @ts-expect-error Exercise malformed persisted config at the runtime boundary.
    "demo-plugin": { enabled: true, config: "bad-shape" },
    // @ts-expect-error Arrays are also invalid persisted plugin config objects.
    "array-plugin": { enabled: true, config: ["bad-shape"] },
  });
  expect(
    ["codex", "missing-plugin", "demo-plugin", "array-plugin"].map((id) =>
      runtime.resolvePluginConfigObject(config, id),
    ),
  ).toEqual([{ supervision: { enabled: true } }, undefined, undefined, undefined]);
  expect(runtime.resolvePluginConfigObject(undefined, "demo-plugin")).toBeUndefined();
});

it.each([false, true])("uses startup config only without a loader (loader=%s)", (hasLoader) => {
  const startup = { enabled: true };
  const loader = hasLoader ? () => configFor({}) : undefined;
  expect(runtime.resolveLivePluginConfigObject(loader, "demo-plugin", startup)).toEqual(
    hasLoader ? undefined : startup,
  );
});
