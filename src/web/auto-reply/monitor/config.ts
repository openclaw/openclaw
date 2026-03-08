/**
 * Build a WhatsApp channel config with account-specific overrides merged in.
 *
 * Both `monitorWebChannel` (one-time at startup) and the per-message handler
 * need to merge account overrides into a loaded config.  This helper keeps
 * the merging logic in a single place so the two call-sites stay in sync.
 */

import type { loadConfig } from "../../../config/config.js";
import { resolveWhatsAppAccount } from "../../accounts.js";

export function buildWhatsAppAccountConfig(params: {
  cfg: ReturnType<typeof loadConfig>;
  accountId?: string | null;
}): ReturnType<typeof loadConfig> {
  const account = resolveWhatsAppAccount(params);
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      whatsapp: {
        ...params.cfg.channels?.whatsapp,
        ackReaction: account.ackReaction,
        messagePrefix: account.messagePrefix,
        allowFrom: account.allowFrom,
        groupAllowFrom: account.groupAllowFrom,
        groupPolicy: account.groupPolicy,
        textChunkLimit: account.textChunkLimit,
        chunkMode: account.chunkMode,
        mediaMaxMb: account.mediaMaxMb,
        blockStreaming: account.blockStreaming,
        groups: account.groups,
      },
    },
  } satisfies ReturnType<typeof loadConfig>;
}
