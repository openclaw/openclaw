import { getRecord, type LegacyConfigMigrationSpec } from "../../../config/legacy.shared.js";
import { materializeSkillWorkshopPlugin } from "../../../config/skill-workshop-plugin-migration.js";
import { deleteRetiredPath } from "./legacy-config-record-shared.js";

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_SKILLS: LegacyConfigMigrationSpec[] = [
  {
    id: "plugins.skill-workshop-policy-while-built-in",
    legacyRules: [
      {
        path: ["plugins"],
        message:
          'skill-workshop plugin policy written while Skill Workshop was built in is ignored. Run "openclaw doctor --fix".',
        match: (_value, root) =>
          materializeSkillWorkshopPlugin(structuredClone(root)).changes.length > 0,
      },
    ],
    apply: (raw, changes) => {
      const migrated = materializeSkillWorkshopPlugin(raw);
      // Marker-only conversion is stamped by the config writer, not an unrelated Doctor repair.
      if (migrated.changes.length === 0) {
        return;
      }
      Object.assign(raw, migrated.config);
      changes.push(...migrated.changes);
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
        // enabled: true meant background reviews that propose changes for review.
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
    id: "skills.workshop.proposal-settings-retired",
    legacyRules: ["approvalPolicy", "maxPending"].map((key) => ({
      path: ["skills", "workshop", key],
      message: `skills.workshop.${key} was removed with Skill Workshop proposals. Run "openclaw doctor --fix".`,
    })),
    apply: (raw, changes) => {
      for (const key of ["approvalPolicy", "maxPending"]) {
        if (deleteRetiredPath(raw, ["skills", "workshop", key])) {
          changes.push(`Removed skills.workshop.${key}; Skill Workshop proposals were removed.`);
        }
      }
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
