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

  it("warns instead of expanding a restrictive allowlist for OpenAI companion enablement", () => {
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

    expect(repaired.config).toBe(cfg);
    expect(repaired.changes).toEqual([]);
    expect(repaired.warnings).toEqual([
      '- plugins.allow: plugin "codex" is not allowlisted, but OpenAI plugin enabled. Add "codex" to plugins.allow before relying on that configuration.',
    ]);
  });

  it("keeps restrictive allowlist blocking OpenAI companion repair even when Codex is disabled", () => {
    const cfg: OpenClawConfig = {
      plugins: {
        allow: ["openai"],
        entries: {
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
      '- plugins.allow: plugin "codex" is not allowlisted, but OpenAI plugin enabled. Add "codex" to plugins.allow before relying on that configuration. Also enable plugins.entries.codex.enabled before relying on that configuration.',
    ]);
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

  it("enables a disabled plugin when configured model refs require it", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: "codex/gpt-5.5",
        },
      },
      plugins: {
        allow: ["telegram"],
        entries: {
          codex: {
            enabled: false,
            config: {
              discovery: {
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
        discovery: {
          enabled: true,
        },
      },
    });
    expect(repaired.config.plugins?.allow).toEqual(["telegram", "codex"]);
    expect(repaired.changes).toEqual([
      "plugins.entries.codex.enabled: enabled plugin because codex/gpt-5.5 model configured.",
      'plugins.allow: added "codex" because codex/gpt-5.5 model configured.',
    ]);
    expect(repaired.warnings).toEqual([]);
  });

  it("detects disabled plugins required by embedded harness runtime", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          embeddedHarness: {
            runtime: "codex",
            fallback: "none",
          },
        },
      },
      plugins: {
        entries: {
          codex: {
            enabled: false,
          },
        },
      },
    } as OpenClawConfig;

    const hits = scanConfiguredPluginAutoEnableBlockers({ cfg, env, manifestRegistry: registry });

    expect(hits).toEqual([
      {
        pluginId: "codex",
        blocker: "disabled-in-config",
        reasons: ["codex agent harness runtime configured"],
      },
    ]);
    expect(
      collectConfiguredPluginAutoEnableBlockerWarnings({
        hits,
        doctorFixCommand: "openclaw doctor --fix",
      }),
    ).toEqual([
      '- plugins.entries.codex.enabled: plugin is disabled, but codex agent harness runtime configured. Run "openclaw doctor --fix" to enable it.',
    ]);
  });

  it("sanitizes config-derived reasons in warnings and changes", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: "codex/gpt-5.5\u001B[31m\r\nforged",
        },
      },
      plugins: {
        entries: {
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

    expect(repaired.changes.join("\n")).toContain(
      "plugins.entries.codex.enabled: enabled plugin because codex/gpt-5.5forged model configured.",
    );
    expect(repaired.changes.join("\n")).not.toContain("\u001B");
    expect(repaired.changes.join("\n")).not.toContain("\r");
    expect(repaired.changes.join("\n")).not.toContain("\nforged");
  });

  it("warns instead of repairing reserved plugin ids", () => {
    const reservedPluginId = ["__", "proto__"].join("");
    const entries = Object.create(null) as Record<string, { enabled: false }>;
    entries[reservedPluginId] = { enabled: false };
    const cfg: OpenClawConfig = {
      auth: {
        profiles: {
          dangerous: {
            provider: "danger",
            mode: "api_key",
          },
        },
      },
      plugins: {
        entries,
      },
    } as OpenClawConfig;

    const repaired = maybeRepairConfiguredPluginAutoEnableBlockers({
      cfg,
      env,
      manifestRegistry: makeRegistry([
        {
          id: reservedPluginId,
          channels: [],
          providers: ["danger"],
          autoEnableWhenConfiguredProviders: ["danger"],
        },
      ]),
    });

    expect(repaired.config).toBe(cfg);
    expect(repaired.changes).toEqual([]);
    expect(repaired.warnings).toEqual([
      `- plugins.entries.${reservedPluginId}.enabled: plugin id is reserved and cannot be auto-repaired, but danger auth configured. Use a non-reserved plugin id before relying on that configuration.`,
    ]);
    expect(Object.prototype).not.toHaveProperty("enabled");
  });

  it("warns instead of removing denylist blockers", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: "codex/gpt-5.5",
        },
      },
      plugins: {
        deny: ["codex"],
        entries: {
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
      '- plugins.deny: plugin "codex" is denied, but codex/gpt-5.5 model configured. Remove it from plugins.deny before relying on that configuration.',
    ]);
  });
});
