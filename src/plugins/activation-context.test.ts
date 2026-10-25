import { afterEach, expect, it, vi } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setCurrentPluginMetadataSnapshot } from "./current-plugin-metadata.test-support.js";
import type { PluginDiscoveryResult } from "./discovery.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";

const applyPluginAutoEnableMock = vi.hoisted(() =>
  vi.fn((params: { config?: OpenClawConfig }) => ({
    config: params.config,
    changes: [],
    autoEnabledReasons: {},
  })),
);
const withBundledPluginEnablementCompatMock = vi.hoisted(() =>
  vi.fn((params: { config?: OpenClawConfig }) => params.config),
);

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: applyPluginAutoEnableMock,
}));
vi.mock("./bundled-compat.js", () => ({
  withBundledPluginEnablementCompat: withBundledPluginEnablementCompatMock,
}));

import {
  resolveBundledCompatActivationInputs,
  withActivatedPluginIds,
} from "./activation-context.js";

const workspaceDir = "/tmp/openclaw-activation-workspace";
const configWithAllow = (...allow: string[]): OpenClawConfig => ({ plugins: { allow } });
const enabledConfig = (...ids: string[]): OpenClawConfig => ({
  plugins: { allow: ids, entries: Object.fromEntries(ids.map((id) => [id, { enabled: true }])) },
});
afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  applyPluginAutoEnableMock.mockClear();
  withBundledPluginEnablementCompatMock.mockClear();
});

it.each<{ name: string; pluginIds: string[]; plugins: NonNullable<OpenClawConfig["plugins"]> }>([
  {
    name: "global and explicit disablement",
    pluginIds: ["owner"],
    plugins: { enabled: false, allow: ["owner"], entries: { owner: { enabled: false } } },
  },
  {
    name: "restrictive allowlists",
    pluginIds: ["openai", "blocked", "disabled"],
    plugins: {
      allow: ["memory-core"],
      deny: ["blocked"],
      entries: { disabled: { enabled: false } },
    },
  },
])("preserves $name without mutating the config", ({ plugins, pluginIds }) => {
  const config = { plugins };
  const expected = structuredClone(config);
  expect(withActivatedPluginIds({ config, pluginIds })).toEqual(expected);
  expect(config).toEqual(expected);
});
it("passes the current manifest registry into activation auto-enable", () => {
  const manifestRegistry = makeRegistry([{ id: "openai", channels: [], providers: ["openai"] }]);
  const context = { config: {}, workspaceDir };
  setCurrentPluginMetadataSnapshot(
    createPluginMetadataSnapshot({ ...context, manifestRegistry }),
    context,
  );

  resolveBundledCompatActivationInputs({
    applyAutoEnable: true,
    rawConfig: configWithAllow("openai"),
    workspaceDir,
    resolveBundledPluginIds: () => [],
  });

  expect(applyPluginAutoEnableMock).toHaveBeenCalledWith({
    config: configWithAllow("openai"),
    env: process.env,
    manifestRegistry,
  });
});

it("uses the caller's exact metadata generation across lifecycle replacement", () => {
  const generations = ["first", "second"].map((id) => {
    const manifestRegistry = makeRegistry([{ id, channels: [], providers: [id] }]);
    const discovery = { candidates: [], diagnostics: [] } satisfies PluginDiscoveryResult;
    resolveBundledCompatActivationInputs({
      applyAutoEnable: true,
      rawConfig: configWithAllow(id),
      manifestRegistry,
      discovery,
      resolveBundledPluginIds: () => [],
    });
    return { config: configWithAllow(id), manifestRegistry, discovery, env: process.env };
  });

  generations.forEach((expected, index) => {
    expect(applyPluginAutoEnableMock).toHaveBeenNthCalledWith(index + 1, expected);
  });
});

it("applies bundled enablement once after canonical auto-enable", () => {
  const rawConfig = configWithAllow("openai");
  const autoEnabledConfig = enabledConfig("openai");
  const compatConfig = enabledConfig("openai", "anthropic");
  const resolveBundledPluginIds = vi.fn(() => ["anthropic"]);
  applyPluginAutoEnableMock.mockReturnValueOnce({
    config: autoEnabledConfig,
    changes: [],
    autoEnabledReasons: { openai: ["configured"] },
  });
  withBundledPluginEnablementCompatMock.mockReturnValueOnce(compatConfig);

  const activation = resolveBundledCompatActivationInputs({
    applyAutoEnable: true,
    rawConfig,
    env: process.env,
    workspaceDir,
    onlyPluginIds: ["anthropic"],
    resolveBundledPluginIds,
  });

  expect(resolveBundledPluginIds).toHaveBeenCalledWith({
    config: autoEnabledConfig,
    workspaceDir,
    env: process.env,
    onlyPluginIds: ["anthropic"],
  });
  expect(withBundledPluginEnablementCompatMock).toHaveBeenCalledOnce();
  expect(withBundledPluginEnablementCompatMock).toHaveBeenCalledWith({
    config: autoEnabledConfig,
    pluginIds: ["anthropic"],
    env: process.env,
  });
  expect(activation.config).toBe(compatConfig);
  expect(activation.normalized.entries.anthropic?.enabled).toBe(true);
  expect(activation.activationSourceConfig).toBe(rawConfig);
  expect(activation.autoEnabledReasons).toEqual({ openai: ["configured"] });
});
