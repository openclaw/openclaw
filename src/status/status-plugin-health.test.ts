// Plugin health status tests cover compact and detailed chat formatting.
import { describe, expect, it } from "vitest";
import {
  formatCompactPluginHealthLine,
  formatDetailedPluginHealth,
  mergeStatusPluginHealthSnapshots,
  type StatusPluginHealthSnapshot,
} from "./status-plugin-health.js";

const emptySnapshot: StatusPluginHealthSnapshot = {
  plugins: [],
  diagnostics: [],
  contextEngineQuarantines: [],
};

describe("plugin health status formatting", () => {
  it("shows a tiny OK line when there are no plugin health problems", () => {
    expect(formatCompactPluginHealthLine(emptySnapshot)).toBe("🔌 Plugins: OK");
  });

  it("summarizes plugin errors and context engine quarantines in the compact line", () => {
    expect(
      formatCompactPluginHealthLine({
        plugins: [
          {
            id: "broken-plugin",
            status: "error",
            enabled: true,
            error: "boom",
          },
        ],
        diagnostics: [],
        contextEngineQuarantines: [
          {
            engineId: "lossless-claw",
            owner: "plugin:lossless-claw",
            operation: "bootstrap",
            reason: "replay guard tripped",
            failedAt: new Date(0),
          },
        ],
      }),
    ).toBe("⚠️ Plugins: 1 plugin error · 1 context engine quarantine");
  });

  it("counts runtime tool quarantines and channel plugin failures as compact problems", () => {
    expect(
      formatCompactPluginHealthLine({
        ...emptySnapshot,
        runtimeToolQuarantines: [
          {
            toolName: "bad_tool",
            owner: "plugin:bad-tools",
            reason: "unsupported anyOf",
            failedAt: new Date(0),
          },
        ],
        channelPluginFailures: [
          {
            channelId: "sms",
            pluginId: "sms-plugin",
            message: "setup failed",
          },
        ],
      }),
    ).toBe("⚠️ Plugins: 1 runtime tool quarantine · 1 channel plugin failure");
  });

  it("does not double-count diagnostics classified as channel plugin failures", () => {
    expect(
      formatCompactPluginHealthLine({
        ...emptySnapshot,
        diagnostics: [
          {
            level: "error",
            pluginId: "broken-channel",
            message: "failed to load setup entry: boom",
          },
        ],
        channelPluginFailures: [
          {
            channelId: "broken-channel",
            pluginId: "broken-channel",
            message: "failed to load setup entry: boom",
            source: "diagnostic",
          },
        ],
      }),
    ).toBe("⚠️ Plugins: 1 channel plugin failure");
  });

  it("counts channel setup diagnostics when no channel failure record is present", () => {
    expect(
      formatCompactPluginHealthLine({
        ...emptySnapshot,
        diagnostics: [
          {
            level: "error",
            pluginId: "broken-channel",
            message: "failed to load setup entry: boom",
          },
        ],
      }),
    ).toBe("⚠️ Plugins: 1 diagnostic error");
  });

  it("keeps compatibility notices out of the compact problem line", () => {
    expect(
      formatCompactPluginHealthLine({
        ...emptySnapshot,
        compatibilityNotices: [
          {
            pluginId: "legacy-plugin",
            severity: "warn",
            code: "hook-only",
            message: "uses a compatibility shim",
          },
        ],
      }),
    ).toBe("🔌 Plugins: OK");
  });

  it("merges runtime health into installed plugin snapshots for detailed status", () => {
    const snapshot = mergeStatusPluginHealthSnapshots(
      {
        plugins: [{ id: "installed-ok", status: "loaded", enabled: true }],
        diagnostics: [],
        contextEngineQuarantines: [],
        compatibilityNotices: [
          {
            pluginId: "compat-only",
            severity: "warn",
            code: "legacy-before-agent-start",
            message: "still uses legacy before_agent_start",
          },
        ],
      },
      {
        plugins: [
          {
            id: "runtime-broken",
            status: "error",
            enabled: true,
            failurePhase: "load",
            error: "runtime load failed",
          },
        ],
        diagnostics: [
          {
            level: "error",
            pluginId: "runtime-broken",
            message: "failed to load setup entry: runtime load failed",
          },
        ],
        contextEngineQuarantines: [],
        runtimeToolQuarantines: [
          {
            toolName: "bad_tool",
            owner: "plugin:bad-tools",
            reason: "unsupported schema",
            failedAt: new Date(789),
          },
        ],
        channelPluginFailures: [
          {
            channelId: "runtime-broken",
            pluginId: "runtime-broken",
            message: "failed to load setup entry: runtime load failed",
            source: "diagnostic",
          },
        ],
      },
    );

    expect(snapshot.plugins).toContainEqual({
      id: "runtime-broken",
      status: "error",
      enabled: true,
      failurePhase: "load",
      error: "runtime load failed",
    });
    expect(snapshot.runtimeToolQuarantines).toHaveLength(1);
    expect(snapshot.channelPluginFailures).toContainEqual({
      channelId: "runtime-broken",
      pluginId: "runtime-broken",
      message: "failed to load setup entry: runtime load failed",
      source: "diagnostic",
    });
    expect(snapshot.compatibilityNotices).toContainEqual({
      pluginId: "compat-only",
      severity: "warn",
      code: "legacy-before-agent-start",
      message: "still uses legacy before_agent_start",
    });
  });

  it("includes detailed plugin state without dumping the full plugin registry", () => {
    const text = formatDetailedPluginHealth({
      plugins: [
        { id: "ok-plugin", status: "loaded", enabled: true },
        { id: "disabled-plugin", status: "disabled", enabled: false },
        {
          id: "bad-plugin",
          status: "error",
          enabled: true,
          failurePhase: "load",
          error: "module failed",
        },
      ],
      diagnostics: [{ level: "warn", pluginId: "bad-plugin", message: "deprecated hook" }],
      contextEngineQuarantines: [],
      runtimeToolQuarantines: [
        {
          toolName: "bad_tool",
          owner: "plugin:bad-tools",
          reason: "unsupported anyOf",
          failedAt: new Date(0),
        },
      ],
      channelPluginFailures: [
        {
          channelId: "sms",
          pluginId: "sms-plugin",
          message: "setup failed",
          source: "setup",
        },
      ],
      compatibilityNotices: [
        {
          pluginId: "legacy-plugin",
          severity: "warn",
          code: "hook-only",
          message: "uses a compatibility shim",
        },
      ],
    });

    expect(text).toContain(
      "⚠️ Plugins: 1 plugin error · 1 runtime tool quarantine · 1 channel plugin failure",
    );
    expect(text).toContain("Loaded: 1 (ok-plugin)");
    expect(text).toContain("Disabled: 1");
    expect(text).toContain("- bad-plugin [load]: module failed");
    expect(text).toContain("- bad_tool owner=plugin:bad-tools: unsupported anyOf");
    expect(text).toContain("- sms plugin=sms-plugin [setup]: setup failed");
    expect(text).toContain("Diagnostics: 0 errors · 1 warnings");
    expect(text).toContain("- WARN legacy-plugin [hook-only]: uses a compatibility shim");
    expect(text).toContain("Full inventory: /plugins list");
  });
});
