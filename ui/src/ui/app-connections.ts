import {
  loadChannels,
  logoutWhatsApp,
  saveDiscordConfig,
  saveIMessageConfig,
  saveSlackConfig,
  saveSignalConfig,
  saveTelegramConfig,
  startWhatsAppLogin,
  waitWhatsAppLogin,
} from "./controllers/connections";
import { loadConfig } from "./controllers/config";
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

export async function handleTelegramSave(host: ClawdbotApp) {
  await saveTelegramConfig(host);
  await loadConfig(host);
  await loadChannels(host, true);
}

export async function handleDiscordSave(host: ClawdbotApp) {
  await saveDiscordConfig(host);
  await loadConfig(host);
  await loadChannels(host, true);
}

export async function handleSlackSave(host: ClawdbotApp) {
  await saveSlackConfig(host);
  await loadConfig(host);
  await loadChannels(host, true);
}

export async function handleSignalSave(host: ClawdbotApp) {
  await saveSignalConfig(host);
  await loadConfig(host);
  await loadChannels(host, true);
}

export async function handleIMessageSave(host: ClawdbotApp) {
  await saveIMessageConfig(host);
  await loadConfig(host);
  await loadChannels(host, true);
}
