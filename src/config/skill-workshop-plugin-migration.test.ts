import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import { materializeSkillWorkshopPlugin } from "./skill-workshop-plugin-migration.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const builtInEraConfig = (): OpenClawConfig => ({
  plugins: {
    allow: ["diffs"],
    deny: ["skill-workshop"],
    entries: { "skill-workshop": { enabled: false }, diffs: { enabled: true } },
  },
});

describe("materializeSkillWorkshopPlugin", () => {
  it("drops policy written while Workshop was built in, so Workshop keeps running", () => {
    const { config, changes } = materializeSkillWorkshopPlugin(builtInEraConfig());

    expect(config.plugins).toEqual({
      allow: ["diffs", "skill-workshop"],
      deny: [],
      entries: { diffs: { enabled: true } },
    });
    expect(config.meta?.migrations?.skillWorkshopPlugin).toBe(true);
    expect(changes).toHaveLength(3);
  });

  it("keeps policy a write adds to an unmarked config", () => {
    const previous: OpenClawConfig = { plugins: { allow: [] } };
    const next: OpenClawConfig = {
      plugins: { deny: ["skill-workshop"], entries: { "skill-workshop": { enabled: false } } },
    };

    const { config, changes } = materializeSkillWorkshopPlugin(next, previous);

    expect(config.plugins).toEqual(next.plugins);
    expect(config.meta?.migrations?.skillWorkshopPlugin).toBe(true);
    expect(changes).toEqual([]);
  });

  it("honors skill-workshop policy once the migration is recorded", () => {
    const marked = {
      ...builtInEraConfig(),
      meta: { migrations: { skillWorkshopPlugin: true as const } },
    };

    expect(materializeSkillWorkshopPlugin(marked).config).toBe(marked);
  });
});

it("keeps the plugin's declared learned skill folder equal to core Workshop's folder", () => {
  // Core Workshop still writes learned skills until its writers move into the plugin.
  const manifest = JSON.parse(
    fs.readFileSync(
      path.resolve(import.meta.dirname, "../../extensions/skill-workshop/openclaw.plugin.json"),
      "utf8",
    ),
  ) as { agentSkillsDir?: string };

  expect(manifest.agentSkillsDir).toBe(path.basename(resolveWorkshopSkillsDir({}, "main")));
});
