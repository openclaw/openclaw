/**
 * Per-node tool restriction (`gateway.tools.byNode`) resolution.
 *
 * The policy is keyed off the **authenticated** node hosting a turn. When a turn
 * is dispatched from a node-originated `agent.request` (the node is authenticated
 * to the gateway by a cryptographic device pairing), the gateway threads that
 * node's id through the run as `hostingNodeId`, and the in-process agent tool
 * builder resolves the node's policy from it here.
 *
 * The hosting node id is RUN-SCOPED — carried with the run, not looked up from a
 * session-global map — so a node's policy can never bleed onto a later or
 * concurrent turn for the same session. Because the id comes from the node's
 * authenticated connection, a client cannot forge it, so this is a sound basis
 * for *enforcing* (not merely advising) a reduced toolset. Restriction-only: the
 * policy can narrow the toolset, never escalate.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";

/**
 * Resolve the `gateway.tools.byNode` allow/deny for an explicit, run-scoped
 * authenticated `hostingNodeId`. Returns no restriction when there is no hosting
 * node (e.g. a non-node-originated turn). An absent `allow` means "no allow
 * restriction"; an explicitly-present (even empty) `allow` is fail-closed.
 */
export function resolveNodeScopedToolPolicy(
  hostingNodeId: string | undefined,
  cfg: OpenClawConfig | undefined,
): { nodeAllow?: string[]; nodeDeny: string[] } {
  const nodeId = hostingNodeId?.trim();
  if (!nodeId) {
    return { nodeDeny: [] };
  }
  const nodePolicy = cfg?.gateway?.tools?.byNode?.[nodeId];
  const nodeAllow = nodePolicy?.allow ? Array.from(nodePolicy.allow) : undefined;
  const nodeDeny =
    nodePolicy?.deny && nodePolicy.deny.length > 0 ? Array.from(nodePolicy.deny) : [];
  return { nodeAllow, nodeDeny };
}
