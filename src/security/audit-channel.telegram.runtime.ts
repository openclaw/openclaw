import {
  isNumericTelegramUserId,
  normalizeTelegramAllowFromEntry,
} from "../plugin-sdk/telegram-runtime.js";

export const auditChannelTelegramRuntime = {
  isNumericTelegramUserId,
  normalizeTelegramAllowFromEntry,
};
