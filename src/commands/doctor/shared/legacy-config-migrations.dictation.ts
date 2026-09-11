// Legacy dictation config migration from Talk's transcription slot.
import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
} from "../../../config/legacy.shared.js";

/** Move the retired talk.transcription block to the standalone dictation surface. */
export const LEGACY_CONFIG_MIGRATIONS_DICTATION: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "talk.transcription-to-dictation",
    describe: "Move talk.transcription to dictation",
    legacyRules: [
      {
        path: ["talk", "transcription"],
        message: "Use the top-level dictation config instead.",
      },
    ],
    apply: (raw, changes) => {
      const talk = getRecord(raw.talk);
      const legacy = talk ? getRecord(talk.transcription) : null;
      if (!talk || !legacy) {
        return;
      }

      const existing = getRecord(raw.dictation);
      if (existing) {
        // The canonical surface wins when both keys are present. Removing the
        // retired block keeps the resulting config schema-valid without
        // silently replacing an operator's newer settings.
        delete talk.transcription;
        changes.push(
          "Removed talk.transcription because the top-level dictation config is already set.",
        );
        return;
      }

      raw.dictation = structuredClone(legacy);
      delete talk.transcription;
      changes.push("Moved talk.transcription \u2192 dictation.");
    },
  }),
];
