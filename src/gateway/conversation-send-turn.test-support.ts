import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { MessageActionResult } from "../infra/outbound/message-action-contracts.js";
import { conversation } from "./conversation-delivery.test-support.js";

export function sentResult(messageId = "reef-outbound-1") {
  return {
    kind: "send",
    channel: "reef",
    action: "send",
    to: conversation.target,
    handledBy: "core",
    payload: {},
    sendResult: {
      channel: "reef",
      to: conversation.target,
      via: "direct",
      mediaUrl: null,
      result: { messageId },
      deliveryStatus: "sent",
    },
    dryRun: false,
  } satisfies Extract<MessageActionResult, { kind: "send" }>;
}

export const sentTurnResult = (messageId?: string) => ({
  ...sentResult(messageId),
  deliveredText: "hello molty",
});

export function reassignedConfig(config: OpenClawConfig): OpenClawConfig {
  return {
    ...config,
    agents: { entries: { main: {}, finance: {} } },
    bindings: [
      { type: "route", agentId: "finance", match: { channel: "reef", accountId: "default" } },
    ],
  };
}

export function captureOutcome<T>(operation: Promise<T>) {
  return operation.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

export async function releaseAndDrain(release: () => Promise<void>, operation: Promise<unknown>) {
  try {
    await release();
  } finally {
    await operation;
  }
}
