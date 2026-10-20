// Covers plugin activation context construction and lazy boundaries.
import { afterEach, describe, expect, it, vi } from "vitest";
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
afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  applyPluginAutoEnableMock.mockClear();
  withBundledPluginEnablementCompatMock.mockClear();
});

describe("withActivatedPluginIds", () => {
  it("preserves global and explicit plugin disablement", () => {
    const config = {
      plugins: {
        enabled: false,
        allow: ["owner"],
        entries: { owner: { enabled: false } },
      },
    };
    const projected = withActivatedPluginIds({ config, pluginIds: ["owner"] });
    const disabled = { enabled: false, entries: { owner: { enabled: false } } };
    expect(projected?.plugins).toMatchObject(disabled);
    expect(config.plugins).toMatchObject(disabled);
  });

  it("keeps omitted plugin ids outside restrictive allowlists", () => {
    const config = {
      plugins: {
        allow: ["memory-core"],
        deny: ["blocked"],
        entries: { disabled: { enabled: false } },
      },
    };
    expect(
      withActivatedPluginIds({ config, pluginIds: ["openai", "blocked", "disabled"] }),
    ).toEqual({
      plugins: {
        allow: ["memory-core"],
        deny: ["blocked"],
        entries: { disabled: { enabled: false } },
      },
    });
  });
});

describe("plugin activation inputs", () => {
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
    const generations = ["first", "second"].map((id) => ({
      config: configWithAllow(id),
      manifestRegistry: makeRegistry([{ id, channels: [], providers: [id] }]),
      discovery: { candidates: [], diagnostics: [] } satisfies PluginDiscoveryResult,
    }));
    for (const { config, manifestRegistry, discovery } of generations) {
      resolveBundledCompatActivationInputs({
        applyAutoEnable: true,
        rawConfig: config,
        manifestRegistry,
        discovery,
        resolveBundledPluginIds: () => [],
      });
    }

    generations.forEach(({ manifestRegistry, discovery }, index) => {
      expect(applyPluginAutoEnableMock).toHaveBeenNthCalledWith(index + 1, {
        config: configWithAllow(index === 0 ? "first" : "second"),
        manifestRegistry,
        discovery,
        env: process.env,
      });
    });
  });

  it("applies bundled enablement once after canonical auto-enable", () => {
    const rawConfig = { plugins: { allow: ["openai"] } } satisfies OpenClawConfig;
    const autoEnabledConfig = {
      plugins: { allow: ["openai"], entries: { openai: { enabled: true } } },
    } satisfies OpenClawConfig;
    const compatConfig = {
      plugins: {
        allow: ["openai", "anthropic"],
        entries: { openai: { enabled: true }, anthropic: { enabled: true } },
      },
    } satisfies OpenClawConfig;
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
});
