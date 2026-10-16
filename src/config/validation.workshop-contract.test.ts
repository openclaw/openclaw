import { describe, expect, it } from "vitest";
import { migrateLegacyConfig } from "../commands/doctor/shared/legacy-config-migrate.js";
import { validateConfigObjectRaw } from "./validation.js";

describe("Workshop configuration contract", () => {
  it.each(["auto", "off"])("C1: accepts mode %s and current settings", (mode) => {
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
    { autonomous: { mode: "propose" } },
    { autonomous: { channelNotices: "yes" } },
    { maxSkillBytes: "large" },
  ])("C1: refuses invalid Workshop settings %j", (workshop) => {
    expect(validateConfigObjectRaw({ skills: { workshop } }).ok).toBe(false);
  });

  it.each([true, false])(
    "C2: Doctor migrates legacy enabled=%s to off without silently opting into direct writes",
    (enabled) => {
      const raw = { skills: { workshop: { autonomous: { enabled } } } };
      expect(validateConfigObjectRaw(raw).ok).toBe(false);
      const result = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });
      expect(result.partiallyValid).toBeUndefined();
      expect(result.config?.skills?.workshop?.autonomous).toEqual({ mode: "off" });
      expect(result.changes).toContain(
        enabled
          ? 'Mapped skills.workshop.autonomous.enabled to mode: "off" because Skill Workshop proposals were removed. Run `openclaw config set skills.workshop.autonomous.mode auto` to let agents save and update skills automatically (every change is announced and undoable).'
          : 'Mapped skills.workshop.autonomous.enabled to mode: "off".',
      );
      expect(validateConfigObjectRaw(result.config).ok).toBe(true);
      expect(
        migrateLegacyConfig(result.config, { sourceConfigBeforeMigrations: result.config }),
      ).toEqual({ config: null, changes: [] });
    },
  );
});
