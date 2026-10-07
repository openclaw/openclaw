import { getRecord, type LegacyConfigMigrationSpec } from "../../../config/legacy.shared.js";
import { visitAgentConfigScopes, deleteRetiredPath } from "./legacy-config-record-shared.js";

/** Operator-visible policy-change warnings; the normal Doctor writer owns backups. */
export function collectAgentSkillAllowlistRetirementWarnings(
  raw: Record<string, unknown>,
): string[] {
  const warnings: string[] = [];
  visitAgentConfigScopes(raw, (scope, path) => {
    if (!Array.isArray(scope.skills) || !scope.skills.every((name) => typeof name === "string")) {
      return;
    }
    warnings.push(
      "Agent skill name allowlist is retired. " +
        "All currently and future otherwise-eligible skills become discoverable; " +
        "prior agent-specific restrictions are not preserved, and an old [] no longer disables all skills. " +
        "Global skill disables, prerequisites, bundled-skill controls, and session selections remain effective. " +
        "Recover the original selection from the normal pre-migration config backup. Retired path: " +
        path +
        ".skills.",
    );
  });
  return warnings;
}

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_SKILLS: LegacyConfigMigrationSpec[] = [
  {
    id: "agents.skills-allowlists-retired",
    legacyRules: [
      {
        path: ["agents"],
        message:
          'Agent skill name allowlists are retired; run "openclaw doctor --fix" to remove them and review the changed discovery behavior.',
        match: (_value, root) => collectAgentSkillAllowlistRetirementWarnings(root).length > 0,
      },
    ],
    apply: (raw, changes) => {
      visitAgentConfigScopes(raw, (scope, path) => {
        if (
          !Array.isArray(scope.skills) ||
          !scope.skills.every((name) => typeof name === "string")
        ) {
          return;
        }
        delete scope.skills;
        changes.push("Removed retired " + path + ".skills name allowlist.");
      });
    },
  },
  {
    id: "skills.workshop.autonomous.enabled->mode",
    legacyRules: [
      {
        path: ["skills", "workshop", "autonomous", "enabled"],
        message:
          'skills.workshop.autonomous.enabled is retired; use skills.workshop.autonomous.mode. Run "openclaw doctor --fix".',
      },
    ],
    apply: (raw, changes) => {
      const autonomous = getRecord(getRecord(getRecord(raw.skills)?.workshop)?.autonomous);
      if (!autonomous || !Object.hasOwn(autonomous, "enabled")) {
        return;
      }
      if (autonomous.mode === undefined) {
        const mode = autonomous.enabled === false ? "off" : "propose";
        autonomous.mode = mode;
        changes.push(`Mapped skills.workshop.autonomous.enabled to mode: "${mode}".`);
      } else {
        changes.push(
          "Removed skills.workshop.autonomous.enabled because autonomous.mode is already set.",
        );
      }
      delete autonomous.enabled;
    },
  },
  {
    id: "skills.workshop.allowSymlinkTargetWrites-retired",
    legacyRules: [
      {
        path: ["skills", "workshop", "allowSymlinkTargetWrites"],
        message:
          'skills.workshop.allowSymlinkTargetWrites is retired; Skill Workshop writes only inside its own directory. Run "openclaw doctor --fix".',
      },
    ],
    apply: (raw, changes) => {
      if (deleteRetiredPath(raw, ["skills", "workshop", "allowSymlinkTargetWrites"])) {
        changes.push(
          "Removed retired skills.workshop.allowSymlinkTargetWrites; Skill Workshop writes only inside its own directory.",
        );
      }
    },
  },
];
