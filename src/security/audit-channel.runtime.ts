import { readChannelAllowFromStore } from "../pairing/pairing-store.js";
import {
  isNumericTelegramUserId,
  normalizeTelegramAllowFromEntry,
} from "../plugin-sdk/telegram.js";
import {
  isDiscordMutableAllowEntry,
  isZalouserMutableGroupEntry,
} from "./mutable-allowlist-detectors.js";

export const auditChannelRuntime = {
  readChannelAllowFromStore,
  isDiscordMutableAllowEntry,
  isZalouserMutableGroupEntry,
  isNumericTelegramUserId,
  normalizeTelegramAllowFromEntry,
};
