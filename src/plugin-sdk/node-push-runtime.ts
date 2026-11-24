import { getRuntimeConfig } from "../config/io.js";
import { resolveNodePushTransport } from "../gateway/server-methods/node-push-transport.js";
import {
  clearApnsRegistrationIfCurrent,
  loadApnsRegistration,
  sendApnsIntentAlert,
  shouldClearStoredApnsRegistration,
} from "../infra/push-apns.js";

/**
 * Event-driven APNs alert delivery for paired iOS nodes. Location-intent
 * consumers call this at fire time so a notification reaches the phone
 * without waiting for a session turn or heartbeat to drain a system-event
 * queue.
 */
export type NodePushIntentAlert = {
  nodeId: string;
  title: string;
  body: string;
};

export type NodePushIntentAlertResult = {
  attempted: boolean;
  ok?: boolean;
  status?: number;
  reason?: string;
  error?: string;
};

export async function sendNodeIntentAlert(
  params: NodePushIntentAlert,
): Promise<NodePushIntentAlertResult> {
  const nodeId = params.nodeId.trim();
  if (!nodeId) {
    return { attempted: false, error: "nodeId is required" };
  }
  const title = params.title.trim() || "OpenClaw";
  const body = params.body.trim();
  if (!body) {
    return { attempted: false, error: "body is required" };
  }
  const registration = await loadApnsRegistration(nodeId);
  if (!registration) {
    return { attempted: false, error: `node ${nodeId} has no APNs registration` };
  }
  const transport = await resolveNodePushTransport(registration, getRuntimeConfig());
  if (!transport.ok) {
    return { attempted: false, error: transport.error };
  }
  const result = await sendApnsIntentAlert({
    ...transport.transport,
    nodeId,
    title,
    body,
  });
  if (shouldClearStoredApnsRegistration({ registration, result })) {
    // Clear only the exact registration we used; a reconnect may have
    // written a newer token while this push was in flight.
    await clearApnsRegistrationIfCurrent({ nodeId, registration });
  }
  return {
    attempted: true,
    ok: result.ok,
    status: result.status,
    reason: result.reason,
  };
}
