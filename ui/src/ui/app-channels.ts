import {
  loadChannels,
  logoutWhatsApp,
  startWhatsAppLogin,
  waitWhatsAppLogin,
} from "./controllers/channels";
import { loadConfig, saveConfig } from "./controllers/config";
import type { ClawdbotApp } from "./app";

export async function handleWhatsAppStart(host: ClawdbotApp, force: boolean) {
  await startWhatsAppLogin(host, force);
  await loadChannels(host, true);
}

export async function handleWhatsAppWait(host: ClawdbotApp) {
  await waitWhatsAppLogin(host);
  await loadChannels(host, true);
}

export async function handleWhatsAppLogout(host: ClawdbotApp) {
  await logoutWhatsApp(host);
  await loadChannels(host, true);
}

export async function handleChannelConfigSave(host: ClawdbotApp) {
  await saveConfig(host);
  await loadConfig(host);
  await loadChannels(host, true);
}

export async function handleChannelConfigReload(host: ClawdbotApp) {
  await loadConfig(host);
  await loadChannels(host, true);
}
