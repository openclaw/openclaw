// Legacy audio config migrations for retired transcription command settings.
import {
  defineLegacyConfigMigration,
  ensureRecord,
  getRecord,
  mapLegacyAudioTranscription,
  type LegacyConfigMigrationSpec,
} from "../../../config/legacy.shared.js";

function applyLegacyAudioTranscriptionModel(
  raw: Record<string, unknown>,
  source: unknown,
  changes: string[],
) {
  const mapped = mapLegacyAudioTranscription(source);
  if (!mapped) {
    changes.push("Removed audio.transcription (invalid or empty command).");
    return;
  }
  const tools = ensureRecord(raw, "tools");
  const media = ensureRecord(tools, "media");
  const mediaAudio = ensureRecord(media, "audio");
  const models = Array.isArray(media.models) ? (media.models as unknown[]) : [];
  const isAudioCompatible = (value: unknown) => {
    const model = getRecord(value);
    return (
      model !== null && (!Array.isArray(model.capabilities) || model.capabilities.includes("audio"))
    );
  };
  const hasAudioModel =
    (Array.isArray(mediaAudio.models) && mediaAudio.models.some(isAudioCompatible)) ||
    models.some(isAudioCompatible);
  if (!hasAudioModel) {
    mediaAudio.enabled = true;
    mediaAudio.preferredModel =
      typeof mapped.command === "string" ? `cli:${mapped.command}` : undefined;
    media.models = [...models, { ...mapped, capabilities: ["audio"] }];
    changes.push("Moved audio.transcription → tools.media.models.");
    return;
  }
  changes.push("Removed audio.transcription (tools.media.models already set).");
}

/** Legacy config migration specs for audio/tool media config. */
export const LEGACY_CONFIG_MIGRATIONS_AUDIO: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "audio.transcription-v2",
    describe: "Move audio.transcription to tools.media.models",
    legacyRules: [
      {
        path: ["audio", "transcription"],
        message: "Use a capability-tagged tools.media.models entry instead.",
      },
    ],
    apply: (raw, changes) => {
      const audio = getRecord(raw.audio);
      if (audio?.transcription === undefined) {
        return;
      }

      applyLegacyAudioTranscriptionModel(raw, audio.transcription, changes);
      delete audio.transcription;
      if (Object.keys(audio).length === 0) {
        delete raw.audio;
      }
    },
  }),
];
