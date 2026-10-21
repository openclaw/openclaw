import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import {
  normalizePluginsConfig,
  resolveEffectivePluginActivationState,
} from "../../../plugins/config-state.js";
import type { PluginManifestRecord } from "../../../plugins/manifest-registry.js";
import * as manifestRegistry from "../../../plugins/manifest-registry.js";
import {
  collectStalePluginConfigWarnings,
  maybeRepairStalePluginConfig,
  scanStalePluginConfig,
} from "./stale-plugin-config.js";

const installedPluginIndexMocks = vi.hoisted(() => ({
  loadInstalledPluginIndexInstallRecordsSync: vi.fn<() => Record<string, PluginInstallRecord>>(
    () => ({}),
  ),
}));

vi.mock("../../../plugins/installed-plugin-index-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/installed-plugin-index-records.js")>()),
  loadInstalledPluginIndexInstallRecordsSync:
    installedPluginIndexMocks.loadInstalledPluginIndexInstallRecordsSync,
}));

function manifest(id: string): PluginManifestRecord {
  return {
    id,
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: "bundled",
    rootDir: `/plugins/${id}`,
    source: `/plugins/${id}`,
    manifestPath: `/plugins/${id}/openclaw.plugin.json`,
  };
}

function enabledEntries(...ids: string[]) {
  return Object.fromEntries(ids.map((id) => [id, { enabled: true }] as const));
}

function hit(
  pluginId: string,
  surface: "allow" | "deny" | "entries" | "slot",
  slotKey?: "memory" | "contextEngine",
) {
  return {
    pluginId,
    pathLabel: `plugins.${surface === "slot" ? `slots.${slotKey}` : surface === "entries" ? `entries.${pluginId}` : surface}`,
    surface,
    ...(slotKey ? { slotKey } : {}),
  };
}

function heartbeat(target: string, every?: string) {
  return { heartbeat: { target, ...(every ? { every } : {}) } };
}

