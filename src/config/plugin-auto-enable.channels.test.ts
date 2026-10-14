// Covers channel-driven plugin auto-enable decisions.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";

const envSecondaryCatalogEntry = {
  name: "@openclaw/env-secondary",
  openclaw: {
    channel: {
      id: "env-secondary",
      label: "Env Secondary",
      selectionLabel: "Env Secondary",
      docsPath: "/channels/env-secondary",
      blurb: "Env secondary entry",
      preferOver: ["env-primary"],
    },
    install: { npmSpec: "@openclaw/env-secondary" },
  },
};

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

function materializeEnvCatalogCandidates(
  stateDir: string,
  candidates: Parameters<typeof materializePluginAutoEnableCandidates>[0]["candidates"] = [
    { pluginId: "env-primary", kind: "channel-configured", channelId: "env-primary" },
    { pluginId: "env-secondary", kind: "channel-configured", channelId: "env-secondary" },
  ],
) {
  return materializePluginAutoEnableCandidates({
    config: {
      channels: {
        "env-primary": { token: "primary" },
        "env-secondary": { token: "secondary" },
      },
    },
    candidates,
    env: {
      ...makeIsolatedEnv(),
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
    },
    manifestRegistry: makeRegistry([]),
  });
}

function makePreferredChannelRegistry() {
  return makeRegistry([
    {
      id: "legacy-bundled-chat",
      channels: ["legacy-bundled-chat"],
      origin: "bundled",
      channelConfigs: {
        "legacy-bundled-chat": {
          schema: { type: "object" },
          label: "Legacy Bundled Chat",
        },
      },
    },
    {
      id: "openclaw-modern-chat",
      channels: ["legacy-bundled-chat"],
      channelConfigs: {
        "legacy-bundled-chat": {
          schema: { type: "object" },
          label: "Modern Chat",
          preferOver: ["legacy-bundled-chat"],
        },
      },
    },
  ]);
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
    const catalogPath = path.join(stateDir, "plugins", "catalog.json");
    fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
        entries: [
          {
            name: "@openclaw/env-primary",
            openclaw: {
              channel: {
                id: "env-primary",
                label: "Env Primary",
                selectionLabel: "Env Primary",
                docsPath: "/channels/env-primary",
                blurb: "Env primary entry",
              },
              install: { npmSpec: "@openclaw/env-primary" },
            },
          },
          envSecondaryCatalogEntry,
        ],
      }),
      "utf-8",
    );

    const catalog = getChannelPluginCatalogEntry("env-secondary", {
      catalogPaths: [catalogPath],
      officialCatalogPaths: [path.join(stateDir, "missing-official.json")],
      env: makeIsolatedEnv(),
      discovery: { candidates: [], diagnostics: [] },
      installRecords: {},
    });
    expect(catalog?.channel?.preferOver).toEqual(["env-primary"]);
    fs.writeFileSync(catalogPath, JSON.stringify({ entries: [] }), "utf8");

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
    const catalogPath = path.join(stateDir, "plugins", "catalog.json");
    fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
    // Create a sparse file whose stat.size exceeds the 16 MiB cap without
    // allocating actual disk blocks — the bounded read rejects it by size
    // before loading content into memory.
    const fd = fs.openSync(catalogPath, "w");
    try {
      fs.writeSync(fd, "{}\n");
      fs.ftruncateSync(fd, 17 * 1024 * 1024);
    } finally {
      fs.closeSync(fd);
    }

    const result = materializeEnvCatalogCandidates(stateDir);

    expect(result.config.plugins?.entries?.["env-secondary"]?.enabled).toBe(true);
    expect(logWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("skipping oversized external catalog file"),
    );
  });

  it("keeps an invalid catalog stable until a new metadata owner reads it", () => {
    const stateDir = makeTempDir();
    const catalogPath = path.join(stateDir, "plugins", "catalog.json");
    fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
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

  describe("third-party channel plugins", () => {
    it("ignores workspace channel claims and keeps bundled channel auto-enable", () => {
      const result = applyPluginAutoEnable({
        config: { channels: { telegram: { botToken: "token" } } },
        env: makeIsolatedEnv(),
        manifestRegistry: makeRegistry([
          {
            id: "workspace-telegram",
            channels: ["telegram"],
            origin: "workspace",
            channelConfigs: {
              telegram: {
                schema: { type: "object" },
                label: "Workspace Telegram",
                preferOver: ["telegram"],
              },
            },
          },
        ]),
      });

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
      const result = applyPluginAutoEnable({
        config: {
          channels: { telegram: { botToken: "token" } },
          plugins,
        },
        env: makeIsolatedEnv(),
        manifestRegistry: makeRegistry([
          {
            id: "telegram",
            channels: ["telegram"],
            origin: "bundled",
          },
          {
            id: "workspace-telegram",
            channels: ["telegram"],
            origin: "workspace",
            channelConfigs: {
              telegram: {
                schema: { type: "object" },
                preferOver: ["telegram"],
              },
            },
          },
        ]),
      });

      expect(result.config.channels?.telegram?.enabled).toBeUndefined();
      expect(result.config.plugins?.entries?.telegram?.enabled).toBe(false);
      expect(result.config.plugins?.entries?.["workspace-telegram"]?.enabled).toBe(
        plugins.entries?.["workspace-telegram"]?.enabled,
      );
      expect(result.config.plugins?.allow).toEqual(plugins.allow);
    });

    it("allowlists repaired external channel plugins under restrictive plugin policy", () => {
      const result = materializePluginAutoEnableCandidates({
        config: {
          channels: { mattermost: { baseUrl: "http://mattermost:8065" } },
          plugins: { allow: ["telegram"] },
        },
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
      const result = applyPluginAutoEnable({
        config: makeApnChannelConfig(),
        env: makeIsolatedEnv(),
        manifestRegistry: makeRegistry([{ id: "apn-channel", channels: ["apn"] }]),
      });

      expect(result.config.plugins?.entries?.["apn-channel"]?.enabled).toBe(true);
      expect(result.config.plugins?.entries?.apn).toBeUndefined();
      expect(result.changes.join("\n")).toContain("apn configured, enabled automatically.");
    });

    it("does not disable a renamed external owner through its removed bundled channel id", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: { qqbot: { appId: "app", clientSecret: "secret" } },
          plugins: { entries: { "openclaw-qqbot": { enabled: true } } },
        },
        env: makeIsolatedEnv(),
        manifestRegistry: makeRegistry([
          {
            id: "openclaw-qqbot",
            channels: ["qqbot"],
            channelConfigs: {
              qqbot: {
                schema: { type: "object" },
                preferOver: ["qqbot"],
              },
            },
          },
        ]),
      });

      expect(result.config.plugins?.entries?.["openclaw-qqbot"]?.enabled).toBe(true);
      expect(result.config.plugins?.entries?.qqbot).toBeUndefined();
    });

    it("falls back to the bundled channel when the preferred external plugin is disabled", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: { "legacy-bundled-chat": { token: "legacy" } },
          plugins: { entries: { "openclaw-modern-chat": { enabled: false } } },
        },
        env: makeIsolatedEnv(),
        manifestRegistry: makePreferredChannelRegistry(),
      });

      expect(result.config.plugins?.entries?.["openclaw-modern-chat"]?.enabled).toBe(false);
      expect(result.config.plugins?.entries?.["legacy-bundled-chat"]).toBeUndefined();
      expect(result.config.channels?.["legacy-bundled-chat"]?.enabled).toBe(true);
      expect(result.changes.join("\n")).toContain(
        "Legacy Bundled Chat configured, enabled automatically.",
      );
    });

    it("does not auto-disable a lower-priority channel plugin that was explicitly selected", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: { qqbot: { appId: "app", clientSecret: "secret" } },
          plugins: { entries: { qqbot: { enabled: true } } },
        },
        env: makeIsolatedEnv(),
        manifestRegistry: makeRegistry([
          { id: "qqbot", channels: ["qqbot"] },
          {
            id: "openclaw-qqbot",
            channels: ["qqbot"],
            channelConfigs: {
              qqbot: {
                schema: { type: "object" },
                preferOver: ["qqbot"],
              },
            },
          },
        ]),
      });

      expect(result.config.plugins?.entries?.["openclaw-qqbot"]?.enabled).toBe(true);
      expect(result.config.plugins?.entries?.qqbot?.enabled).toBe(true);
    });

    it("does not synthesize plugin entries when no installed manifest declares the channel", () => {
      const result = applyPluginAutoEnable({
        config: { channels: { "unknown-chan": { someKey: "value" } } },
        env: makeIsolatedEnv(),
        manifestRegistry: makeRegistry([]),
      });

      expect(result.config.plugins?.entries?.["unknown-chan"]).toBeUndefined();
      expect(result.config.plugins?.allow).toBeUndefined();
      expect(result.changes).toStrictEqual([]);
    });
  });
});
