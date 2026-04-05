import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bundledPluginRoot,
  bundledPluginRootAt,
} from "../../../test/helpers/bundled-plugin-paths.js";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const existsSync = vi.fn();
  return {
    ...actual,
    existsSync,
    default: {
      ...actual,
      existsSync,
    },
  };
});

const installPluginFromNpmSpec = vi.fn();
const applyPluginAutoEnable = vi.fn();
vi.mock("../../plugins/install.js", () => ({
  installPluginFromNpmSpec: (...args: unknown[]) => installPluginFromNpmSpec(...args),
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: unknown[]) => applyPluginAutoEnable(...args),
}));

const resolveBundledPluginSources = vi.fn();
const getChannelPluginCatalogEntry = vi.fn();
vi.mock("../../channels/plugins/catalog.js", async () => {
  const actual = await vi.importActual<typeof import("../../channels/plugins/catalog.js")>(
    "../../channels/plugins/catalog.js",
  );
  return {
    ...actual,
    getChannelPluginCatalogEntry: (...args: unknown[]) => getChannelPluginCatalogEntry(...args),
  };
});

const loadPluginManifestRegistry = vi.fn();
vi.mock("../../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: (...args: unknown[]) => loadPluginManifestRegistry(...args),
}));

vi.mock("../../plugins/bundled-sources.js", () => ({
  findBundledPluginSourceInMap: ({
    bundled,
    lookup,
  }: {
    bundled: ReadonlyMap<string, { pluginId: string; localPath: string; npmSpec?: string }>;
    lookup: { kind: "pluginId" | "npmSpec"; value: string };
  }) => {
    const targetValue = lookup.value.trim();
    if (!targetValue) {
      return undefined;
    }
    if (lookup.kind === "pluginId") {
      return bundled.get(targetValue);
    }
    for (const source of bundled.values()) {
      if (source.npmSpec === targetValue) {
        return source;
      }
    }
    return undefined;
  },
  resolveBundledPluginSources: (...args: unknown[]) => resolveBundledPluginSources(...args),
}));

vi.mock("../../plugins/loader.js", () => ({
  loadMullusiPlugins: vi.fn(),
}));

const clearPluginDiscoveryCache = vi.fn();
vi.mock("../../plugins/discovery.js", () => ({
  clearPluginDiscoveryCache: () => clearPluginDiscoveryCache(),
}));

import fs from "node:fs";
import type { ChannelPluginCatalogEntry } from "../../channels/plugins/catalog.js";
import type { MullusiConfig } from "../../config/config.js";
import { loadMullusiPlugins } from "../../plugins/loader.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import {
  pinActivePluginChannelRegistry,
  releasePinnedPluginChannelRegistry,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { makePrompter, makeRuntime } from "../setup/__tests__/test-utils.js";
import {
  ensureChannelSetupPluginInstalled,
  loadChannelSetupPluginRegistrySnapshotForChannel,
  reloadChannelSetupPluginRegistry,
  reloadChannelSetupPluginRegistryForChannel,
} from "./plugin-install.js";

const baseEntry: ChannelPluginCatalogEntry = {
  id: "zalo",
  pluginId: "zalo",
  meta: {
    id: "zalo",
    label: "Zalo",
    selectionLabel: "Zalo (Bot API)",
    docsPath: "/channels/zalo",
    docsLabel: "zalo",
    blurb: "Test",
  },
  install: {
    npmSpec: "@mullusi/zalo",
    localPath: bundledPluginRoot("zalo"),
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  applyPluginAutoEnable.mockImplementation((params: { config: unknown }) => ({
    config: params.config,
    changes: [],
    autoEnabledReasons: {},
  }));
  resolveBundledPluginSources.mockReturnValue(new Map());
  getChannelPluginCatalogEntry.mockReturnValue(undefined);
  loadPluginManifestRegistry.mockReturnValue({ plugins: [], diagnostics: [] });
  setActivePluginRegistry(createEmptyPluginRegistry());
});

function mockRepoLocalPathExists() {
  vi.mocked(fs.existsSync).mockImplementation((value) => {
    const raw = String(value);
    return raw.endsWith(`${path.sep}.git`) || raw.endsWith(`${path.sep}extensions${path.sep}zalo`);
  });
}

async function runInitialValueForChannel(channel: "dev" | "beta") {
  const runtime = makeRuntime();
  const select = vi.fn((async <T extends string>() => "skip" as T) as WizardPrompter["select"]);
  const prompter = makePrompter({ select: select as unknown as WizardPrompter["select"] });
  const cfg: MullusiConfig = { update: { channel } };
  mockRepoLocalPathExists();

  await ensureChannelSetupPluginInstalled({
    cfg,
    entry: baseEntry,
    prompter,
    runtime,
  });

  const call = select.mock.calls[0];
  return call?.[0]?.initialValue;
}

