import {
  isNumericTelegramUserId,
  normalizeTelegramAllowFromEntry,
} from "../../extensions/telegram/api.js";
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
