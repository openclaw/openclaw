// Verifies Slack config TypeScript contracts match the SecretRef-capable schema.
import type { OpenClawConfig } from "../../src/config/types.js";

void ({
  channels: {
    slack: {
      mode: "relay",
      botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
      appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
      signingSecret: { source: "env", provider: "default", id: "SLACK_SIGNING_SECRET" },
      userToken: { source: "env", provider: "default", id: "SLACK_USER_TOKEN" },
      relay: {
        url: "wss://router.example.com/gateway/ws",
        authToken: { source: "env", provider: "default", id: "SLACK_RELAY_AUTH_TOKEN" },
        gatewayId: "team-gateway",
      },
      accounts: {
        ops: {
          mode: "http",
          botToken: { source: "env", provider: "default", id: "SLACK_OPS_BOT_TOKEN" },
          signingSecret: {
            source: "env",
            provider: "default",
            id: "SLACK_OPS_SIGNING_SECRET",
          },
        },
      },
    },
  },
} satisfies OpenClawConfig);

void ({
  channels: {
    slack: {
      streaming: {
        mode: "progress",
        nativeTransport: true,
        progress: { style: "compact", nativeTaskCards: true },
      },
    },
  },
} satisfies OpenClawConfig);
