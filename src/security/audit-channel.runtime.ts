import {
  isNumericTelegramUserId,
  normalizeTelegramAllowFromEntry,
} from "openclaw/plugin-sdk/telegram";
import { readChannelAllowFromStore } from "../pairing/pairing-store.js";
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
