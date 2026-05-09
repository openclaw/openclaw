import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("outbound/attention-broker");

// TODO: make configurable via environment or config
const BROKER_URL = "http://127.0.0.1:8011";

export type BrokerPayload = {
  agent_id: string;
  business: string;
  category: string;
  surface_tier: string;
  message_summary: string;
};

export type BrokerCheckResult = {
  resolved_channel: string | null;
  error?: string;
};

export type BrokerRecordActionPayload = {
  agent_id: string;
  business: string;
  category: string;
  surface_tier: string;
  resolved_channel: string | null;
  delivery_success: boolean;
  message_summary: string;
};

/**
 * Check with the attention broker to resolve the target channel for an outbound message.
 * Non-blocking: if the broker is unreachable, returns null resolved_channel.
 */
export async function checkBroker(payload: BrokerPayload): Promise<BrokerCheckResult> {
  try {
    const response = await fetch(`${BROKER_URL}/broker/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2000), // 2s timeout to avoid blocking outbound
    });
    if (!response.ok) {
      const errorText = await response.text();
      log.error(`Broker check failed with status ${response.status}: ${errorText}`);
      return { resolved_channel: null, error: `Broker check failed: ${response.status}` };
    }
    const result: BrokerCheckResult = await response.json();
    if (result.resolved_channel) {
      log.info(
        `Broker check for agent ${payload.agent_id} resolved to channel: ${result.resolved_channel}`,
      );
    }
    return result;
  } catch (err) {
    log.error(`Failed to connect to attention broker for check: ${err}`);
    return { resolved_channel: null, error: `Broker unreachable: ${String(err)}` };
  }
}

/**
 * Record the action (post-delivery) with the attention broker for surface-tier learning.
 * Non-blocking: if the broker is unreachable, logs the error but doesn't fail the delivery.
 */
export async function recordAction(payload: BrokerRecordActionPayload): Promise<void> {
  try {
    const response = await fetch(`${BROKER_URL}/broker/record-action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2000), // 2s timeout
    });
    if (!response.ok) {
      const errorText = await response.text();
      log.error(`Broker record-action failed with status ${response.status}: ${errorText}`);
      return;
    }
    log.debug(`Broker record-action recorded for agent ${payload.agent_id}`);
  } catch (err) {
    log.error(`Failed to record action with attention broker: ${err}`);
    // Non-blocking: continue delivery even if recording fails
  }
}
