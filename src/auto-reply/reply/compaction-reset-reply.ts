import {
  DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR,
  resolveCompactionReserveTokensFloor,
} from "../../agents/pi-settings.js";
import type { OpenClawConfig } from "../../config/config.js";

export function buildCompactionResetReplyText(params: {
  duringCompaction: boolean;
  config: OpenClawConfig;
}): string {
  const intro = params.duringCompaction
    ? "⚠️ Context limit exceeded during compaction. I've reset our conversation to start fresh - please try again."
    : "⚠️ Context limit exceeded. I've reset our conversation to start fresh - please try again.";
  const reserveTokensFloor = resolveCompactionReserveTokensFloor(params.config);

  if (reserveTokensFloor < DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR) {
    return (
      `${intro}\n\nTo prevent this, increase your compaction buffer by setting ` +
      "`agents.defaults.compaction.reserveTokensFloor` to " +
      `${DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR} or higher in your config.`
    );
  }

  return (
    `${intro}\n\nIf this keeps happening, a larger reserve floor alone may not help. ` +
    "Shorten the conversation, avoid very large pasted inputs, or set " +
    "`agents.defaults.compaction.model` to a higher-context model in your config."
  );
}
