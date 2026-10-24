// Covers channel-driven plugin auto-enable decisions.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";

const envSecondaryCatalogEntry = catalogEntry("env-secondary", "Env Secondary", ["env-primary"]);

const logWarnSpy = vi.hoisted(() => vi.fn());

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: logWarnSpy }),
}));

import {
  applyPluginAutoEnable,
  materializePluginAutoEnableCandidates,
} from "./plugin-auto-enable.js";
import {
  makeApnChannelConfig,
  makeIsolatedEnv,
  makeRegistry,
  makeTempDir,
  resetPluginAutoEnableTestState,
} from "./plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "./types.openclaw.js";

type ManifestPlugin = Parameters<typeof makeRegistry>[0][number];
function autoEnable(config: OpenClawConfig, ...plugins: ManifestPlugin[]) {
  return applyPluginAutoEnable({
    config,
    env: makeIsolatedEnv(),
    manifestRegistry: makeRegistry(plugins),
  });
}
function channelConfig(
  id: string,
  settings: Record<string, unknown>,
  plugins?: OpenClawConfig["plugins"],
): OpenClawConfig {
  return { channels: { [id]: settings }, ...(plugins ? { plugins } : {}) };
}
function preferredChannel(
  id: string,
  channel: string,
  preferOver: string[],
  options: { label?: string; origin?: ManifestPlugin["origin"] } = {},
): ManifestPlugin {
  const { origin, ...metadata } = options;
  return {
    id,
    channels: [channel],
    origin,
    channelConfigs: { [channel]: { schema: { type: "object" }, preferOver, ...metadata } },
  };
}
function catalogFile(stateDir: string) {
  const file = path.join(stateDir, "plugins", "catalog.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}
function catalogEntry(id: string, label: string, preferOver?: string[]) {
  return {
    name: `@openclaw/${id}`,
    openclaw: {
      channel: {
        id,
        label,
        selectionLabel: label,
        docsPath: `/channels/${id}`,
        blurb: `Env ${id === "env-primary" ? "primary" : "secondary"} entry`,
        ...(preferOver ? { preferOver } : {}),
      },
      install: { npmSpec: `@openclaw/${id}` },
    },
  };
}
function writeCatalog(file: string, ...entries: ReturnType<typeof catalogEntry>[]) {
  fs.writeFileSync(file, JSON.stringify({ entries }), "utf8");
}

function materializeEnvCatalogCandidates(stateDir: string) {
  return materializePluginAutoEnableCandidates({
    config: {
      channels: {
        "env-primary": { token: "primary" },
        "env-secondary": { token: "secondary" },
      },
    },
    candidates: [
      { pluginId: "env-primary", kind: "channel-configured", channelId: "env-primary" },
      { pluginId: "env-secondary", kind: "channel-configured", channelId: "env-secondary" },
    ],
    env: {
      ...makeIsolatedEnv(),
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
    },
    manifestRegistry: makeRegistry([]),
  });
}

beforeEach(() => {
  resetPluginAutoEnableTestState();
});

afterEach(() => {
  resetPluginAutoEnableTestState();
  logWarnSpy.mockClear();
});

describe("applyPluginAutoEnable channels", () => {
  it("shares external catalog preferences with UI reads across auto-enable passes", () => {
    const stateDir = makeTempDir();
    const catalogPath = catalogFile(stateDir);
    writeCatalog(catalogPath, catalogEntry("env-primary", "Env Primary"), envSecondaryCatalogEntry);

    const catalog = getChannelPluginCatalogEntry("env-secondary", {
      catalogPaths: [catalogPath],
      officialCatalogPaths: [path.join(stateDir, "missing-official.json")],
      env: makeIsolatedEnv(),
      discovery: { candidates: [], diagnostics: [] },
      installRecords: {},
    });
    expect(catalog?.channel?.preferOver).toEqual(["env-primary"]);
    writeCatalog(catalogPath);

    for (let pass = 0; pass < 2; pass += 1) {
      const result = materializeEnvCatalogCandidates(stateDir);
      expect(result.config.plugins?.entries?.["env-secondary"]?.enabled).toBe(true);
      expect(result.config.plugins?.entries?.["env-primary"]).toBeUndefined();
    }
    clearPluginMetadataLifecycleCaches();
    expect(
      materializeEnvCatalogCandidates(stateDir).config.plugins?.entries?.["env-primary"]?.enabled,
    ).toBe(true);
  });

  it("warns when an oversized catalog is skipped and continues selection", () => {
    const stateDir = makeTempDir();
    const catalogPath = catalogFile(stateDir);
    // Sparse file: exceed the read cap without allocating 17 MiB.
    fs.writeFileSync(catalogPath, "{}\n");
    fs.truncateSync(catalogPath, 17 * 1024 * 1024);

    const result = materializeEnvCatalogCandidates(stateDir);

    expect(result.config.plugins?.entries?.["env-secondary"]?.enabled).toBe(true);
    expect(logWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("skipping oversized external catalog file"),
    );
  });

  it("keeps an invalid catalog stable until a new metadata owner reads it", () => {
    const stateDir = makeTempDir();
    const catalogPath = catalogFile(stateDir);
    fs.writeFileSync(catalogPath, "{invalid JSON", "utf8");
    expect(
      materializeEnvCatalogCandidates(stateDir).config.plugins?.entries?.["env-primary"]?.enabled,
    ).toBe(true);

    fs.rmSync(catalogPath, { recursive: true });
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
        entries: [{ openclaw: { channel: { id: "env-secondary", preferOver: ["env-primary"] } } }],
      }),
      "utf8",
    );
    expect(
      materializeEnvCatalogCandidates(stateDir).config.plugins?.entries?.["env-primary"]?.enabled,
    ).toBe(true);
    expect(logWarnSpy).not.toHaveBeenCalled();

    clearPluginMetadataLifecycleCaches();
    expect(
      materializeEnvCatalogCandidates(stateDir).config.plugins?.entries?.["env-primary"],
    ).toBeUndefined();
  });

  it("ignores workspace channel claims and keeps bundled channel auto-enable", () => {
    const result = autoEnable(
      channelConfig("telegram", { botToken: "token" }),
      preferredChannel("workspace-telegram", "telegram", ["telegram"], {
        origin: "workspace",
        label: "Workspace Telegram",
      }),
    );

    expect(result.config.channels?.telegram?.enabled).toBe(true);
    expect(result.config.plugins?.entries?.["workspace-telegram"]).toBeUndefined();
    expect(result.config.plugins?.entries?.telegram).toBeUndefined();
    expect(result.changes).toContain("Telegram configured, enabled automatically.");
  });

  it("does not materialize or allowlist workspace auto-enable candidates", () => {
    const result = materializePluginAutoEnableCandidates({
      config: { plugins: { allow: ["mattermost"] } },
      candidates: [
        {
          pluginId: "workspace-telegram",
          kind: "channel-configured",
          channelId: "telegram",
        },
      ],
      env: makeIsolatedEnv(),
      manifestRegistry: makeRegistry([
        {
          id: "workspace-telegram",
          channels: ["telegram"],
          origin: "workspace",
        },
      ]),
    });

    expect(result.config.plugins?.entries?.["workspace-telegram"]).toBeUndefined();
    expect(result.config.plugins?.allow).toEqual(["mattermost"]);
    expect(result.changes).toStrictEqual([]);
    expect(Object.keys(result.autoEnabledReasons)).toStrictEqual([]);
  });

  it.each([
    {
      label: "enabled entry",
      plugins: { entries: { "workspace-telegram": { enabled: true } } },
    },
    {
      label: "allowlist",
      plugins: { allow: ["workspace-telegram"] },
    },
  ])("preserves a workspace channel replacement trusted by $label", ({ plugins }) => {
    const result = autoEnable(
      channelConfig("telegram", { botToken: "token" }, plugins),
      { id: "telegram", channels: ["telegram"], origin: "bundled" },
      preferredChannel("workspace-telegram", "telegram", ["telegram"], { origin: "workspace" }),
    );

    expect(result.config.channels?.telegram?.enabled).toBeUndefined();
    expect(result.config.plugins?.entries?.telegram?.enabled).toBe(false);
    expect(result.config.plugins?.entries?.["workspace-telegram"]?.enabled).toBe(
      plugins.entries?.["workspace-telegram"]?.enabled,
    );
    expect(result.config.plugins?.allow).toEqual(plugins.allow);
  });

  it("allowlists repaired external channel plugins under restrictive plugin policy", () => {
    const result = materializePluginAutoEnableCandidates({
      config: channelConfig(
        "mattermost",
        { baseUrl: "http://mattermost:8065" },
        { allow: ["telegram"] },
      ),
      candidates: [
        {
          pluginId: "mattermost",
          kind: "configured-plugin-repaired",
        },
      ],
      env: makeIsolatedEnv(),
      manifestRegistry: makeRegistry([
        {
          id: "mattermost",
          channels: ["mattermost"],
          origin: "global",
        },
      ]),
    });

    expect(result.config.plugins?.entries?.mattermost?.enabled).toBe(true);
    expect(result.config.plugins?.allow).toEqual(["telegram", "mattermost"]);
    expect(result.config.channels?.mattermost?.enabled).toBeUndefined();
    expect(result.changes).toContain(
      "mattermost installed for existing configuration, enabled automatically.",
    );
  });

  it("uses the plugin manifest id, not the channel id, for plugins.entries", () => {
    const result = autoEnable(makeApnChannelConfig(), { id: "apn-channel", channels: ["apn"] });

    expect(result.config.plugins?.entries?.["apn-channel"]?.enabled).toBe(true);
    expect(result.config.plugins?.entries?.apn).toBeUndefined();
    expect(result.changes.join("\n")).toContain("apn configured, enabled automatically.");
  });

  it("falls back to the bundled channel when the preferred external plugin is disabled", () => {
    const result = autoEnable(
      channelConfig(
        "legacy-bundled-chat",
        { token: "legacy" },
        {
          entries: { "openclaw-modern-chat": { enabled: false } },
        },
      ),
      preferredChannel("legacy-bundled-chat", "legacy-bundled-chat", [], {
        origin: "bundled",
        label: "Legacy Bundled Chat",
      }),
      preferredChannel("openclaw-modern-chat", "legacy-bundled-chat", ["legacy-bundled-chat"], {
        label: "Modern Chat",
      }),
    );

    expect(result.config.plugins?.entries?.["openclaw-modern-chat"]?.enabled).toBe(false);
    expect(result.config.plugins?.entries?.["legacy-bundled-chat"]).toBeUndefined();
    expect(result.config.channels?.["legacy-bundled-chat"]?.enabled).toBe(true);
    expect(result.changes.join("\n")).toContain(
      "Legacy Bundled Chat configured, enabled automatically.",
    );
  });

  it.each(["openclaw-qqbot", "qqbot"])(
    "preserves the explicitly selected channel owner %s",
    (selected) => {
      const result = autoEnable(
        channelConfig(
          "qqbot",
          { appId: "app", clientSecret: "secret" },
          { entries: { [selected]: { enabled: true } } },
        ),
        ...(selected === "qqbot" ? [{ id: "qqbot", channels: ["qqbot"] }] : []),
        preferredChannel("openclaw-qqbot", "qqbot", ["qqbot"]),
      );
      expect(result.config.plugins?.entries?.["openclaw-qqbot"]?.enabled).toBe(true);
      if (selected === "qqbot") {
        expect(result.config.plugins?.entries?.qqbot?.enabled).toBe(true);
      } else {
        expect(result.config.plugins?.entries?.qqbot).toBeUndefined();
      }
    },
  );

  it("does not synthesize plugin entries when no installed manifest declares the channel", () => {
    const result = autoEnable(channelConfig("unknown-chan", { someKey: "value" }));

    expect(result.config.plugins?.entries?.["unknown-chan"]).toBeUndefined();
    expect(result.config.plugins?.allow).toBeUndefined();
    expect(result.changes).toStrictEqual([]);
  });
});
