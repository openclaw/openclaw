import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";

const declarations = import.meta.glob<{
  pluginId: string;
  memoryAddon: { order: number; label: string; labelKey: string };
}>("../../../../extensions/*/control-ui.presentation.json", { eager: true, import: "default" });

describe("bundled memory add-on presentation", () => {
  it("binds each declaration to its own plugin and an existing English label", () => {
    const ids = new Set<string>();
    for (const [path, declaration] of Object.entries(declarations)) {
      const manifest = JSON.parse(
        readFileSync(
          new URL(
            path.replace("control-ui.presentation.json", "openclaw.plugin.json"),
            import.meta.url,
          ),
          "utf8",
        ),
      );
      expect(Object.keys(declaration).toSorted()).toEqual(["memoryAddon", "pluginId"]);
      expect(Object.keys(declaration.memoryAddon).toSorted()).toEqual([
        "label",
        "labelKey",
        "order",
      ]);
      expect(declaration.pluginId).toBe(manifest.id);
      expect(ids.has(declaration.pluginId)).toBe(false);
      ids.add(declaration.pluginId);
      expect(Number.isFinite(declaration.memoryAddon.order)).toBe(true);
      const label = declaration.memoryAddon.labelKey
        .split(".")
        .reduce<unknown>(
          (value, key) =>
            value && typeof value === "object" ? Reflect.get(value, key) : undefined,
          registerSettingsEnglish.catalog,
        );
      expect(typeof label).toBe("string");
      expect(label).not.toBe("");
      expect(label).toBe(declaration.memoryAddon.label);
    }
    expect(ids.size).toBeGreaterThan(0);
  });
});
