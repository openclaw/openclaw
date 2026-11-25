import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { en } from "../../i18n/locales/en.ts";
import {
  sessionSourcePresentations,
  type SessionSourcePresentation,
} from "./session-source-presentation.ts";

const declarations = import.meta.glob<SessionSourcePresentation>(
  "../../../../extensions/*/control-ui.session-source.json",
  { eager: true, import: "default" },
);

describe("bundled session source presentation", () => {
  it("binds ordered rows and English labels to the owning plugin's boolean setting", () => {
    registerSettingsEnglish();
    const ids = new Set<string>();
    const orders = new Set<number>();
    for (const [path, declaration] of Object.entries(declarations)) {
      const manifest = JSON.parse(
        readFileSync(
          new URL(
            path.replace("control-ui.session-source.json", "openclaw.plugin.json"),
            import.meta.url,
          ),
          "utf8",
        ),
      );
      expect(declaration.pluginId).toBe(manifest.id);
      expect(ids.has(declaration.pluginId)).toBe(false);
      ids.add(declaration.pluginId);
      expect(Number.isInteger(declaration.order)).toBe(true);
      expect(orders.has(declaration.order)).toBe(false);
      orders.add(declaration.order);
      expect(Object.keys(declaration).toSorted()).toEqual([
        "icon",
        "key",
        "labelKey",
        "order",
        "plugin",
        "pluginId",
      ]);
      expect(declaration.plugin).not.toBe("");
      expect(declaration.icon).not.toBe("");
      expect(manifest.configSchema.properties[declaration.key].properties.enabled.type).toBe(
        "boolean",
      );
      const label = declaration.labelKey
        .split(".")
        .reduce<unknown>(
          (current, segment) =>
            current && typeof current === "object" ? Reflect.get(current, segment) : undefined,
          en,
        );
      expect(typeof label).toBe("string");
      expect(label).not.toBe("");
    }
    expect(sessionSourcePresentations.map((source) => source.pluginId)).toEqual([
      "anthropic",
      "codex",
      "opencode",
      "acpx",
    ]);
  });
});
