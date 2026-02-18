import type { OpenClawConfig } from "../config/types.js";

/**
 * Legacy shape of deprecated fields that may still appear in old config files.
 * These fields are no longer part of OpenClawConfig; we check them at runtime
 * by narrowing the unknown incoming config object.
 */
interface DeprecatedConfigShape {
  /** @deprecated use tools.media.audio.models */
  audioModels?: unknown;
  /** @deprecated use whatsapp.messagePrefix */
  messagePrefix?: unknown;
}

interface DeprecatedRootFields {
  /** @deprecated replaced by 'direct' routing mode */
  dmMode?: unknown;
  /** @deprecated use channels.slack.replyToModeByChatType.direct */
  slack?: {
    dmReplyMode?: unknown;
    [key: string]: unknown;
  };
}

interface DeprecatedMaintenanceShape {
  /** @deprecated use pruneAfter (e.g., '30d') */
  days?: unknown;
  [key: string]: unknown;
}

interface DeprecatedAudioShape {
  /** @deprecated use providerOptions.deepgram */
  deepgram?: unknown;
  [key: string]: unknown;
}

/**
 * Check for deprecated configuration fields.
 * Returns array of warning messages for deprecated fields found.
 */
export function checkDeprecatedConfigFields(cfg: OpenClawConfig): string[] {
  const warnings: string[] = [];

  // Check messages.audioModels
  const deprecatedMessages = cfg.messages as DeprecatedConfigShape | undefined;
  if (deprecatedMessages?.audioModels) {
    warnings.push("- messages.audioModels is deprecated. Use tools.media.audio.models instead.");
  }

  // Check messages.messagePrefix
  if (deprecatedMessages?.messagePrefix) {
    warnings.push(
      "- messages.messagePrefix is deprecated. Use whatsapp.messagePrefix instead (WhatsApp-only).",
    );
  }

  // Check top-level deprecated root fields (dmMode, slack.dmReplyMode)
  const deprecatedRoot = cfg as unknown as DeprecatedRootFields;
  if (deprecatedRoot.dmMode !== undefined) {
    warnings.push("- dmMode is deprecated. Use 'direct' instead.");
  }

  // Check sessions.maintenance.pruneDays
  const deprecatedMaintenance = cfg.session?.maintenance as
    | DeprecatedMaintenanceShape
    | undefined;
  if (deprecatedMaintenance && "days" in deprecatedMaintenance) {
    warnings.push(
      "- sessions.maintenance.pruneDays is deprecated. Use pruneAfter instead (e.g., '30d').",
    );
  }

  // Check tools.media.audio.deepgram
  const deprecatedAudio = cfg.tools?.media?.audio as DeprecatedAudioShape | undefined;
  if (deprecatedAudio?.deepgram) {
    warnings.push(
      "- tools.media.audio.deepgram is deprecated. Use providerOptions.deepgram instead.",
    );
  }

  // Check tools.media.deepgram (old position before audio nesting)
  const deprecatedMedia = cfg.tools?.media as DeprecatedAudioShape | undefined;
  if (deprecatedMedia?.deepgram) {
    warnings.push("- tools.media.deepgram is deprecated. Use providerOptions.deepgram instead.");
  }

  // Check slack.dmReplyMode at root level (legacy pre-channels config)
  if (deprecatedRoot.slack?.dmReplyMode) {
    warnings.push(
      "- slack.dmReplyMode is deprecated. Use channels.slack.replyToModeByChatType.direct instead.",
    );
  }

  return warnings;
}
