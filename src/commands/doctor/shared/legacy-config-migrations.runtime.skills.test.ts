import { describe, expect, it } from "vitest";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_SKILLS } from "./legacy-config-migrations.runtime.skills.js";

const MOVE_ID = "skills.workshop->plugins.entries.skill-workshop.config";

function migrate(raw: Record<string, unknown>, { move = true } = {}) {
  const changes: string[] = [];
  for (const migration of LEGACY_CONFIG_MIGRATIONS_RUNTIME_SKILLS) {
    if (move || migration.id !== MOVE_ID) {
      migration.apply(raw, changes);
    }
  }
  return { raw, changes };
}

/** The shape repairs that canonicalize `skills.workshop` before the final move. */
const repairShape = (raw: Record<string, unknown>) => migrate(raw, { move: false });

describe("Skill Workshop autonomy config migration", () => {
  it.each([
    { enabled: true, mode: "propose" },
    { enabled: false, mode: "off" },
  ] as const)("maps enabled=$enabled to $mode", ({ enabled, mode }) => {
    const result = repairShape({
      skills: { workshop: { autonomous: { enabled } } },
    });

    expect(result.raw).toEqual({
      skills: { workshop: { autonomous: { mode } } },
    });
    expect(result.changes).toEqual([
      `Mapped skills.workshop.autonomous.enabled to mode: "${mode}".`,
    ]);
  });

  it("keeps propose mode and drops retired proposal settings", () => {
    const result = repairShape({
      skills: {
        workshop: {
          autonomous: { mode: "propose" },
          approvalPolicy: "pending",
          maxPending: 20,
          maxSkillBytes: 8000,
        },
      },
    });

    expect(result.raw).toEqual({
      skills: { workshop: { autonomous: { mode: "propose" }, maxSkillBytes: 8000 } },
    });
    expect(result.changes).toEqual([
      "Removed skills.workshop.approvalPolicy; Skill Workshop proposals were removed.",
      "Removed skills.workshop.maxPending; Skill Workshop proposals were removed.",
    ]);
  });

  it("keeps current modes unchanged", () => {
    for (const mode of ["off", "propose", "auto"]) {
      const result = repairShape({ skills: { workshop: { autonomous: { mode } } } });
      expect(result.raw).toEqual({ skills: { workshop: { autonomous: { mode } } } });
      expect(result.changes).toEqual([]);
    }
  });

  it("leaves an absent legacy key absent so the new auto default applies", () => {
    const result = repairShape({ skills: { workshop: { autonomous: {} } } });

    expect(result.raw).toEqual({ skills: { workshop: { autonomous: {} } } });
    expect(result.changes).toEqual([]);
  });

  it("drops the retired symlink write option", () => {
    const result = repairShape({
      skills: {
        workshop: {
          allowSymlinkTargetWrites: true,
          autonomous: { mode: "auto" },
        },
      },
    });

    expect(result.raw).toEqual({
      skills: { workshop: { autonomous: { mode: "auto" } } },
    });
    expect(result.changes).toEqual([
      "Removed retired skills.workshop.allowSymlinkTargetWrites; Skill Workshop writes only inside its own directory.",
    ]);
  });
});

describe("Skill Workshop settings move into the plugin config", () => {
  const marker = { migrations: { skillWorkshopPlugin: true } };

  it("moves every setting, drops empty skills, and records the migration", () => {
    const result = migrate({
      skills: {
        workshop: { autonomous: { mode: "propose", channelNotices: true }, maxSkillBytes: 8000 },
      },
    });

    expect(result.raw).toEqual({
      plugins: {
        entries: {
          "skill-workshop": {
            config: { autonomous: { mode: "propose", channelNotices: true }, maxSkillBytes: 8000 },
          },
        },
      },
      meta: marker,
    });
    expect(result.changes).toEqual([
      "Moved skills.workshop to plugins.entries.skill-workshop.config.",
    ]);
  });

  it("keeps other settings and lets existing plugin settings win", () => {
    const result = migrate({
      skills: {
        load: { watch: false },
        workshop: { autonomous: { mode: "off", channelNotices: true } },
      },
      plugins: {
        allow: ["skill-workshop"],
        entries: { "skill-workshop": { config: { autonomous: { mode: "propose" } } } },
      },
      meta: marker,
    });

    expect(result.raw).toEqual({
      skills: { load: { watch: false } },
      plugins: {
        allow: ["skill-workshop"],
        entries: {
          "skill-workshop": { config: { autonomous: { mode: "propose", channelNotices: true } } },
        },
      },
      meta: marker,
    });
  });

  it("replaces an entry written while Workshop was built in instead of merging it", () => {
    // The policy repair earlier in this pass drops the unmarked entry before the move.
    const result = migrate({
      skills: { workshop: { autonomous: { mode: "off" } } },
      plugins: { entries: { "skill-workshop": { enabled: false, config: { stale: true } } } },
    });

    expect(result.raw).toMatchObject({
      plugins: { entries: { "skill-workshop": { config: { autonomous: { mode: "off" } } } } },
      meta: marker,
    });
  });

  it("maps the retired enabled switch before moving it", () => {
    expect(migrate({ skills: { workshop: { autonomous: { enabled: true } } } }).raw).toEqual({
      plugins: { entries: { "skill-workshop": { config: { autonomous: { mode: "propose" } } } } },
      meta: marker,
    });
  });
});
