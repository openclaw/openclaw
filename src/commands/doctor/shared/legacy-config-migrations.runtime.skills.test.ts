import { describe, expect, it } from "vitest";
import { normalizeUpdatePostInstallDoctorWarnings } from "../../../infra/update-doctor-result.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";
import { collectAgentSkillAllowlistRetirementWarnings } from "./legacy-config-migrations.runtime.skills.js";

describe("agent skill name allowlist retirement", () => {
  it.each([
    { label: "unrestricted", agents: { entries: { main: {} } }, count: 0 },
    {
      label: "inherited default",
      agents: { defaults: { skills: ["github"] }, entries: { main: {}, other: {} } },
      count: 1,
    },
    {
      label: "explicit overrides",
      agents: {
        defaults: { skills: [] },
        entries: { main: { skills: ["weather"] }, other: { skills: [] } },
      },
      count: 3,
    },
    {
      label: "published legacy roster",
      agents: {
        defaults: { skills: ["github"] },
        list: [
          { id: "main", skills: [] },
          { id: "other", skills: ["weather"] },
        ],
      },
      count: 3,
    },
  ])(
    "retires $label without turning agent exclusions into global disables",
    ({ agents, count }) => {
      const raw = {
        agents,
        skills: {
          allowBundled: ["weather"],
          entries: { disabled: { enabled: false, env: { FIXTURE: "retained" } } },
        },
        tools: { exec: { autoAllowSkills: false, security: "allowlist" } },
      };
      const before = structuredClone(raw);
      const { next, warnings = [] } = applyLegacyDoctorMigrations(raw, {
        sourceConfigBeforeMigrations: raw,
        pluginContracts: false,
      });
      const repaired = next ?? raw;
      expect(collectAgentSkillAllowlistRetirementWarnings(repaired)).toEqual([]);
      expect(warnings).toHaveLength(count);
      for (const warning of warnings) {
        expect(warning).toContain("is retired");
        expect(warning).toContain("All currently and future otherwise-eligible skills");
        expect(warning).toContain("prior agent-specific restrictions are not preserved");
        expect(warning).toContain("old [] no longer disables all skills");
        expect(warning).toContain("session selections remain effective");
        expect(warning).toContain("pre-migration config backup");
      }
      expect(repaired.skills).toEqual(before.skills);
      expect(repaired.tools).toEqual(before.tools);
      expect(raw).toEqual(before);
      const again = applyLegacyDoctorMigrations(repaired, {
        sourceConfigBeforeMigrations: repaired,
        pluginContracts: false,
      });
      expect(again.warnings).toBeUndefined();
      expect(again.changes.some((change) => change.includes("name allowlist"))).toBe(false);
    },
  );

  it("reports every authored path without logging the selection contents", () => {
    expect(
      collectAgentSkillAllowlistRetirementWarnings({
        agents: { defaults: { skills: ["github"] }, entries: { main: { skills: [] } } },
      }),
    ).toEqual([
      expect.stringContaining("Retired path: agents.defaults.skills."),
      expect.stringContaining("Retired path: agents.entries.main.skills."),
    ]);
  });

  it("keeps the complete policy notice within the shipped updater warning bound for large lists", () => {
    const skills = Array.from({ length: 40 }, (_, index) => "synthetic-skill-" + index);
    const warnings = normalizeUpdatePostInstallDoctorWarnings(
      collectAgentSkillAllowlistRetirementWarnings({ agents: { defaults: { skills } } }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("is retired");
    expect(warnings[0]).toContain("All currently and future otherwise-eligible skills");
    expect(warnings[0]).toContain("prior agent-specific restrictions are not preserved");
    expect(warnings[0]).toContain("old [] no longer disables all skills");
    expect(warnings[0]).toContain("session selections remain effective");
    expect(warnings[0]).toContain("pre-migration config backup");
    expect(warnings[0]).toContain("Retired path: agents.defaults.skills.");
    expect(warnings[0]).not.toContain(skills[0]);
  });

  it("leaves unsupported malformed intent for normal validation instead of guessing", () => {
    const raw = { agents: { defaults: { skills: { unknown: true } } } };
    const { next } = applyLegacyDoctorMigrations(raw, {
      sourceConfigBeforeMigrations: raw,
      pluginContracts: false,
    });
    expect((next ?? raw).agents).toEqual(raw.agents);
  });
});
