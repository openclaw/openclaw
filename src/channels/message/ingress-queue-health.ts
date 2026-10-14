/** Redacted health diagnostics for durable channel ingress queues. */
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { resolveChannelIngressStateEnv } from "./ingress-queue-client.js";
import { channelIngressHealthCache } from "./ingress-queue-health-cache.js";
import type {
  ChannelIngressFailedHealth,
  ChannelIngressPressureHealth,
} from "./ingress-queue-read-contract.js";

export async function countFailedChannelIngressQueueEntries(
  stateDir?: string,
  context?: OpenClawStateWorkerContext,
): Promise<ChannelIngressFailedHealth[]> {
  const cache = context ? channelIngressHealthCache(context) : undefined;
  if (cache?.failed) {
    return cache.failed;
  }
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
  if (cache) {
    cache.failed = reply.result;
  }
  return reply.result;
}

export async function countChannelIngressQueuePressure(
  stateDir?: string,
  context?: OpenClawStateWorkerContext,
): Promise<ChannelIngressPressureHealth[]> {
  const cache = context ? channelIngressHealthCache(context) : undefined;
  const now = Date.now();
  if (
    cache?.pressure &&
    now >= cache.pressure.readAtMs &&
    now < (cache.pressure.nextClaimExpiryAtMs ?? Infinity)
  ) {
    return cache.pressure.pressure;
  }
  const reply = await executeExistingOpenClawStateRead(
    { env: resolveChannelIngressStateEnv(stateDir) },
    { type: "channelIngress.pressureHealth", input: { now } },
  );
  if (!reply) {
    return [];
  }
  if (!reply.ok || reply.type !== "channelIngress.pressureHealth") {
    throw new Error("Channel ingress pressure reader returned an unexpected result");
  }
  if (cache) {
    cache.pressure = { ...reply.result, readAtMs: now };
  }
  return reply.result.pressure;
}
