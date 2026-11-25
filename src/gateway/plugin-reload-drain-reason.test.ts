import { describe, expect, it } from "vitest";
import { formatPluginReloadDrainReason } from "./plugin-reload-drain-reason.js";

const format = (holds: Parameters<typeof formatPluginReloadDrainReason>[0]["holds"]) =>
  formatPluginReloadDrainReason({
    holds,
    includeCalls: false,
    drainBudgetSeconds: 60,
    cancellable: false,
  });

describe("plugin reload drain reason", () => {
  it("says turns hand over at their next step for plugins that declare it", () => {
    expect(format([{ pluginId: "swap", count: 1, turnHandover: true }])).toBe(
      "Plugin replacement queued behind 1 retained work item(s) for plugin swap. Running turns on swap continue on the new version at their next step. New agent runs wait up to the 60s drain budget.",
    );
  });

  it("names the plugins that keep whole turns", () => {
    const reason = format([
      { pluginId: "swap", count: 1, turnHandover: true },
      { pluginId: "pinned", count: 2, turnHandover: false },
    ]);
    expect(reason).toContain("queued behind 3 retained work item(s) for plugin swap, pinned.");
    expect(reason).toContain("Running turns keep pinned until they finish.");
  });
});
