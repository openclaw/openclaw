/**
 * Gateway Forwarder — OpenClaw Integration Adapter
 *
 * Creates a conductor forwarder that uses the OpenClaw gateway's message
 * system to send authorization requests to the operator via messaging channels.
 */

import type { ConductorAuthConfig, ConductorForwarder } from "@aether/conductor";
import { createConductorForwarder } from "@aether/conductor";

/**
 * Create a forwarder that uses the gateway's message tool to send messages.
 * This is the production integration path.
 */
export function createGatewayForwarder(config: ConductorAuthConfig): ConductorForwarder {
  // Lazy import to avoid circular deps with the main app
  const sendViaGateway = async (params: {
    channel: string;
    to: string;
    message: string;
    accountId?: string;
    threadId?: string | number;
  }) => {
    const { runMessageAction } = await import("../infra/outbound/message-action-runner.js");
    const { loadConfig } = await import("../config/config.js");
    const cfg = loadConfig();
    await runMessageAction({
      cfg,
      action: "send",
      params: {
        action: "send",
        channel: params.channel,
        target: params.to,
        message: params.message,
        accountId: params.accountId,
        threadId: params.threadId,
      },
    });
  };

  return createConductorForwarder({
    config,
    sendMessage: sendViaGateway,
  });
}