function expectPluginLoadedFromLocalPath(
  result: Awaited<ReturnType<typeof ensureChannelSetupPluginInstalled>>,
) {
  const expectedPath = path.resolve(process.cwd(), bundledPluginRoot("zalo"));
  expect(result.installed).toBe(true);
  expect(result.cfg.plugins?.load?.paths).toContain(expectedPath);
}

describe("ensureChannelSetupPluginInstalled", () => {
  it("installs from npm and enables the plugin", async () => {
    const runtime = makeRuntime();
    const prompter = makePrompter({
      select: vi.fn(async () => "npm") as WizardPrompter["select"],
    });
    const cfg: MullusiConfig = { plugins: { allow: ["other"] } };
    vi.mocked(fs.existsSync).mockReturnValue(false);
    installPluginFromNpmSpec.mockResolvedValue({
      ok: true,
      pluginId: "zalo",
      targetDir: "/tmp/zalo",
      extensions: [],
    });

    const result = await ensureChannelSetupPluginInstalled({
      cfg,
      entry: baseEntry,
      prompter,
      runtime,
    });

    expect(result.installed).toBe(true);
    expect(result.cfg.plugins?.entries?.zalo?.enabled).toBe(true);
    expect(result.cfg.plugins?.allow).toContain("zalo");
    expect(result.cfg.plugins?.installs?.zalo?.source).toBe("npm");
    expect(result.cfg.plugins?.installs?.zalo?.spec).toBe("@mullusi/zalo");
    expect(result.cfg.plugins?.installs?.zalo?.installPath).toBe("/tmp/zalo");
    expect(installPluginFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({ spec: "@mullusi/zalo" }),
    );
  });

  it("uses local path when selected", async () => {
    const runtime = makeRuntime();
    const prompter = makePrompter({
      select: vi.fn(async () => "local") as WizardPrompter["select"],
    });
    const cfg: MullusiConfig = {};
    mockRepoLocalPathExists();

    const result = await ensureChannelSetupPluginInstalled({
      cfg,
      entry: baseEntry,
      prompter,
      runtime,
    });

    expectPluginLoadedFromLocalPath(result);
    expect(result.cfg.plugins?.entries?.zalo?.enabled).toBe(true);
  });

  it("uses the catalog plugin id for local-path installs", async () => {
    const runtime = makeRuntime();
    const prompter = makePrompter({
      select: vi.fn(async () => "local") as WizardPrompter["select"],
    });
    const cfg: MullusiConfig = {};
    mockRepoLocalPathExists();

    const result = await ensureChannelSetupPluginInstalled({
      cfg,
      entry: {
        ...baseEntry,
        id: "teams",
        pluginId: "@mullusi/msteams-plugin",
      },
      prompter,
      runtime,
    });

    expect(result.installed).toBe(true);
    expect(result.pluginId).toBe("@mullusi/msteams-plugin");
    expect(result.cfg.plugins?.entries?.["@mullusi/msteams-plugin"]?.enabled).toBe(true);
  });

  it("defaults to local on dev channel when local path exists", async () => {
    expect(await runInitialValueForChannel("dev")).toBe("local");
  });

  it("defaults to npm on beta channel even when local path exists", async () => {
    expect(await runInitialValueForChannel("beta")).toBe("npm");
  });

  it("defaults to bundled local path on beta channel when available", async () => {
    const runtime = makeRuntime();
    const select = vi.fn((async <T extends string>() => "skip" as T) as WizardPrompter["select"]);
    const prompter = makePrompter({ select: select as unknown as WizardPrompter["select"] });
    const cfg: MullusiConfig = { update: { channel: "beta" } };
    vi.mocked(fs.existsSync).mockReturnValue(false);
    resolveBundledPluginSources.mockReturnValue(
      new Map([
        [
          "zalo",
          {
            pluginId: "zalo",
            localPath: bundledPluginRootAt("/opt/mullusi", "zalo"),
            npmSpec: "@mullusi/zalo",
          },
        ],
      ]),
    );

    await ensureChannelSetupPluginInstalled({
      cfg,
      entry: baseEntry,
      prompter,
      runtime,
    });

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: "local",
        options: expect.arrayContaining([
          expect.objectContaining({
            value: "local",
            hint: bundledPluginRootAt("/opt/mullusi", "zalo"),
          }),
        ]),
      }),
    );
  });

  it("does not default to bundled local path when an external catalog overrides the npm spec", async () => {
    const runtime = makeRuntime();
    const select = vi.fn((async <T extends string>() => "skip" as T) as WizardPrompter["select"]);
    const prompter = makePrompter({ select: select as unknown as WizardPrompter["select"] });
    const cfg: MullusiConfig = { update: { channel: "beta" } };
    vi.mocked(fs.existsSync).mockReturnValue(false);
    resolveBundledPluginSources.mockReturnValue(
      new Map([
        [
          "whatsapp",
          {
            pluginId: "whatsapp",
            localPath: bundledPluginRootAt("/opt/mullusi", "whatsapp"),
            npmSpec: "@mullusi/whatsapp",
          },
        ],
      ]),
    );

    await ensureChannelSetupPluginInstalled({
      cfg,
      entry: {
        id: "whatsapp",
        meta: {
          id: "whatsapp",
          label: "WhatsApp",
          selectionLabel: "WhatsApp",
          docsPath: "/channels/whatsapp",
          blurb: "Test",
        },
        install: {
          npmSpec: "@vendor/whatsapp-fork",
        },
      },
      prompter,
      runtime,
    });

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: "npm",
        options: [
          expect.objectContaining({
            value: "npm",
            label: "Download from npm (@vendor/whatsapp-fork)",
          }),
          expect.objectContaining({
            value: "skip",
          }),
        ],
      }),
    );
  });

  it("falls back to local path after npm install failure", async () => {
    const runtime = makeRuntime();
    const note = vi.fn(async () => {});
    const confirm = vi.fn(async () => true);
    const prompter = makePrompter({
      select: vi.fn(async () => "npm") as WizardPrompter["select"],
      note,
      confirm,
    });
    const cfg: MullusiConfig = {};
    mockRepoLocalPathExists();
    installPluginFromNpmSpec.mockResolvedValue({
      ok: false,
      error: "nope",
    });

    const result = await ensureChannelSetupPluginInstalled({
      cfg,
      entry: baseEntry,
      prompter,
      runtime,
    });

    expectPluginLoadedFromLocalPath(result);
    expect(note).toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("clears discovery cache before reloading the setup plugin registry", () => {
    const runtime = makeRuntime();
    const cfg: MullusiConfig = {};

    reloadChannelSetupPluginRegistry({
      cfg,
      runtime,
      workspaceDir: "/tmp/mullusi-workspace",
    });

    expect(clearPluginDiscoveryCache).toHaveBeenCalledTimes(1);
    expect(loadMullusiPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config: cfg,
        activationSourceConfig: cfg,
        autoEnabledReasons: {},
        workspaceDir: "/tmp/mullusi-workspace",
        cache: false,
        includeSetupOnlyChannelPlugins: true,
      }),
    );
    expect(clearPluginDiscoveryCache.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(loadMullusiPlugins).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("loads the setup plugin registry from the auto-enabled config snapshot", () => {
    const runtime = makeRuntime();
    const cfg: MullusiConfig = {
      plugins: {},
      channels: { telegram: { enabled: true } } as never,
    };
    const autoEnabledConfig = {
      ...cfg,
      plugins: {
        entries: {
          telegram: { enabled: true },
        },
      },
    } as MullusiConfig;
    applyPluginAutoEnable.mockReturnValue({
      config: autoEnabledConfig,
      changes: [],
      autoEnabledReasons: {},
    });

    reloadChannelSetupPluginRegistry({
      cfg,
      runtime,
      workspaceDir: "/tmp/mullusi-workspace",
    });

    expect(applyPluginAutoEnable).toHaveBeenCalledWith({
      config: cfg,
      env: process.env,
    });
    expect(loadMullusiPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config: autoEnabledConfig,
        activationSourceConfig: cfg,
        autoEnabledReasons: {},
      }),
    );
  });

  it("scopes channel reloads when setup starts from an empty registry", () => {
    const runtime = makeRuntime();
    const cfg: MullusiConfig = {};
    getChannelPluginCatalogEntry.mockReturnValue({ pluginId: "@mullusi/telegram-plugin" });

    reloadChannelSetupPluginRegistryForChannel({
      cfg,
      runtime,
      channel: "telegram",
      workspaceDir: "/tmp/mullusi-workspace",
    });

    expect(loadMullusiPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config: cfg,
        activationSourceConfig: cfg,
        autoEnabledReasons: {},
        workspaceDir: "/tmp/mullusi-workspace",
        cache: false,
        onlyPluginIds: ["@mullusi/telegram-plugin"],
        includeSetupOnlyChannelPlugins: true,
      }),
    );
  });

  it("keeps full reloads when the active plugin registry is already populated", () => {
    const runtime = makeRuntime();
    const cfg: MullusiConfig = {};
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      createPluginRecord({
        id: "loaded",
        name: "loaded",
        source: "/tmp/loaded.cjs",
        origin: "bundled",
        configSchema: true,
      }),
    );
    setActivePluginRegistry(registry);

    reloadChannelSetupPluginRegistryForChannel({
      cfg,
      runtime,
      channel: "telegram",
      workspaceDir: "/tmp/mullusi-workspace",
    });

    expect(loadMullusiPlugins).toHaveBeenCalledWith(
      expect.not.objectContaining({
        onlyPluginIds: expect.anything(),
      }),
    );
  });

  it("scopes channel reloads when the global registry is populated but the pinned channel registry is empty", () => {
    const runtime = makeRuntime();
    const cfg: MullusiConfig = {};
    getChannelPluginCatalogEntry.mockReturnValue({ pluginId: "@mullusi/telegram-plugin" });
    const activeRegistry = createEmptyPluginRegistry();
    activeRegistry.plugins.push(
      createPluginRecord({
        id: "loaded-tools",
        name: "loaded-tools",
        source: "/tmp/loaded-tools.cjs",
        origin: "bundled",
      }),
    );
    setActivePluginRegistry(activeRegistry);
    const pinnedChannelRegistry = createEmptyPluginRegistry();
    pinActivePluginChannelRegistry(pinnedChannelRegistry);

    try {
      reloadChannelSetupPluginRegistryForChannel({
        cfg,
        runtime,
        channel: "telegram",
        workspaceDir: "/tmp/mullusi-workspace",
      });
    } finally {
      releasePinnedPluginChannelRegistry(pinnedChannelRegistry);
    }

    expect(loadMullusiPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        activationSourceConfig: cfg,
        autoEnabledReasons: {},
        onlyPluginIds: ["@mullusi/telegram-plugin"],
      }),
    );
  });

  it("can load a channel-scoped snapshot without activating the global registry", () => {
    const runtime = makeRuntime();
    const cfg: MullusiConfig = {};
    getChannelPluginCatalogEntry.mockReturnValue({ pluginId: "@mullusi/telegram-plugin" });

    loadChannelSetupPluginRegistrySnapshotForChannel({
      cfg,
      runtime,
      channel: "telegram",
      workspaceDir: "/tmp/mullusi-workspace",
    });

    expect(loadMullusiPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config: cfg,
        activationSourceConfig: cfg,
        autoEnabledReasons: {},
        workspaceDir: "/tmp/mullusi-workspace",
        cache: false,
        onlyPluginIds: ["@mullusi/telegram-plugin"],
        includeSetupOnlyChannelPlugins: true,
        activate: false,
      }),
    );
  });

  it("does not scope by raw channel id when no trusted plugin mapping exists", () => {
    const runtime = makeRuntime();
    const cfg: MullusiConfig = {};

    loadChannelSetupPluginRegistrySnapshotForChannel({
      cfg,
      runtime,
      channel: "telegram",
      workspaceDir: "/tmp/mullusi-workspace",
    });

    expect(loadMullusiPlugins).toHaveBeenCalledWith(
      expect.not.objectContaining({
        onlyPluginIds: expect.anything(),
      }),
    );
  });

  it("scopes snapshots by a unique discovered manifest match when catalog mapping is missing", () => {
    const runtime = makeRuntime();
    const cfg: MullusiConfig = {};
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "custom-telegram-plugin", channels: ["telegram"] }],
      diagnostics: [],
    });

    loadChannelSetupPluginRegistrySnapshotForChannel({
      cfg,
      runtime,
      channel: "telegram",
      workspaceDir: "/tmp/mullusi-workspace",
    });

    expect(loadMullusiPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config: cfg,
        activationSourceConfig: cfg,
        autoEnabledReasons: {},
        workspaceDir: "/tmp/mullusi-workspace",
        cache: false,
        onlyPluginIds: ["custom-telegram-plugin"],
        includeSetupOnlyChannelPlugins: true,
        activate: false,
      }),
    );
  });

  it("scopes snapshots by plugin id when channel and plugin ids differ", () => {
    const runtime = makeRuntime();
    const cfg: MullusiConfig = {};

    loadChannelSetupPluginRegistrySnapshotForChannel({
      cfg,
      runtime,
      channel: "msteams",
      pluginId: "@mullusi/msteams-plugin",
      workspaceDir: "/tmp/mullusi-workspace",
    });

    expect(loadMullusiPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config: cfg,
        activationSourceConfig: cfg,
        autoEnabledReasons: {},
        workspaceDir: "/tmp/mullusi-workspace",
        cache: false,
        onlyPluginIds: ["@mullusi/msteams-plugin"],
        includeSetupOnlyChannelPlugins: true,
        activate: false,
      }),
    );
  });
});
