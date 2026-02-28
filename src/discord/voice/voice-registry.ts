import type { DiscordVoiceManager } from "./manager.js";

/**
 * Module-level registry of active Discord voice managers.
 * Allows the outbound send path to check if the bot is in a voice channel
 * and play TTS audio there instead of sending as a file attachment.
 */
const voiceRegistry = new Map<string, DiscordVoiceManager>();

const DEFAULT_ACCOUNT_KEY = "\0__default__";

function resolveAccountKey(accountId?: string): string {
  return accountId ?? DEFAULT_ACCOUNT_KEY;
}

export function registerVoiceManager(
  accountId: string | undefined,
  manager: DiscordVoiceManager,
): void {
  voiceRegistry.set(resolveAccountKey(accountId), manager);
}

export function unregisterVoiceManager(accountId?: string): void {
  voiceRegistry.delete(resolveAccountKey(accountId));
}

export function getVoiceManager(accountId?: string): DiscordVoiceManager | undefined {
  return voiceRegistry.get(resolveAccountKey(accountId));
}
