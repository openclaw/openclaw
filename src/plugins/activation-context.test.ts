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
vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: applyPluginAutoEnableMock,
}));
// mock-isolation: keep activation input tests independent of bundled discovery.
vi.mock("./bundled-compat.js", () => ({
  withBundledPluginEnablementCompat: (params: { config?: OpenClawConfig }) => params.config,
}));

import {
  resolveBundledCompatActivationInputs as resolveInputs,
  withActivatedPluginIds,
} from "./activation-context.js";

const workspaceDir = "/tmp/openclaw-activation-workspace";
const configWithAllow = (...allow: string[]): OpenClawConfig => ({ plugins: { allow } });
const resolveActivation = (params: Partial<Parameters<typeof resolveInputs>[0]>) =>
  resolveInputs({
    applyAutoEnable: true,
    resolveBundledPluginIds: () => [],
    ...params,
  });
afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  applyPluginAutoEnableMock.mockClear();
});

it.each<[string[], NonNullable<OpenClawConfig["plugins"]>]>([
  [["owner"], { enabled: false, allow: ["owner"], entries: { owner: { enabled: false } } }],
  [
    ["openai", "blocked", "disabled"],
    {
      allow: ["memory-core"],
      deny: ["blocked"],
      entries: { disabled: { enabled: false } },
    },
  ],
])("preserves activation restrictions for %j without mutation", (pluginIds, plugins) => {
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

  resolveActivation({ rawConfig: configWithAllow("openai"), workspaceDir });

  expect(applyPluginAutoEnableMock.mock.lastCall?.[0]).toMatchObject({ manifestRegistry });
});

it("uses the caller's exact metadata generation across lifecycle replacement", () => {
  for (const id of ["first", "second"]) {
    const manifestRegistry = makeRegistry([{ id, channels: [], providers: [id] }]);
    const discovery = { candidates: [], diagnostics: [] } satisfies PluginDiscoveryResult;
    const rawConfig = configWithAllow(id);
    const config = { plugins: { allow: [id], entries: { [id]: { enabled: true } } } };
    const autoEnabledReasons = { [id]: ["configured"] };
    applyPluginAutoEnableMock.mockReturnValueOnce({ config, changes: [], autoEnabledReasons });
    const activation = resolveActivation({ rawConfig, manifestRegistry, discovery });
    expect(activation.config).toBe(config);
    expect(activation.activationSourceConfig).toBe(rawConfig);
    expect(activation.normalized.entries[id]?.enabled).toBe(true);
    expect(activation.autoEnabledReasons).toEqual(autoEnabledReasons);
    expect(applyPluginAutoEnableMock).toHaveBeenLastCalledWith({
      config: rawConfig,
      manifestRegistry,
      discovery,
      env: process.env,
    });
  }
});
