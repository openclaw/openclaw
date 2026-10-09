import { getRecord, type LegacyConfigMigrationSpec } from "../../../config/legacy.shared.js";
import { deleteRetiredPath } from "./legacy-config-record-shared.js";

const ENABLE_AUTO_HINT =
  "Run `openclaw config set skills.workshop.autonomous.mode auto` to let agents save and update skills automatically (every change is announced and undoable).";

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_SKILLS: LegacyConfigMigrationSpec[] = [
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
  },
  {
    id: "skills.workshop.autonomous.mode-propose->off",
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
  },
  {
    id: "skills.workshop.proposal-settings-retired",
    legacyRules: ["approvalPolicy", "maxPending"].map((key) => ({
      path: ["skills", "workshop", key],
      message: `skills.workshop.${key} was removed with Skill Workshop proposals. Run "openclaw doctor --fix".`,
    })),
    apply: (raw, changes) => {
      const workshop = getRecord(getRecord(raw.skills)?.workshop);
      // Approval-first operators never let agents write skills unreviewed; without this the
      // mode (explicit or the new auto default) would start writing directly.
      if (workshop?.approvalPolicy === "pending") {
        const autonomous = getRecord(workshop.autonomous) ?? {};
        if (autonomous.mode !== "off") {
          autonomous.mode = "off";
          workshop.autonomous = autonomous;
          changes.push(
            `Set skills.workshop.autonomous.mode to "off" because approvalPolicy "pending" required approval before skill writes, and approvals were removed. ${ENABLE_AUTO_HINT}`,
          );
        }
      }
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
