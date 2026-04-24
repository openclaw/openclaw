import { afterAll, describe, expect, it } from "vitest";
import {
  makeIsolatedEnv,
  makeRegistry,
  resetPluginAutoEnableTestState,
} from "../../../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  collectConfiguredPluginAutoEnableBlockerWarnings,
  maybeRepairConfiguredPluginAutoEnableBlockers,
  scanConfiguredPluginAutoEnableBlockers,
} from "./configured-plugin-auto-enable-blockers.js";

const env = makeIsolatedEnv();
function makeCodexRegistry(origin: "bundled" | "config" | "workspace" = "bundled") {
  const registry = makeRegistry([
    {
      id: "codex",
      channels: [],
      providers: ["codex"],
      activation: {
        onAgentHarnesses: ["codex"],
      },
    },
  ]);
  registry.plugins[0].origin = origin;
  return registry;
}

const registry = makeCodexRegistry();

afterAll(() => {
  resetPluginAutoEnableTestState();
});

describe("configured plugin auto-enable blockers", () => {
  it("enables Codex when OpenAI is explicitly enabled and Codex is off", () => {
    const cfg: OpenClawConfig = {
      plugins: {
        entries: {
          openai: {
            enabled: true,
          },
        },
      },
    } as OpenClawConfig;

    const repaired = maybeRepairConfiguredPluginAutoEnableBlockers({
      cfg,
      env,
      manifestRegistry: registry,
    });

    expect(repaired.config.plugins?.entries?.codex).toEqual({ enabled: true });
    expect(repaired.changes).toEqual([
      "plugins.entries.codex.enabled: enabled plugin because OpenAI plugin enabled.",
    ]);
    expect(repaired.warnings).toEqual([]);
  });

  it("adds Codex to a restrictive allowlist when OpenAI is explicitly allowlisted", () => {
    const cfg: OpenClawConfig = {
      plugins: {
        allow: ["openai"],
      },
    } as OpenClawConfig;

    const repaired = maybeRepairConfiguredPluginAutoEnableBlockers({
      cfg,
      env,
      manifestRegistry: registry,
    });

    expect(repaired.config.plugins?.entries?.codex).toEqual({ enabled: true });
    expect(repaired.config.plugins?.allow).toEqual(["openai", "codex"]);
    expect(repaired.changes).toEqual([
      "plugins.entries.codex.enabled: enabled plugin because OpenAI plugin enabled.",
      'plugins.allow: added "codex" because OpenAI plugin enabled.',
    ]);
    expect(repaired.warnings).toEqual([]);
  });

  it("preserves existing Codex plugin config while enabling it", () => {
    const cfg: OpenClawConfig = {
      plugins: {
        entries: {
          openai: {
            enabled: true,
          },
          codex: {
            enabled: false,
            config: {
              appServer: {
                enabled: true,
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const repaired = maybeRepairConfiguredPluginAutoEnableBlockers({
      cfg,
      env,
      manifestRegistry: registry,
    });

    expect(repaired.config.plugins?.entries?.codex).toEqual({
      enabled: true,
      config: {
        appServer: {
          enabled: true,
        },
      },
    });
  });

  it("does not carry blocked keys while preserving existing Codex plugin config", () => {
    const blockedKey = ["__", "proto__"].join("");
    const codexEntry = Object.create(null) as Record<string, unknown>;
    codexEntry.enabled = false;
    codexEntry.config = {
      appServer: {
        enabled: true,
      },
    };
    codexEntry[blockedKey] = { polluted: true };
    const entries = Object.create(null) as Record<string, unknown>;
    entries.openai = { enabled: true };
    entries.codex = codexEntry;
    entries[blockedKey] = { enabled: true };
    const cfg: OpenClawConfig = {
      plugins: {
        entries,
      },
    } as OpenClawConfig;

    const repaired = maybeRepairConfiguredPluginAutoEnableBlockers({
      cfg,
      env,
      manifestRegistry: registry,
    });

    expect(Object.prototype.hasOwnProperty.call(repaired.config.plugins?.entries, blockedKey)).toBe(
      false,
    );
    expect(
      Object.prototype.hasOwnProperty.call(repaired.config.plugins?.entries?.codex, blockedKey),
    ).toBe(false);
    expect(repaired.config.plugins?.entries?.codex).toEqual({
      enabled: true,
      config: {
        appServer: {
          enabled: true,
        },
      },
    });
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("does not enable Codex when the plugin is unavailable", () => {
    const cfg: OpenClawConfig = {
      plugins: {
        entries: {
          openai: {
            enabled: true,
          },
        },
      },
    } as OpenClawConfig;

    const repaired = maybeRepairConfiguredPluginAutoEnableBlockers({
      cfg,
      env,
      manifestRegistry: makeRegistry([]),
    });

    expect(repaired.config).toBe(cfg);
    expect(repaired.changes).toEqual([]);
    expect(repaired.warnings).toEqual([]);
  });

  it("does not enable Codex just because OpenAI is enabled by default", () => {
    const repaired = maybeRepairConfiguredPluginAutoEnableBlockers({
      cfg: {},
      env,
      manifestRegistry: registry,
    });

    expect(repaired.config).toEqual({});
    expect(repaired.changes).toEqual([]);
    expect(repaired.warnings).toEqual([]);
  });

  it("does not inspect plugin manifests when OpenAI is not explicitly enabled", () => {
    const manifestRegistry = {
      get plugins(): never {
        throw new Error("manifest registry should not be inspected");
      },
      diagnostics: [],
    };

    expect(
      scanConfiguredPluginAutoEnableBlockers({
        cfg: {},
        env,
        manifestRegistry,
      }),
    ).toEqual([]);
  });

  it("does not auto-enable non-bundled Codex manifests", () => {
    for (const origin of ["config", "workspace"] as const) {
      const cfg: OpenClawConfig = {
        plugins: {
          entries: {
            openai: {
              enabled: true,
            },
          },
        },
      } as OpenClawConfig;

      const repaired = maybeRepairConfiguredPluginAutoEnableBlockers({
        cfg,
        env,
        manifestRegistry: makeCodexRegistry(origin),
      });

      expect(repaired.config).toBe(cfg);
      expect(repaired.changes).toEqual([]);
      expect(repaired.warnings).toEqual([]);
    }
  });

  it("warns instead of removing a Codex denylist blocker", () => {
    const cfg: OpenClawConfig = {
      plugins: {
        deny: ["codex"],
        entries: {
          openai: {
            enabled: true,
          },
          codex: {
            enabled: false,
          },
        },
      },
    } as OpenClawConfig;

    const repaired = maybeRepairConfiguredPluginAutoEnableBlockers({
      cfg,
      env,
      manifestRegistry: registry,
    });

    expect(repaired.config).toBe(cfg);
    expect(repaired.changes).toEqual([]);
    expect(repaired.warnings).toEqual([
      '- plugins.deny: plugin "codex" is denied, but OpenAI plugin enabled. Remove it from plugins.deny before relying on that configuration.',
    ]);
  });

  it("reports preview warnings for OpenAI-enabled configs before repair", () => {
    const hits = scanConfiguredPluginAutoEnableBlockers({
      cfg: {
        plugins: {
          entries: {
            openai: {
              enabled: true,
            },
          },
        },
      } as OpenClawConfig,
      env,
      manifestRegistry: registry,
    });

    expect(hits).toEqual([
      {
        pluginId: "codex",
        reasons: ["OpenAI plugin enabled"],
        blocker: "not-enabled",
      },
    ]);
    expect(
      collectConfiguredPluginAutoEnableBlockerWarnings({
        hits,
        doctorFixCommand: "openclaw doctor --fix",
      }),
    ).toEqual([
      '- plugins.entries.codex.enabled: plugin is not enabled, but OpenAI plugin enabled. Run "openclaw doctor --fix" to enable it.',
    ]);
  });
});
