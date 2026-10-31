import { describe, expect, it } from "vitest";
import { migrateLegacyConfig } from "../commands/doctor/shared/legacy-config-migrate.js";
import { validateConfigObjectRaw } from "./validation.js";

describe("Workshop configuration contract", () => {
  it.each(["auto", "propose", "off"])("C1: accepts mode %s and current settings", (mode) => {
    const result = validateConfigObjectRaw({
      skills: { workshop: { autonomous: { mode, channelNotices: true }, maxSkillBytes: 40000 } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.skills?.workshop).toEqual({
        autonomous: { mode, channelNotices: true },
        maxSkillBytes: 40000,
      });
    }
  });

  it.each([
    { autonomous: { mode: "review" } },
    { autonomous: { channelNotices: "yes" } },
    { maxSkillBytes: "large" },
  ])("C1: refuses invalid Workshop settings %j", (workshop) => {
    expect(validateConfigObjectRaw({ skills: { workshop } }).ok).toBe(false);
  });

  it.each([
    [true, "propose"],
    [false, "off"],
  ] as const)("C2: Doctor migrates legacy enabled=%s to mode %s", (enabled, mode) => {
    const raw = { skills: { workshop: { autonomous: { enabled } } } };
    expect(validateConfigObjectRaw(raw).ok).toBe(false);
    const result = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });
    expect(result.partiallyValid).toBeUndefined();
    // enabled=true reviewed changes before they applied; propose keeps that, never auto.
    expect(result.config?.skills?.workshop?.autonomous).toEqual({ mode });
    expect(result.changes).toContain(
      `Mapped skills.workshop.autonomous.enabled to mode: "${mode}".`,
    );
    expect(validateConfigObjectRaw(result.config).ok).toBe(true);
    expect(
      migrateLegacyConfig(result.config, { sourceConfigBeforeMigrations: result.config }),
    ).toEqual({ config: null, changes: [] });
  });
});
