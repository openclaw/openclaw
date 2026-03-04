/**
 * Gateway Peer Relay — cross-gateway session routing.
 *
 * When multiple openclaw gateways run on the same host (common in multi-bot setups),
 * sessions_send can only reach sessions managed by the local gateway. This module
 * adds a peer relay layer: when a session isn't found locally, the gateway queries
 * configured peer gateways and relays the message to the one that owns the session.
 *
 * Design goals:
 * - Zero config for single-gateway setups (no overhead when peers aren't configured).
 * - Fail-open: if peer lookup fails, return a clear error — don't block the caller.
 * - Minimal surface: one WebSocket round-trip per relay attempt.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../config/config.js";
import { resolveGatewayPort } from "../config/config.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { GatewayClient } from "./client.js";
import { PROTOCOL_VERSION } from "./protocol/index.js";

/** Resolved peer entry with runtime metadata. */
export type ResolvedPeer = {
  url: string;
  token?: string;
  name: string;
  agentIds?: string[];
};

/** Result of resolving a session across peers. */
export type PeerResolveResult =
  | { ok: true; peer: ResolvedPeer; key: string }
  | { ok: false; error: string };

/** Result of relaying a message to a peer gateway. */
export type PeerRelayResult =
  | { ok: true; peer: ResolvedPeer; runId: string; reply?: string }
  | { ok: false; error: string };

const DEFAULT_PEER_TIMEOUT_MS = 15_000;
const RESOLVE_TIMEOUT_MS = 8_000;

/**
 * Resolve peer configurations from the gateway config.
 * Returns an empty array when no peers are configured (zero overhead path).
 */
export function resolvePeers(cfg: OpenClawConfig): ResolvedPeer[] {
  const peersConfig = cfg.gateway?.peers;
  if (!Array.isArray(peersConfig) || peersConfig.length === 0) {
    return [];
  }

  const localPort = resolveGatewayPort(cfg);
  const peers: ResolvedPeer[] = [];

  for (let i = 0; i < peersConfig.length; i++) {
    const entry = peersConfig[i];
    if (!entry || typeof entry.url !== "string" || entry.url.trim().length === 0) {
      continue;
    }

    const url = entry.url.trim();

    // Skip self-references: don't relay to ourselves.
    if (isSelfUrl(url, localPort)) {
      continue;
    }

    peers.push({
      url,
      token: typeof entry.token === "string" ? entry.token.trim() : undefined,
      name: typeof entry.name === "string" ? entry.name.trim() : `peer-${i}`,
      agentIds: Array.isArray(entry.agentIds) ? entry.agentIds.filter(Boolean) : undefined,
    });
  }

  return peers;
}

/**
 * Check if a URL points to the local gateway (self-reference detection).
 */
function isSelfUrl(url: string, localPort: number): boolean {
  try {
    const parsed = new URL(url);
    const port = parsed.port
      ? Number.parseInt(parsed.port, 10)
      : parsed.protocol === "wss:"
        ? 443
        : 80;
    const host = parsed.hostname;
    const isLocalhost = host === "127.0.0.1" || host === "localhost" || host === "::1";
    return isLocalhost && port === localPort;
  } catch {
    return false;
  }
}

/**
 * Attempt to resolve a session key on a single peer gateway.
 */
async function resolveOnPeer(
  peer: ResolvedPeer,
  resolveParams: Record<string, unknown>,
  timeoutMs: number = RESOLVE_TIMEOUT_MS,
): Promise<{ ok: true; key: string } | { ok: false; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const stop = (result: { ok: true; key: string } | { ok: false; error?: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const client = new GatewayClient({
      url: peer.url,
      token: peer.token,
      instanceId: randomUUID(),
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      clientDisplayName: "peer-relay",
      clientVersion: "1.0.0",
      mode: GATEWAY_CLIENT_MODES.CLI,
      role: "operator",
      scopes: ["sessions"],
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      onHelloOk: async () => {
        try {
          const result = await client.request<{ key: string }>("sessions.resolve", resolveParams, {
            expectFinal: true,
          });
          const key = typeof result?.key === "string" ? result.key.trim() : "";
          if (key) {
            stop({ ok: true, key });
          } else {
            stop({ ok: false });
          }
        } catch (err) {
          stop({ ok: false, error: err instanceof Error ? err.message : String(err) });
        } finally {
          client.stop();
        }
      },
      onClose: (_code, reason) => {
        stop({ ok: false, error: reason || "connection closed" });
      },
    });

    const timer = setTimeout(() => {
      client.stop();
      stop({ ok: false, error: "timeout" });
    }, timeoutMs);

    client.start();
  });
}

/**
 * Try to resolve a session across all configured peer gateways.
 * Queries peers sequentially (with agentId-based filtering for efficiency).
 *
 * @param cfg       The openclaw config.
 * @param params    The resolve parameters (label, agentId, key, etc.).
 * @returns         The first peer that owns the session, or an error.
 */