describe("doctor stale plugin config helpers", () => {
  beforeEach(() => {
    installedPluginIndexMocks.loadInstalledPluginIndexInstallRecordsSync.mockReset();
    installedPluginIndexMocks.loadInstalledPluginIndexInstallRecordsSync.mockReturnValue({});
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistryCore").mockReturnValue({
      plugins: [
        manifest("discord"),
        manifest("voice-call"),
        manifest("openai"),
        { ...manifest("unrelated-installed"), origin: "global" },
        { ...manifest("surviving-installed"), origin: "global" },
      ],
      diagnostics: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["normalized sole retired allowlist", { allow: [" WebHooks ", " "] }, false, false],
    ["mixed surviving allowlist", { allow: ["webhooks", "surviving-installed"] }, true, true],
    ["surviving deny entry", { deny: ["webhooks", "unrelated-installed"] }, true, true],
  ] as const)("preserves activation after repairing %s", (_name, policy, enabled, surviving) => {
    const unrelated = false;
    const cfg: OpenClawConfig = {
      hooks: { enabled: true, token: "synthetic-gateway-hook-token" },
      plugins: {
        ...("allow" in policy ? { allow: [...policy.allow] } : { deny: [...policy.deny] }),
        entries: enabledEntries("webhooks", "unrelated-installed", "surviving-installed"),
      },
    };
    const before = structuredClone(cfg);
    const activation = (config: OpenClawConfig, id: string) =>
      resolveEffectivePluginActivationState({
        id,
        origin: "global",
        config: normalizePluginsConfig(config.plugins),
        rootConfig: config,
      });
    expect(activation(cfg, "unrelated-installed").enabled).toBe(unrelated);
    expect(activation(cfg, "surviving-installed").enabled).toBe(surviving);

    const result = maybeRepairStalePluginConfig(cfg);
    expect(activation(result.config, "unrelated-installed").enabled).toBe(unrelated);
    expect(activation(result.config, "surviving-installed").enabled).toBe(surviving);
    expect(normalizePluginsConfig(result.config.plugins).enabled).toBe(enabled);
    expect(result.config.plugins?.entries?.webhooks).toBeUndefined();
    expect(result.config.hooks).toEqual(cfg.hooks);
    expect(cfg).toEqual(before);
    expect(maybeRepairStalePluginConfig(result.config).changes).toEqual([]);
    if (!enabled) {
      expect(result.changes).toContain(
        "- plugins.enabled: disabled plugins because no allowed plugins remain; review plugins.allow before enabling plugins",
      );
    }
  });

  it.each<
    [
      string,
      OpenClawConfig & { plugins: NonNullable<OpenClawConfig["plugins"]> },
      string[],
      boolean?,
    ]
  >([
    [
      "manifest-owned bundled channel",
      { channels: { telegram: { enabled: true } }, plugins: { slots: { memory: "none" } } },
      ["channel-owner"],
    ],
    [
      "default memory and selected context engine",
      { plugins: { slots: { contextEngine: "selected-context" } } },
      ["memory-core", "selected-context"],
    ],
    [
      "denied channel and disabled selected memory",
      {
        channels: { telegram: { enabled: true } },
        plugins: {
          deny: ["channel-owner"],
          slots: { memory: "selected-memory", contextEngine: "selected-context" },
          entries: { "selected-memory": { enabled: false } },
        },
      },
      ["selected-context"],
    ],
    [
      "slot owner with a legacy alias and a blocked canonical plugin",
      { plugins: { slots: { memory: "google-gemini-cli" } } },
      ["google-gemini-cli"],
      true,
    ],
  ])(
    "retains %s when the last allowlisted plugin is retired",
    (_name, config, enabledIds, preserveAuthoredPolicy) => {
      const plugins: PluginManifestRecord[] = [
        { ...manifest("channel-owner"), channels: ["telegram"] },
        manifest("memory-core"),
        { ...manifest("selected-memory"), origin: "global" },
        { ...manifest("selected-context"), origin: "workspace" },
        { ...manifest("unrelated-installed"), origin: "global" },
        { ...manifest("google-gemini-cli"), origin: "global" },
        { ...manifest("google"), origin: "global" },
      ];
      vi.mocked(manifestRegistry.loadPluginManifestRegistryCore).mockReturnValue({
        plugins,
        diagnostics: [],
      });
      const cfg: OpenClawConfig = {
        ...config,
        plugins: {
          ...config.plugins,
          allow: [" WebHooks ", " "],
          entries: {
            ...config.plugins.entries,
            ...enabledEntries("webhooks", "unrelated-installed"),
          },
        },
      };
      const expectActivation = (candidate: OpenClawConfig) => {
        for (const plugin of plugins) {
          expect(
            resolveEffectivePluginActivationState({
              ...plugin,
              channelIds: plugin.channels,
              config: normalizePluginsConfig(candidate.plugins),
              rootConfig: candidate,
            }).enabled,
            plugin.id,
          ).toBe(enabledIds.includes(plugin.id));
        }
      };
      expectActivation(cfg);

      const result = maybeRepairStalePluginConfig(cfg);
      expectActivation(result.config);
      if (preserveAuthoredPolicy) {
        expect(result.config).toEqual(cfg);
        expect(result.changes).toEqual([]);
        expect(result.warnings).toEqual([
          "- Stale plugin cleanup paused: preserving the restrictive plugins.allow policy because active plugin ids alias to other owners (google-gemini-cli -> google). Choose noncolliding allowed plugin ids, then rerun openclaw doctor --fix.",
        ]);
        return;
      }
      expect(result.config.plugins?.allow).toEqual(enabledIds);
      if (enabledIds.length > 0) {
        expect(result.changes).toContain(
          `- plugins.allow: retained already enabled plugins as explicit allowlist entries (${enabledIds.join(", ")}); review this list when changing channels or plugin slots`,
        );
      }
      expect(result.config.plugins?.entries?.webhooks).toBeUndefined();
      expect(maybeRepairStalePluginConfig(result.config).changes).toEqual([]);
    },
  );

  it("preserves an explicit disable marker while removing stale disabled settings", () => {
    const result = maybeRepairStalePluginConfig({
      plugins: {
        entries: {
          "explicitly-disabled": { enabled: false },
          "disabled-with-settings": { enabled: false, config: { stale: true } },
          "google-antigravity-auth": { enabled: false },
          webhooks: { enabled: false },
        },
      },
    } as OpenClawConfig);

    expect(result.changes).toEqual([
      "- plugins.entries: removed 3 stale plugin entries (disabled-with-settings, google-antigravity-auth, webhooks)",
    ]);
    expect(result.config.plugins?.entries).toEqual({
      "explicitly-disabled": { enabled: false },
    });
  });

  it("resets stale plugin slots without changing valid slot sentinels", () => {
    const cfg: OpenClawConfig = {
      plugins: { slots: { memory: "acpx", contextEngine: "missing-engine" } },
    };

    const hits = scanStalePluginConfig(cfg);
    expect(hits).toEqual([
      hit("acpx", "slot", "memory"),
      hit("missing-engine", "slot", "contextEngine"),
    ]);

    const result = maybeRepairStalePluginConfig(cfg);
    expect(result.changes).toEqual([
      "- plugins.slots: reset 2 stale plugin slots (memory: acpx -> memory-core, contextEngine: missing-engine -> legacy)",
    ]);
    expect(result.config.plugins?.slots).toBeUndefined();
  });

  it("does not preserve codex outside policy surfaces", () => {
    const result = maybeRepairStalePluginConfig(
      {
        plugins: {
          allow: ["codex"],
          entries: { codex: { enabled: false } },
          slots: { memory: "codex" },
        },
      } as OpenClawConfig,
      undefined,
      {
        surfacePreservePluginIds: {
          allow: ["codex"],
          deny: ["codex"],
          entries: ["codex"],
        },
      },
    );

    expect(result.config.plugins?.allow).toEqual(["codex"]);
    expect(result.config.plugins?.entries?.codex?.enabled).toBe(false);
    expect(result.config.plugins?.slots).toBeUndefined();
    expect(result.changes).toEqual([
      "- plugins.slots: reset 1 stale plugin slot (memory: codex -> memory-core)",
    ]);
  });

  it("formats stale plugin warnings with a doctor hint", () => {
    const warnings = collectStalePluginConfigWarnings({
      hits: [
        hit("zeta", "deny"),
        hit("acpx", "allow"),
        hit("acpx", "entries"),
        { pluginId: "missing-memory", surface: "slot", pathLabel: "plugins.slots.memory" },
      ],
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toEqual([
      "- Stale plugin references (plugins.allow/deny/entries): acpx, zeta.",
      '- plugins.slots.memory: slot references missing plugin "missing-memory".',
      '- Run "openclaw doctor --fix" to remove stale plugin ids and dangling channel references.',
    ]);
  });

  it("removes stale third-party channel config and dependent channel refs", () => {
    const result = maybeRepairStalePluginConfig({
      plugins: {
        allow: ["discord", "missing-chat-plugin"],
        entries: enabledEntries("discord", "missing-chat-plugin"),
      },
      channels: {
        "missing-chat-plugin": { enabled: true, token: "stale" },
        telegram: { botToken: "keep" },
        modelByChannel: {
          openai: {
            "missing-chat-plugin": "openai/gpt-5.4",
            telegram: "openai/gpt-5.4",
          },
        },
      },
      agents: {
        defaults: heartbeat("missing-chat-plugin", "30m"),
        entries: {
          openclaw: heartbeat("missing-chat-plugin"),
          ops: heartbeat("telegram"),
        },
      },
    } as OpenClawConfig);

    expect(result.changes).toEqual([
      "- plugins.allow: removed 1 stale plugin id (missing-chat-plugin)",
      "- plugins.entries: removed 1 stale plugin entry (missing-chat-plugin)",
      "- channels: removed 1 stale channel config (missing-chat-plugin)",
      "- agents heartbeat: removed 2 stale heartbeat targets (missing-chat-plugin)",
      "- channels.modelByChannel: removed 1 stale channel model override (missing-chat-plugin)",
    ]);
    expect(result.config.plugins?.allow).toEqual(["discord"]);
    expect(result.config.plugins?.entries).toEqual({ discord: { enabled: true } });
    expect(result.config.channels?.["missing-chat-plugin"]).toBeUndefined();
    expect(result.config.channels?.telegram).toEqual({ botToken: "keep" });
    expect(result.config.channels?.modelByChannel).toEqual({
      openai: { telegram: "openai/gpt-5.4" },
    });
    expect(result.config.agents?.defaults?.heartbeat).toEqual({ every: "30m" });
    expect(result.config.agents?.entries?.openclaw?.heartbeat).toStrictEqual({});
    expect(result.config.agents?.entries?.ops?.heartbeat).toEqual({ target: "telegram" });
  });

  it("lists only the actually removed ids in heartbeat and modelByChannel change entries", () => {
    const result = maybeRepairStalePluginConfig({
      plugins: { allow: ["missing-a", "missing-b"] },
      channels: {
        "missing-a": { enabled: true, token: "stale-a" },
        "missing-b": { enabled: true, token: "stale-b" },
        modelByChannel: { openai: { "missing-a": "openai/gpt-5.4" } },
      },
      agents: { defaults: heartbeat("missing-a", "30m") },
    } as OpenClawConfig);

    expect(result.changes).toEqual([
      "- plugins.allow: removed 2 stale plugin ids (missing-a, missing-b)",
      "- plugins.enabled: disabled plugins because no allowed plugins remain; review plugins.allow before enabling plugins",
      "- channels: removed 2 stale channel configs (missing-a, missing-b)",
      "- agents heartbeat: removed 1 stale heartbeat target (missing-a)",
      "- channels.modelByChannel: removed 1 stale channel model override (missing-a)",
    ]);
    expect(result.config.channels?.["missing-a"]).toBeUndefined();
    expect(result.config.channels?.["missing-b"]).toBeUndefined();
    expect(result.config.agents?.defaults?.heartbeat).toEqual({ every: "30m" });
  });

  it("treats stale plugin refs as inert while plugins are globally disabled", () => {
    const cfg = {
      plugins: {
        enabled: false,
        allow: ["stale-plugin"],
        entries: enabledEntries("stale-plugin"),
      },
      channels: { "openclaw-weixin": { enabled: true } },
    } as OpenClawConfig;

    expect(scanStalePluginConfig(cfg)).toStrictEqual([]);
    expect(maybeRepairStalePluginConfig(cfg)).toEqual({ config: cfg, changes: [] });
    expect(manifestRegistry.loadPluginManifestRegistryCore).not.toHaveBeenCalled();
  });

  it("uses missing persisted install records as stale channel evidence", () => {
    installedPluginIndexMocks.loadInstalledPluginIndexInstallRecordsSync.mockReturnValue({
      "missing-chat-plugin": {
        source: "npm",
        resolvedName: "@example/missing-chat-plugin",
        installedAt: "2026-04-12T00:00:00.000Z",
      },
    });

    const result = maybeRepairStalePluginConfig({
      channels: { "missing-chat-plugin": { enabled: true } },
    } as OpenClawConfig);

    expect(result.changes).toEqual([
      "- channels: removed 1 stale channel config (missing-chat-plugin)",
    ]);
    expect(result.config.channels?.["missing-chat-plugin"]).toBeUndefined();
  });

  it("does not auto-repair stale refs while plugin discovery has errors", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistryCore").mockReturnValue({
      plugins: [],
      diagnostics: [
        { level: "error", message: "plugin path not found: /missing", source: "/missing" },
      ],
    });

    const cfg = {
      plugins: {
        allow: ["stale-plugin"],
        entries: enabledEntries("stale-plugin"),
      },
    } as OpenClawConfig;

    const hits = scanStalePluginConfig(cfg);
    expect(hits).toEqual([hit("stale-plugin", "allow"), hit("stale-plugin", "entries")]);

    const result = maybeRepairStalePluginConfig(cfg);
    expect(result.changes).toStrictEqual([]);
    expect(result.config).toEqual(cfg);

    const warnings = collectStalePluginConfigWarnings({
      hits,
      doctorFixCommand: "openclaw doctor --fix",
      autoRepairBlocked: true,
    });
    expect(warnings.at(-1)).toContain("Auto-removal is paused");
  });
});
