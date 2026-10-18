import { describe, expect, it } from "vitest";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_SKILLS } from "./legacy-config-migrations.runtime.skills.js";

function migrate(raw: Record<string, unknown>) {
  const changes: string[] = [];
  for (const migration of LEGACY_CONFIG_MIGRATIONS_RUNTIME_SKILLS) {
    migration.apply(raw, changes);
  }
  return { raw, changes };
}

const ENABLE_AUTO_HINT =
  "Run `openclaw config set skills.workshop.autonomous.mode auto` to let agents save and update skills automatically (every change is announced and undoable).";

describe("Skill Workshop autonomy config migration", () => {
  it.each([
    {
      enabled: true,
      change: `Mapped skills.workshop.autonomous.enabled to mode: "off" because Skill Workshop proposals were removed. ${ENABLE_AUTO_HINT}`,
    },
    { enabled: false, change: 'Mapped skills.workshop.autonomous.enabled to mode: "off".' },
  ] as const)("maps enabled=$enabled to off", ({ enabled, change }) => {
    const result = migrate({
      skills: { workshop: { autonomous: { enabled } } },
    });

    expect(result.raw).toEqual({
      skills: { workshop: { autonomous: { mode: "off" } } },
    });
    expect(result.changes).toEqual([change]);
  });

  it("maps the removed propose mode to off and drops proposal settings", () => {
    const result = migrate({
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
      skills: { workshop: { autonomous: { mode: "off" }, maxSkillBytes: 8000 } },
    });
    expect(result.changes).toEqual([
      `Skill Workshop proposals were removed; set skills.workshop.autonomous.mode to "off" (was "propose"). ${ENABLE_AUTO_HINT}`,
      "Removed skills.workshop.approvalPolicy; Skill Workshop proposals were removed.",
      "Removed skills.workshop.maxPending; Skill Workshop proposals were removed.",
    ]);
  });

  it("keeps current modes unchanged", () => {
    for (const mode of ["off", "auto"]) {
      const result = migrate({ skills: { workshop: { autonomous: { mode } } } });
      expect(result.raw).toEqual({ skills: { workshop: { autonomous: { mode } } } });
      expect(result.changes).toEqual([]);
    }
  });

  it("leaves an absent legacy key absent so the new auto default applies", () => {
    const result = migrate({ skills: { workshop: { autonomous: {} } } });

    expect(result.raw).toEqual({ skills: { workshop: { autonomous: {} } } });
    expect(result.changes).toEqual([]);
  });

  it("drops the retired symlink write option", () => {
    const result = migrate({
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
