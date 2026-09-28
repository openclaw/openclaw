import { loadSettings, normalizeChatInputRecoveryDismissals, saveSettings } from "./settings.ts";

/** Merge presentation-only dismissal into its captured Gateway preference owner. */
export function dismissChatInputRecoveryKey(gatewayUrl: string, key: string): boolean {
  const settings = loadSettings(gatewayUrl);
  const keys = normalizeChatInputRecoveryDismissals([
    ...(settings.chatInputRecoveryDismissed ?? []),
    key,
  ]);
  if (!keys?.includes(key)) {
    return false;
  }
  return saveSettings({ ...settings, chatInputRecoveryDismissed: keys });
}
