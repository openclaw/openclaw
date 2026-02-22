import type { TelegramTotpConfig } from "../config/types.telegram.js";
import { hasValidSession } from "./totp-store.js";

/**
 * Wraps all tools with a TOTP verification check.
 * When TOTP is enabled and the sender doesn't have a valid session,
 * tool execution throws an error prompting for authentication.
 *
 * This is a secondary defense layer — the primary gate is in
 * bot-message-context.ts which blocks unauthenticated messages entirely.
 */
export function wrapToolsWithTotpGate(
  tools: any[],
  params: {
    totpConfig: TelegramTotpConfig;
    senderId: string;
  },
): any[] {
  const { totpConfig, senderId } = params;

  if (!totpConfig.enabled) {
    return tools;
  }

  return tools.map((tool) => ({
    ...tool,
    execute: async (...args: any[]) => {
      const valid = await hasValidSession(senderId);
      if (!valid) {
        throw new Error(
          "TOTP authentication required. Please send your 6-digit TOTP code to authenticate before using this tool.",
        );
      }
      return tool.execute(...args);
    },
  }));
}
