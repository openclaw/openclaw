import { describe, expect, it } from "vitest";
import { buildConfigSchemaCore, lookupConfigSchema } from "../../config/schema.js";
import {
  CONTROL_UI_SETTING_ID_ALIASES,
  CONTROL_UI_SETTINGS_PAGES,
  findControlUiSetting,
} from "./index.js";

const schema = buildConfigSchemaCore();
const configRoots = new Set(Object.keys(schema.schema.properties ?? {}));
const entries = CONTROL_UI_SETTINGS_PAGES.flatMap((page) =>
  Object.entries(page.settings).map(([id, entry]) => ({ page, id, entry })),
);

describe("Control UI settings list", () => {
  it.each(entries.map((item) => [item.id, item] as const))(
    "%s is a config path the schema has, or starts outside the config",
    (id) => {
      const root = id.split(".")[0]!;
      if (configRoots.has(root)) {
        expect(lookupConfigSchema(schema, id.replace(/\.\*$/u, ".x"))).not.toBeNull();
      } else {
        expect(id).toMatch(/^[a-z][A-Za-z0-9]*(?:\.(?:[a-z][A-Za-z0-9]*|\*))+$/u);
      }
    },
  );

  it.each(entries.map((item) => [item.id, item] as const))(
    "%s has plain words and an existing disclosure",
    (_id, { page, entry }) => {
      expect(entry.label).toMatch(/^[A-Z][\x20-\x7E]*$/u);
      expect(entry.label).not.toContain(" > ");
      if (entry.within) {
        expect(Object.keys(page.settings)).toContain(entry.within);
      }
    },
  );

  it("resolves items, former IDs and other anchors", () => {
    const [id] = Object.keys(CONTROL_UI_SETTING_ID_ALIASES);
    if (id) {
      expect(findControlUiSetting(id)?.id).toBe(CONTROL_UI_SETTING_ID_ALIASES[id]);
    }
    expect(findControlUiSetting("agents.defaults.model.fallbacks")?.page.path).toBe(
      "/settings/model-providers",
    );
    expect(findControlUiSetting("settings-model-behavior")).toBeUndefined();
  });
});
