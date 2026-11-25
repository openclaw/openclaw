// Plugin uninstall selection tests cover CLI uninstall target matching.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolvePluginUninstallId } from "../plugins/uninstall-selection.js";

describe("resolvePluginUninstallId", () => {
  it("prefers an exact plugin id over an earlier plugin display name", () => {
    const alias = { id: "unrelated-plugin", name: "calendar" };
    const target = { id: "calendar", name: "Real Calendar" };

    const result = resolvePluginUninstallId({
      rawId: "calendar",
      config: {},
      plugins: [alias, target],
    });

    expect(result).toEqual({ ok: true, value: { pluginId: "calendar", plugin: target } });
  });

  it.each([
    { label: "an installed plugin", plugins: { installs: { calendar: { source: "npm" } } } },
    { label: "a stale plugin entry", plugins: { entries: { calendar: { enabled: true } } } },
    { label: "an allowlist entry", plugins: { allow: ["calendar"] } },
    { label: "a denylist entry", plugins: { deny: ["calendar"] } },
    { label: "the memory slot", plugins: { slots: { memory: "calendar" } } },
    { label: "the context-engine slot", plugins: { slots: { contextEngine: "calendar" } } },
  ])("prefers the exact id recorded by $label over a display-name alias", ({ plugins }) => {
    const alias = { id: "unrelated-plugin", name: "calendar" };

    const result = resolvePluginUninstallId({
      rawId: "calendar",
      config: { plugins } as OpenClawConfig,
      plugins: [alias],
    });

    expect(result).toEqual({ ok: true, value: { pluginId: "calendar" } });
  });
});
