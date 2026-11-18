import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";

export function createRecordedAccountSnapshots() {
  const common = { enabled: true, configured: true };
  const recoveredFacts: ChannelAccountSnapshot = {
    ...common,
    accountId: "recovered",
    running: true,
    lifecycle: "starting",
    tokenSource: "config",
    tokenStatus: "available",
    stateReason: "admitted before configuration changed",
    lastStartAt: 1200,
    lastError: null,
  };
  const recovered: ChannelAccountSnapshot = {
    ...recoveredFacts,
    baseUrl: "https://runtime-user:runtime-password@chat.example.test/?token=runtime-token",
    channelSecret: "private-channel-secret",
    channelAccessToken: "private-channel-token",
    webhookUrl: "https://private-webhook.example.test/secret",
    publicKey: "private-provider-key",
    probe: { credential: "private-probe" },
    audit: { credential: "private-audit" },
    application: { credential: "private-application" },
    bot: { credential: "private-bot" },
    profile: { credential: "private-profile" },
  };
  const retrying: ChannelAccountSnapshot = {
    ...common,
    accountId: "retrying",
    running: false,
    connected: false,
    lifecycle: "recovering",
    restartPending: true,
    reconnectAttempts: 3,
    terminalDisconnect: false,
    lastStopAt: 2300,
    lastDisconnect: { at: 2200, error: "transport closed" },
    lastError: "waiting for restart",
  };
  return { recovered, recoveredFacts, retrying };
}
