import { describe, expect, it } from "vitest";
import { migrateLegacyConfig } from "../commands/doctor/shared/legacy-config-migrate.js";
import { validateConfigObjectRaw, validateConfigObjectRawWithPlugins } from "./validation.js";

// Workshop settings live in the bundled plugin's config; the manifest schema validates them.
const withWorkshop = (config: Record<string, unknown>) => ({
  plugins: { entries: { "skill-workshop": { config } } },
  meta: { migrations: { skillWorkshopPlugin: true } },
});

describe("Workshop configuration contract", () => {
  it.each(["auto", "propose", "off"])("C1: accepts mode %s and current settings", (mode) => {
    const settings = { autonomous: { mode, channelNotices: true }, maxSkillBytes: 40000 };
    const result = validateConfigObjectRawWithPlugins(withWorkshop(settings));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.plugins?.entries?.["skill-workshop"]?.config).toEqual(settings);
    }
  });

  it.each([
    { autonomous: { mode: "review" } },
    { autonomous: { channelNotices: "yes" } },
    { maxSkillBytes: "large" },
  ])("C1: refuses invalid Workshop settings %j", (settings) => {
    expect(validateConfigObjectRawWithPlugins(withWorkshop(settings)).ok).toBe(false);
  });

  it("C1: refuses the retired core skills.workshop key", () => {
    expect(
      validateConfigObjectRaw({ skills: { workshop: { autonomous: { mode: "off" } } } }).ok,
    ).toBe(false);
  });

  it.each([
    [true, "propose"],
    [false, "off"],
  ] as const)("C2: Doctor migrates legacy enabled=%s to plugin mode %s", (enabled, mode) => {
    const raw = { skills: { workshop: { autonomous: { enabled } } } };
    expect(validateConfigObjectRaw(raw).ok).toBe(false);
    const result = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });
    expect(result.partiallyValid).toBeUndefined();
    // enabled=true reviewed changes before they applied; propose keeps that, never auto.
    expect(result.config?.plugins?.entries?.["skill-workshop"]?.config).toEqual({
      autonomous: { mode },
    });
    expect(result.config?.skills).toBeUndefined();
    expect(result.changes).toContain(
      `Mapped skills.workshop.autonomous.enabled to mode: "${mode}".`,
    );
    expect(validateConfigObjectRawWithPlugins(result.config).ok).toBe(true);
    expect(
      migrateLegacyConfig(result.config, { sourceConfigBeforeMigrations: result.config }),
    ).toEqual({ config: null, changes: [] });
  });
});
