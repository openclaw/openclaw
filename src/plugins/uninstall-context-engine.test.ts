import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { removePluginFromConfig } from "./uninstall-config.js";
import { planPluginUninstall } from "./uninstall.js";
import { disablePluginAfterUpdateFailure, migratePluginConfigId } from "./update-config.js";

describe("context-engine uninstall ownership", () => {
  const config = (): OpenClawConfig => ({
    plugins: {
      slots: { contextEngine: "canonical-engine", memory: "memory-core" },
      entries: { "vendor-plugin": { enabled: true } },
      installs: {
        "vendor-plugin": {
          source: "path",
          sourcePath: "/missing/vendor-plugin",
          contextEngineIdsByPlugin: { "vendor-plugin": ["canonical-engine"] },
        },
      },
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

  it("resets the declared engine when recovery disables a failed update", () => {
    expect(disablePluginAfterUpdateFailure(config(), "vendor-plugin").plugins?.slots).toEqual({
      memory: "memory-core",
    });
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
    expect(
      disablePluginAfterUpdateFailure(migrated, "renamed-plugin").plugins?.slots?.contextEngine,
    ).toBeUndefined();
  });

  it("does not clear an ambiguously claimed engine", () => {
    const input = config();
    input.plugins!.installs!.other = {
      source: "path",
      contextEngineIdsByPlugin: { other: ["canonical-engine"] },
    };
    expect(removePluginFromConfig(input, "vendor-plugin").actions.contextEngineSlot).toBe(false);
  });

  it("uses retained runtime-child ownership when the package inventory is missing", () => {
    const input = config();
    const record = input.plugins!.installs!["vendor-plugin"];
    if (!record) {
      throw new Error("Missing install fixture");
    }
    input.plugins!.installs = { "vendor-package": record };
    const result = planPluginUninstall({
      config: input,
      pluginId: "vendor-package",
      deleteFiles: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.actions.contextEngineSlot).toBe(true);
    expect(result.config.plugins?.slots).toEqual({ memory: "memory-core" });
  });
});
