import type { ChannelsPairingListResult } from "../../api/types.ts";

export const pairingAccount = {
  channel: "whatsapp",
  channelLabel: "WhatsApp",
  accountId: "personal",
  accountLabel: "Personal",
  notifySupported: true,
};
export const pairingRequest = {
  ...pairingAccount,
  requestId: "opaque-request-id",
  senderId: "+15551234567",
  senderLabel: "Phone number",
  metadata: { name: "Alice" },
  createdAt: "2026-07-20T10:00:00.000Z",
  lastSeenAt: "2026-07-20T10:05:00.000Z",
  expiresAt: "2026-07-20T11:00:00.000Z",
};
export function pairingSnapshot(
  overrides: Partial<ChannelsPairingListResult> = {},
): ChannelsPairingListResult {
  return {
    accounts: [pairingAccount],
    requests: [pairingRequest],
    commandOwnerConfigured: false,
    limits: { pendingPerAccount: 3, ttlMs: 3_600_000 },
    ...overrides,
  };
}
