/**
 * Peer relay integration for sessions_send.
 *
 * When sessions_send can't find a session on the local gateway,
 * this module tries configured peer gateways before returning an error.
 *
 * @module
 */

import crypto from "node:crypto";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveSessionOnPeers,
  relayMessageToPeer,
  resolvePeers,
  type PeerRelayResult,
} from "../../gateway/peer-relay.js";
import { jsonResult } from "./common.js";

/** Check whether peer relay is available (any peers configured). */
export function hasPeers(cfg: OpenClawConfig): boolean {
  return resolvePeers(cfg).length > 0;
}

/**
 * Attempt to resolve and relay a sessions_send call to a peer gateway.
 *
 * @param cfg          The openclaw config.
 * @param resolveParams  Parameters for session resolution (label, agentId, key, etc.).
 * @param message      The message to send.
 * @param timeoutMs    How long to wait for the peer agent response.
 * @returns            A tool result JSON if the peer handled the request,
 *                     or null if no peer could resolve the session.
 */
export async function tryPeerRelay(params: {
  cfg: OpenClawConfig;
  resolveParams: Record<string, unknown>;
  message: string;
  timeoutMs: number;
  displayKey?: string;
}): Promise<ReturnType<typeof jsonResult> | null> {
  const { cfg, resolveParams, message, timeoutMs, displayKey } = params;

  const resolved = await resolveSessionOnPeers(cfg, resolveParams);
  if (!resolved.ok) {
    return null; // No peer has this session; let the caller handle the error.
  }

  const relayResult: PeerRelayResult = await relayMessageToPeer(
    resolved.peer,
    resolved.key,
    message,
    timeoutMs,
  );

  if (!relayResult.ok) {
    return jsonResult({
      runId: crypto.randomUUID(),
      status: "error",
      error: relayResult.error,
      sessionKey: displayKey ?? resolved.key,
      relay: { peer: resolved.peer.name, attempted: true },
    });
  }

  return jsonResult({
    runId: relayResult.runId,
    status: "ok",
    reply: relayResult.reply,
    sessionKey: displayKey ?? resolved.key,
    relay: {
      peer: resolved.peer.name,
      relayed: true,
    },
    delivery: { status: "relayed", mode: "peer" },
  });
}
