// Plugin health status tests cover compact and detailed chat formatting.
import { describe, expect, it } from "vitest";
import {
  formatCompactPluginHealthLine,
  formatDetailedPluginHealth,
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
    });

    expect(text).toContain("⚠️ Plugins: 1 plugin error");
    expect(text).toContain("Loaded: 1 (ok-plugin)");
    expect(text).toContain("Disabled: 1");
    expect(text).toContain("- bad-plugin [load]: module failed");
    expect(text).toContain("Diagnostics: 0 errors · 1 warnings");
    expect(text).toContain("Full inventory: /plugins list");
  });
});
