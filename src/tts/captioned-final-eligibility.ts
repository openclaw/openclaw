import { resolveChannelTtsVoiceDelivery } from "../channels/plugins/tts-capabilities.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { TtsAutoMode } from "../config/types.tts.js";
import { resolveConfiguredTtsMode } from "./tts-config.js";
import type { PreparedTtsPreferences } from "./tts-preferences.js";
import { resolveTtsSettingsSnapshotAsync } from "./tts-settings.js";

export async function shouldDeferFinalTtsText(params: {
  cfg: OpenClawConfig;
  preparedTtsPreferences?: PreparedTtsPreferences;
  ttsAuto?: TtsAutoMode;
  agentId?: string;
  channelId?: string;
  accountId?: string;
  inboundAudio: boolean;
}): Promise<boolean> {
  if (!resolveChannelTtsVoiceDelivery(params.channelId)?.captionedFinalText) {
    return false;
  }
  if (
    resolveConfiguredTtsMode(params.cfg, {
      agentId: params.agentId,
      channelId: params.channelId,
      accountId: params.accountId,
    }) !== "final"
  ) {
    return false;
  }
  const settings = await resolveTtsSettingsSnapshotAsync({
    cfg: params.cfg,
    preparedTtsPreferences: params.preparedTtsPreferences,
    sessionAuto: params.ttsAuto,
    agentId: params.agentId,
    channelId: params.channelId,
    accountId: params.accountId,
  });
  return (
    settings.autoMode !== "off" &&
    settings.autoMode !== "tagged" &&
    (settings.autoMode !== "inbound" || params.inboundAudio)
  );
}
