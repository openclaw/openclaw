import {
  loadBundledPluginApiSync,
  loadBundledPluginContractApiSync,
} from "../../../src/test-utils/bundled-plugin-public-surface.js";

type TelegramContractSurface = typeof import("@openclaw/telegram/contract-api.js");
type WhatsAppApiSurface = Pick<
  typeof import("@openclaw/whatsapp/api.js"),
  "isWhatsAppGroupJid" | "normalizeWhatsAppTarget" | "whatsappCommandPolicy"
>;

const { buildTelegramModelsProviderChannelData } =
  loadBundledPluginContractApiSync<TelegramContractSurface>("telegram");
const { isWhatsAppGroupJid, normalizeWhatsAppTarget, whatsappCommandPolicy } =
  loadBundledPluginApiSync<WhatsAppApiSurface>("whatsapp");

export {
  buildTelegramModelsProviderChannelData,
  isWhatsAppGroupJid,
  normalizeWhatsAppTarget,
  whatsappCommandPolicy,
};
