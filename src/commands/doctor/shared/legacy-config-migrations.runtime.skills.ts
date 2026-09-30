import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
} from "../../../config/legacy.shared.js";
import { deleteRetiredPath } from "./legacy-config-record-shared.js";

const ENABLE_AUTO_HINT =
  "Run `openclaw config set skills.workshop.autonomous.mode auto` to let agents save and update skills automatically (every change is announced and undoable).";

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_SKILLS: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "skills.workshop.autonomous.enabled->mode",
    describe: "Migrate the retired Skill Workshop autonomy flag to autonomous.mode.",
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
        autonomous.mode = "off";
        changes.push(
          autonomous.enabled === false
            ? 'Mapped skills.workshop.autonomous.enabled to mode: "off".'
            : `Mapped skills.workshop.autonomous.enabled to mode: "off" because Skill Workshop proposals were removed. ${ENABLE_AUTO_HINT}`,
        );
      } else {
        changes.push(
          "Removed skills.workshop.autonomous.enabled because autonomous.mode is already set.",
        );
      }
      delete autonomous.enabled;
    },
  }),
  defineLegacyConfigMigration({
    id: "skills.workshop.autonomous.mode-propose->off",
    describe: "Map the removed Skill Workshop proposal mode to off.",
    legacyRules: [
      {
        path: ["skills", "workshop", "autonomous", "mode"],
        match: (value) => value === "propose",
        message:
          'skills.workshop.autonomous.mode "propose" was removed with Skill Workshop proposals; use "off" or "auto". Run "openclaw doctor --fix".',
      },
    ],
    apply: (raw, changes) => {
      const autonomous = getRecord(getRecord(getRecord(raw.skills)?.workshop)?.autonomous);
      if (autonomous?.mode !== "propose") {
        return;
      }
      autonomous.mode = "off";
      changes.push(
        `Skill Workshop proposals were removed; set skills.workshop.autonomous.mode to "off" (was "propose"). ${ENABLE_AUTO_HINT}`,
      );
    },
  }),
  defineLegacyConfigMigration({
    id: "skills.workshop.proposal-settings-retired",
    describe: "Remove retired Skill Workshop proposal settings.",
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
  }),
  defineLegacyConfigMigration({
    id: "skills.workshop.allowSymlinkTargetWrites-retired",
    describe: "Remove the retired Skill Workshop symlink write option.",
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
  }),
];