export async function resolveSessionOnPeers(
  cfg: OpenClawConfig,
  params: Record<string, unknown>,
): Promise<PeerResolveResult> {
  const peers = resolvePeers(cfg);
  if (peers.length === 0) {
    return { ok: false, error: "no peers configured" };
  }

  const targetAgentId = typeof params.agentId === "string" ? params.agentId.trim() : undefined;

  for (const peer of peers) {
    // Skip peers that don't serve the target agent (when agentIds filter is set).
    if (targetAgentId && peer.agentIds && peer.agentIds.length > 0) {
      if (!peer.agentIds.includes(targetAgentId)) {
        continue;
      }
    }

    const result = await resolveOnPeer(peer, params);
    if (result.ok) {
      return { ok: true, peer, key: result.key };
    }
  }

  return { ok: false, error: "session not found on any peer gateway" };
}

/**
 * Relay an agent message to a peer gateway.
 * Sends the message and optionally waits for a response.
 *
 * @param peer        The target peer gateway.
 * @param sessionKey  The resolved session key on the peer.
 * @param message     The message content to send.
 * @param timeoutMs   How long to wait for the agent response (0 = fire-and-forget).
 * @returns           The relay result with optional reply text.
 */
export async function relayMessageToPeer(
  peer: ResolvedPeer,
  sessionKey: string,
  message: string,
  timeoutMs: number = DEFAULT_PEER_TIMEOUT_MS,
): Promise<PeerRelayResult> {
  return new Promise((resolve) => {
    let settled = false;
    const stop = (result: PeerRelayResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const idempotencyKey = randomUUID();

    const client = new GatewayClient({
      url: peer.url,
      token: peer.token,
      instanceId: randomUUID(),
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      clientDisplayName: "peer-relay",
      clientVersion: "1.0.0",
      mode: GATEWAY_CLIENT_MODES.CLI,
      role: "operator",
      scopes: ["agent"],
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      onHelloOk: async () => {
        try {
          // Send the message to the peer's agent endpoint.
          const agentResult = await client.request<{ runId: string }>(
            "agent",
            {
              message,
              sessionKey,
              idempotencyKey,
              deliver: false,
              channel: "internal",
              lane: "nested",
              inputProvenance: {
                kind: "peer_relay",
                sourceTool: "sessions_send",
              },
            },
            { expectFinal: true },
          );

          const runId = typeof agentResult?.runId === "string" ? agentResult.runId : idempotencyKey;

          if (timeoutMs === 0) {
            stop({ ok: true, peer, runId });
            client.stop();
            return;
          }

          // Wait for the agent response.
          try {
            const waitResult = await client.request<{ status?: string; error?: string }>(
              "agent.wait",
              { runId, timeoutMs },
              { expectFinal: true },
            );

            if (waitResult?.status === "timeout" || waitResult?.status === "error") {
              stop({ ok: true, peer, runId, reply: undefined });
              client.stop();
              return;
            }
          } catch {
            // Wait failed; we still sent the message successfully.
            stop({ ok: true, peer, runId, reply: undefined });
            client.stop();
            return;
          }

          // Fetch the reply from history.
          try {
            const history = await client.request<{ messages: Array<unknown> }>(
              "chat.history",
              { sessionKey, limit: 10 },
              { expectFinal: true },
            );

            const messages = Array.isArray(history?.messages) ? history.messages : [];
            const lastAssistant = messages
              .toReversed()
              .find(
                (m: unknown) =>
                  typeof m === "object" &&
                  m !== null &&
                  (m as Record<string, unknown>).role === "assistant",
              ) as Record<string, unknown> | undefined;

            const reply = extractTextContent(lastAssistant);
            stop({ ok: true, peer, runId, reply });
          } catch {
            stop({ ok: true, peer, runId, reply: undefined });
          }

          client.stop();
        } catch (err) {
          client.stop();
          stop({
            ok: false,
            error: `relay to ${peer.name} failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      },
      onClose: (_code, reason) => {
        stop({ ok: false, error: `connection to ${peer.name} closed: ${reason || "unknown"}` });
      },
    });

    const timer = setTimeout(() => {
      client.stop();
      stop({ ok: false, error: `relay to ${peer.name} timed out after ${timeoutMs}ms` });
    }, timeoutMs + 5_000); // Extra buffer for connection setup.

    client.start();
  });
}

/**
 * Extract text content from an assistant message object.
 */
function extractTextContent(message: Record<string, unknown> | undefined): string | undefined {
  if (!message) {
    return undefined;
  }

  const content = message.content;
  if (typeof content === "string") {
    return content.trim() || undefined;
  }
  if (Array.isArray(content)) {
    const textParts = content
      .filter(
        (part: unknown) =>
          typeof part === "object" &&
          part !== null &&
          (part as Record<string, unknown>).type === "text",
      )
      .map((part: unknown) => (part as Record<string, string>).text || "")
      .join("\n");
    return textParts.trim() || undefined;
  }
  return undefined;
}
