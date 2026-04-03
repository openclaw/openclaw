import type { ReplyPayload } from "../../auto-reply/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  deliverOutboundPayloads,
  type OutboundDeliveryResult,
} from "../../infra/outbound/deliver.js";
import type { OutboundIdentity } from "../../infra/outbound/identity.js";
import type { OutboundSendDeps } from "../../infra/outbound/send-deps.js";
import { resolvePluginActorDmLane } from "../lane-refs.js";
import type { PluginActorRef, PluginLaneRef } from "../types.js";

function toPayloadList(payload: ReplyPayload | ReplyPayload[]): ReplyPayload[] {
  return Array.isArray(payload) ? payload : [payload];
}

export function resolveActorDmLane(actor?: PluginActorRef | null): PluginLaneRef | undefined {
  return resolvePluginActorDmLane(actor);
}

export async function sendPayloadToLane(params: {
  cfg: OpenClawConfig;
  lane: PluginLaneRef;
  payload: ReplyPayload | ReplyPayload[];
  identity?: OutboundIdentity;
  deps?: OutboundSendDeps;
  silent?: boolean;
  gatewayClientScopes?: readonly string[];
}): Promise<OutboundDeliveryResult[]> {
  return deliverOutboundPayloads({
    cfg: params.cfg,
    channel: params.lane.channel,
    to: params.lane.to,
    accountId: params.lane.accountId,
    threadId: params.lane.threadId,
    payloads: toPayloadList(params.payload),
    identity: params.identity,
    deps: params.deps,
    silent: params.silent,
    gatewayClientScopes: params.gatewayClientScopes,
  });
}

export async function sendPayloadToActorDm(params: {
  cfg: OpenClawConfig;
  actor: PluginActorRef;
  payload: ReplyPayload | ReplyPayload[];
  identity?: OutboundIdentity;
  deps?: OutboundSendDeps;
  silent?: boolean;
  gatewayClientScopes?: readonly string[];
}): Promise<OutboundDeliveryResult[]> {
  const lane = resolvePluginActorDmLane(params.actor);
  if (!lane) {
    throw new Error("This actor does not expose a DM lane.");
  }
  return sendPayloadToLane({
    cfg: params.cfg,
    lane,
    payload: params.payload,
    identity: params.identity,
    deps: params.deps,
    silent: params.silent,
    gatewayClientScopes: params.gatewayClientScopes,
  });
}
