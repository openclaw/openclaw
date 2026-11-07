import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import type { PluginConfigUiHint } from "../plugins/manifest-types.js";
import { buildConfigSchemaCore } from "./schema.js";

const manifest = JSON.parse(
  fs.readFileSync(path.resolve("extensions/skill-workshop/openclaw.plugin.json"), "utf8"),
) as {
  id: string;
  configSchema: Record<string, unknown>;
  uiHints: Record<string, PluginConfigUiHint>;
};

it("C1: exposes Workshop settings with labels and help in the common settings tier", () => {
  const { uiHints } = buildConfigSchemaCore({
    plugins: [
      { id: manifest.id, configSchema: manifest.configSchema, configUiHints: manifest.uiHints },
    ],
  });
  const key = (setting: string) => `plugins.entries.skill-workshop.config.${setting}`;
  const described = { label: expect.any(String), help: expect.any(String) };
  for (const setting of ["autonomous.mode", "autonomous.channelNotices"]) {
    expect(uiHints[key(setting)]).toMatchObject(described);
    expect(uiHints[key(setting)]?.advanced).not.toBe(true);
  }
  // Settings users read the help to discover each mode.
  for (const mode of ['"auto"', '"propose"', '"off"']) {
    expect(uiHints[key("autonomous.mode")]?.help).toContain(mode);
  }
});
