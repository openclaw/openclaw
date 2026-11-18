import { describe, expect, it } from "vitest";
import { buildConfigSchemaCore, lookupConfigSchema } from "../config/schema.js";
import { CONTROL_UI_SETTINGS_PLACES } from "./control-ui-settings-places.js";

describe("Control UI settings places", () => {
  const schema = buildConfigSchemaCore();
  const configRoots = new Set(Object.keys(schema.schema.properties ?? {}));
  const configSettings = Object.entries(CONTROL_UI_SETTINGS_PLACES).flatMap(([id, place]) =>
    "hash" in place && configRoots.has(place.hash.split(".")[0]!) ? [[id, place.hash]] : [],
  );

  it("lists settings that edit config values", () => {
    expect(configSettings.length).toBeGreaterThan(4);
  });

  it.each(configSettings)("%s names a setting the config schema has", (_id, settingId) => {
    expect(lookupConfigSchema(schema, settingId!)).not.toBeNull();
  });
});
