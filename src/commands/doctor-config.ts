import type { OpenClawConfig } from "../config/types.js";

/**
 * Check for deprecated configuration fields.
 * Returns array of warning messages for deprecated fields found.
 */
export function checkDeprecatedConfigFields(cfg: OpenClawConfig): string[] {
  const warnings: string[] = [];

  // Check messages.audioModels
  if ((cfg.messages as any)?.audioModels) {
    warnings.push("- messages.audioModels is deprecated. Use tools.media.audio.models instead.");
  }

  // Check messages.messagePrefix
  if ((cfg.messages as any)?.messagePrefix) {
    warnings.push(
      "- messages.messagePrefix is deprecated. Use whatsapp.messagePrefix instead (WhatsApp-only).",
    );
  }

  // Check dmMode patterns
  if ((cfg as any).dmMode !== undefined) {
    warnings.push("- dmMode is deprecated. Use 'direct' instead.");
  }

  // Check sessions.maintenance.pruneDays
  if (cfg.session?.maintenance && "days" in (cfg.session.maintenance as any)) {
    warnings.push(
      "- sessions.maintenance.pruneDays is deprecated. Use pruneAfter instead (e.g., '30d').",
    );
  }

  // Check tools.media.audio.deepgram
  if ((cfg.tools?.media?.audio as any)?.deepgram) {
    warnings.push(
      "- tools.media.audio.deepgram is deprecated. Use providerOptions.deepgram instead.",
    );
  }

  // Check tools.media.deepgram
  if ((cfg.tools?.media as any)?.deepgram) {
    warnings.push("- tools.media.deepgram is deprecated. Use providerOptions.deepgram instead.");
  }

  // Check slack.dmReplyMode (actually in slack object, not channels.slack)
  if ((cfg as any).slack?.dmReplyMode) {
    warnings.push(
      "- slack.dmReplyMode is deprecated. Use channels.slack.replyToModeByChatType.direct instead.",
    );
  }

  return warnings;
}
