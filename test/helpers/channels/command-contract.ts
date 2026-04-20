import {
  loadBundledPluginApiSync,
  loadBundledPluginContractApiSync,
} from "../../../src/test-utils/bundled-plugin-public-surface.js";
import { createLazyObjectSurface } from "./lazy-object-surface.js";

type TelegramContractSurface = {
  buildTelegramModelsProviderChannelData: (...args: unknown[]) => unknown;
};
type WhatsAppApiSurface = {
  isWhatsAppGroupJid: (...args: unknown[]) => boolean;
  normalizeWhatsAppTarget: (...args: unknown[]) => string | null;
  whatsappCommandPolicy: Record<string, unknown>;
};

let telegramContractSurface: TelegramContractSurface | undefined;
let whatsappApiSurface: WhatsAppApiSurface | undefined;

function getTelegramContractSurface(): TelegramContractSurface {
  telegramContractSurface ??= loadBundledPluginContractApiSync<TelegramContractSurface>("telegram");
  return telegramContractSurface;
}

function getWhatsAppApiSurface(): WhatsAppApiSurface {
  whatsappApiSurface ??= loadBundledPluginApiSync<WhatsAppApiSurface>("whatsapp");
  return whatsappApiSurface;
}

export const buildTelegramModelsProviderChannelData = (
  ...args: Parameters<TelegramContractSurface["buildTelegramModelsProviderChannelData"]>
) => getTelegramContractSurface().buildTelegramModelsProviderChannelData(...args);

export const isWhatsAppGroupJid = (...args: Parameters<WhatsAppApiSurface["isWhatsAppGroupJid"]>) =>
  getWhatsAppApiSurface().isWhatsAppGroupJid(...args);

export const normalizeWhatsAppTarget = (
  ...args: Parameters<WhatsAppApiSurface["normalizeWhatsAppTarget"]>
) => getWhatsAppApiSurface().normalizeWhatsAppTarget(...args);

export const whatsappCommandPolicy = createLazyObjectSurface(
  () => getWhatsAppApiSurface().whatsappCommandPolicy,
);
