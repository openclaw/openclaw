import { afterEach, expect, it, vi } from "vitest";
import * as snapshots from "../config/runtime-snapshot.js";
import * as normalization from "../plugins/config-normalization-shared.js";
import { normalizePluginsConfig as readNormalizedPluginsConfig } from "../plugins/config-state.js";
import type { OpenClawConfig } from "./config-contracts.js";
import * as runtime from "./plugin-config-runtime.js";

afterEach(() => snapshots.clearRuntimeConfigSnapshot());
const configFor = (entries: NonNullable<OpenClawConfig["plugins"]>["entries"]): OpenClawConfig => ({
  plugins: { entries },
});

it("reuses captured plugin policy across reads and keeps revisions independent", () => {
  using normalize = vi.spyOn(normalization, "normalizePluginsConfigWithResolverCore");
  const config = configFor({ " CODEX ": { config: { revision: 1 } } });
  snapshots.setRuntimeConfigSnapshot(config);
  const captured = snapshots.getRuntimeConfigSnapshot({ capture: true })!;
  const payload = captured.plugins!.entries![" CODEX "]!.config;
  normalize.mockClear();
  for (let i = 0; i < 10; i++) {
    expect(runtime.resolvePluginConfigObject(captured, "codex")).toBe(payload);
  }
  expect(normalize).not.toHaveBeenCalled();

  config.plugins!.entries![" CODEX "]!.config = { revision: 2 };
  snapshots.setRuntimeConfigSnapshot(config);
  const next = snapshots.getRuntimeConfigSnapshot({ capture: true })!;
  snapshots.clearRuntimeConfigSnapshot();
  normalize.mockClear();
  expect(runtime.resolvePluginConfigObject(next, "codex")).toEqual({ revision: 2 });
  expect(runtime.resolvePluginConfigObject(captured, "codex")).toBe(payload);
  expect(payload).toEqual({ revision: 1 });
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
