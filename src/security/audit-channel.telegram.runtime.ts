import {
  isNumericTelegramUserId,
  normalizeTelegramAllowFromEntry,
} from "../../extensions/telegram/allow-from.js";

export const auditChannelTelegramRuntime = {
  isNumericTelegramUserId,
  normalizeTelegramAllowFromEntry,
};
