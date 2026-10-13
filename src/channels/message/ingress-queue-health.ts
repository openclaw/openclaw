/** Redacted health diagnostics for durable channel ingress queues. */
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { resolveChannelIngressStateEnv } from "./ingress-queue-client.js";
import type {
  ChannelIngressFailedHealth,
  ChannelIngressPressureHealth,
} from "./ingress-queue-read-contract.js";

export async function countFailedChannelIngressQueueEntries(
  stateDir?: string,
): Promise<ChannelIngressFailedHealth[]> {
  const reply = await executeExistingOpenClawStateRead(
    { env: resolveChannelIngressStateEnv(stateDir) },
    { type: "channelIngress.failedHealth" },
  );
  if (!reply) {
    return [];
  }
  if (!reply.ok || reply.type !== "channelIngress.failedHealth") {
    throw new Error("Channel ingress failed health reader returned an unexpected result");
  }
  return reply.result;
}

export async function countChannelIngressQueuePressure(
  stateDir?: string,
): Promise<ChannelIngressPressureHealth[]> {
  const reply = await executeExistingOpenClawStateRead(
    { env: resolveChannelIngressStateEnv(stateDir) },
    { type: "channelIngress.pressureHealth", input: { now: Date.now() } },
  );
  if (!reply) {
    return [];
  }
  if (!reply.ok || reply.type !== "channelIngress.pressureHealth") {
    throw new Error("Channel ingress pressure reader returned an unexpected result");
  }
  return reply.result;
}
