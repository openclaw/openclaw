import { afterEach, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { normalizePluginsConfig as readNormalizedPluginsConfig } from "../plugins/config-state.js";
import type { OpenClawConfig } from "./config-contracts.js";
import {
  resolveLivePluginConfigObject,
  resolvePluginConfigObject,
  normalizePluginsConfig,
} from "./plugin-config-runtime.js";

afterEach(() => clearRuntimeConfigSnapshot());

it("keeps public normalized policy mutable without changing the published host policy", () => {
  const pluginConfig = { enabled: false, mode: "strict" };
  const config: OpenClawConfig = {
    plugins: {
      allow: ["google"],
      entries: { "google-gemini-cli": { enabled: true, config: pluginConfig } },
    },
  };
  setRuntimeConfigSnapshot(config);
  const policy = normalizePluginsConfig(config.plugins);
  policy.allow.push("other");
  policy.entries.google!.enabled = false;

  expect(readNormalizedPluginsConfig(config.plugins).allow).toEqual(["google"]);
  expect(readNormalizedPluginsConfig(config.plugins).entries.google?.enabled).toBe(true);
  expect(normalizePluginsConfig(config.plugins).entries.google?.enabled).toBe(true);
  expect(resolvePluginConfigObject(config, "google")).toBe(pluginConfig);
  expect(Object.isFrozen(pluginConfig)).toBe(false);
});

it("resolves normalized object configs and rejects missing or invalid configs", () => {
  const config: OpenClawConfig = {
    plugins: {
      entries: {
        " CODEX ": { enabled: true, config: { supervision: { enabled: true } } },
        // @ts-expect-error Exercise malformed persisted config at the runtime boundary.
        "demo-plugin": { enabled: true, config: "bad-shape" },
        // @ts-expect-error Arrays are also invalid persisted plugin config objects.
        "array-plugin": { enabled: true, config: ["bad-shape"] },
      },
    },
  };
  const cases = [
    [config, "codex", { supervision: { enabled: true } }],
    [config, "missing-plugin", undefined],
    [config, "demo-plugin", undefined],
    [config, "array-plugin", undefined],
    [undefined, "demo-plugin", undefined],
  ] as const;
  for (const [input, id, expected] of cases) {
    expect(resolvePluginConfigObject(input, id)).toEqual(expected);
  }
});

it.each([false, true])("uses startup config only without a loader (loader=%s)", (hasLoader) => {
  const startup = { enabled: true };
  expect(
    resolveLivePluginConfigObject(
      hasLoader ? () => ({ plugins: { entries: {} } }) : undefined,
      "demo-plugin",
      startup,
    ),
  ).toEqual(hasLoader ? undefined : startup);
});
