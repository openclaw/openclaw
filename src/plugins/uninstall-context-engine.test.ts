import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { removePluginFromConfig } from "./uninstall-config.js";
import { planPluginUninstall } from "./uninstall.js";
import { disablePluginAfterUpdateFailure, migratePluginConfigId } from "./update-config.js";

describe("context-engine uninstall ownership", () => {
  const install = (
    contextEngineIdsByPlugin: Record<string, string[]>,
    sourcePath?: string,
  ): PluginInstallRecord => ({
    source: "path",
    sourcePath,
    contextEngineIdsByPlugin,
  });
  const config = (overrides: OpenClawConfig["plugins"] = {}): OpenClawConfig => ({
    plugins: {
      slots: { contextEngine: "canonical-engine", memory: "memory-core" },
      entries: { "vendor-plugin": { enabled: true } },
      installs: {
        "vendor-plugin": install(
          { "vendor-plugin": ["canonical-engine"] },
          "/missing/vendor-plugin",
        ),
      },
      ...overrides,
    },
  });
  it("clears a missing plugin's selected engine without reading its files", () => {
    const result = removePluginFromConfig(config(), "vendor-plugin");
    expect(result.config.plugins?.slots).toEqual({ memory: "memory-core" });
    expect(result.actions.contextEngineSlot).toBe(true);
    expect(result.config.plugins?.installs).toBeUndefined();
  });

  it("preserves a selection owned by another plugin", () => {
    const input = config();
    input.plugins!.slots!.contextEngine = "other-engine";
    const result = removePluginFromConfig(input, "vendor-plugin");
    expect(result.config.plugins?.slots?.contextEngine).toBe("other-engine");
    expect(result.actions.contextEngineSlot).toBe(false);
  });

  it("does not rename a declared engine when its plugin ID migrates", () => {
    const input = config();
    input.plugins!.slots!.contextEngine = "vendor-plugin";
    input.plugins!.installs!["vendor-plugin"]!.contextEngineIdsByPlugin = {
      "vendor-plugin": ["vendor-plugin"],
    };
    const migrated = migratePluginConfigId(input, "vendor-plugin", "renamed-plugin");
    expect(migrated.plugins?.slots?.contextEngine).toBe("vendor-plugin");
    expect(migrated.plugins?.installs?.["renamed-plugin"]?.contextEngineIdsByPlugin).toEqual({
      "renamed-plugin": ["vendor-plugin"],
    });
    expect(disablePluginAfterUpdateFailure(migrated, "renamed-plugin").plugins?.slots).toEqual({
      memory: "memory-core",
    });
  });

  it("does not clear an ambiguously claimed engine", () => {
    const input = config();
    input.plugins!.installs!.other = install({ other: ["canonical-engine"] });
    expect(removePluginFromConfig(input, "vendor-plugin").actions.contextEngineSlot).toBe(false);
  });

  it.each([false, true])(
    "excludes all departing children but preserves outside owners: %s",
    (survives) => {
      const input = config({
        entries: { a: { enabled: true }, b: { enabled: false } },
        slots: { memory: "memory-core", contextEngine: "engine" },
        installs: {
          bundle: install({ a: ["engine"], b: ["engine"] }, "/missing/bundle"),
          ...(survives ? { other: install({ other: ["engine"] }) } : {}),
        },
      });
      const result = planPluginUninstall({ config: input, pluginId: "bundle", deleteFiles: false });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(result.error);
      }
      expect(result.config.plugins?.installs?.bundle).toBeUndefined();
      expect(result.config.plugins?.slots?.contextEngine).toBe(survives ? "engine" : undefined);
      expect(result.config.plugins?.slots?.memory).toBe("memory-core");
      expect(result.actions.contextEngineSlot).toBe(!survives);
      expect(result.config.plugins?.entries).toEqual({
        bundle: { enabled: false },
        a: { enabled: false },
        b: { enabled: false },
      });
    },
  );
});
