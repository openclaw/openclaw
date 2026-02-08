import type { DelegationMetrics } from "../agents/delegation-types.js";
import {
  listAgentIds,
  resolveAgentConfig,
  resolveAgentRole,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { getAllDelegations, getAgentDelegationMetrics } from "../agents/delegation-registry.js";
import { resolveAgentIdentity } from "../agents/identity.js";
import {
  listAllSubagentRuns,
  type SubagentRunRecord,
  type SubagentUsage,
} from "../agents/subagent-registry.js";
import { loadConfig } from "../config/config.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { getAllCollaborativeSessions } from "./server-methods/collaboration.js";

export type HierarchyEventType =
  | "spawn"
  | "start"
  | "end"
  | "error"
  | "usage-update"
  | "progress-update"
  | "full-refresh"
  | "delegation-created"
  | "delegation-reviewed"
  | "delegation-completed";

export type HierarchyEvent = {
  type: HierarchyEventType;
  timestamp: number;
  runId?: string;
  sessionKey?: string;
  parentSessionKey?: string;
  label?: string;
  task?: string;
  status?: "running" | "completed" | "error" | "pending" | "idle";
  outcome?: { status: string; error?: string };
};

export type HierarchyNode = {
  sessionKey: string;
  runId?: string;
  agentId?: string;
  agentRole?: string;
  label?: string;
  task?: string;
  status: "running" | "completed" | "error" | "pending" | "idle";
  startedAt?: number;
  endedAt?: number;
  children: HierarchyNode[];
  usage?: SubagentUsage;
  interactionCount?: number;
  delegations?: DelegationMetrics;
  progress?: {
    percent: number;
    status: string;
    detail?: string;
    lastUpdate: number;
  };
};

export type CollaborationEdge = {
  source: string; // agentId
  target: string; // agentId
  type:
    | "proposal"
    | "challenge"
    | "agreement"
    | "decision"
    | "clarification"
    | "delegation"
    | "request"
    | "approval"
    | "rejection";
  topic?: string;
};

export type HierarchySnapshot = {
  roots: HierarchyNode[];
  collaborationEdges: CollaborationEdge[];
  updatedAt: number;
};

type HierarchyBroadcast = (
  event: string,
  payload: unknown,
  opts?: { dropIfSlow?: boolean },
) => void;

let hierarchyBroadcast: HierarchyBroadcast | null = null;
let listenerStop: (() => void) | null = null;
let lastEventSeq = 0;

function extractAgentIdFromSessionKey(sessionKey: string): string | undefined {
  const parsed = parseAgentSessionKey(sessionKey);
  return parsed?.agentId ?? undefined;
}

/** Derive a short specialization label from agentId (e.g. "backend-architect" → "Backend"). */
function deriveShortSpec(agentId: string): string {
  // Strip common suffixes to get the domain word(s)
  const stripped = agentId
    .replace(/-architect$/, "")
    .replace(/-engineer$/, "")
    .replace(/-specialist$/, "")
    .replace(/-manager$/, "")
    .replace(/-designer$/, "")
    .replace(/-analyst$/, "")
    .replace(/-strategist$/, "")
    .replace(/-lead$/, "")
    .replace(/-engine$/, "");
  // Capitalize each word
  return stripped
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Build a display label for an agent: "Nickname|Spec" when identity has a name,
 * otherwise fall back to the config name or "Agent: {id}".
 */
function computeAgentDisplayLabel(cfg: ReturnType<typeof loadConfig>, agentId: string): string {
  const identity = resolveAgentIdentity(cfg, agentId);
  const nickname = identity?.name?.trim();
  if (nickname) {
    const spec = deriveShortSpec(agentId);
    return `${nickname} | ${spec}`;
  }
  const configName = resolveAgentConfig(cfg, agentId)?.name;
  return configName || `Agent: ${agentId}`;
}

/** Recursively collect all agentIds present in a hierarchy tree. */
function collectAgentIds(node: HierarchyNode, out: Set<string>) {
  if (node.agentId) {
    out.add(node.agentId);
  }
  for (const child of node.children) {
    collectAgentIds(child, out);
  }
}

function resolveKnownAgentId(cfg: ReturnType<typeof loadConfig>, raw: string): string | undefined {
  const value = raw.trim();
  if (!value) {
    return undefined;
  }

  // Direct id match
  if (resolveAgentConfig(cfg, value)) {
    return value;
  }

  // Match by human identity name (case-insensitive), e.g. "Rafael" -> "software-architect"
  const byName = (cfg.agents?.list ?? []).find(
    (agent) => (agent.identity?.name?.trim().toLowerCase() ?? "") === value.toLowerCase(),
  );
  if (byName?.id) {
    return byName.id;
  }

  return undefined;
}

function buildHierarchySnapshot(): HierarchySnapshot {
  const runs = listAllSubagentRuns();
  const cfg = loadConfig();
  const childrenByParent = new Map<string, HierarchyNode[]>();
  const nodeBySession = new Map<string, HierarchyNode>();
  const childSessionKeys = new Set<string>();

  // First pass: create nodes for all runs
  for (const run of runs) {
    const status = resolveStatus(run);
    const rawAgentId = extractAgentIdFromSessionKey(run.childSessionKey);
    const agentId = rawAgentId ? resolveKnownAgentId(cfg, rawAgentId) : undefined;

    // Ignore stale/invalid run records that reference unknown agent ids.
    if (rawAgentId && !agentId) {
      continue;
    }

    const agentRole = agentId ? resolveAgentRole(cfg, agentId) : undefined;
    const agentName = agentId ? resolveAgentConfig(cfg, agentId)?.name : undefined;
    // Compute delegation metrics and interaction count for this agent
    const delegMetrics = agentId ? getAgentDelegationMetrics(agentId) : undefined;
    let interactionCount = 0;
    if (run.usage) {
      interactionCount += run.usage.toolCalls;
      interactionCount += Math.floor((run.usage.inputTokens + run.usage.outputTokens) / 10_000);
    }
    if (delegMetrics) {
      interactionCount += delegMetrics.sent + delegMetrics.received;
    }

    const node: HierarchyNode = {
      sessionKey: run.childSessionKey,
      runId: run.runId,
      agentId,
      agentRole,
      label:
        (agentId ? computeAgentDisplayLabel(cfg, agentId) : undefined) || run.label || agentName,
      task: run.task,
      status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      children: [],
      usage: run.usage,
      interactionCount,
      delegations: delegMetrics,
      progress: run.progress,
    };

    nodeBySession.set(run.childSessionKey, node);
    childSessionKeys.add(run.childSessionKey);

    const parentKey = run.requesterSessionKey;
    if (!childrenByParent.has(parentKey)) {
      childrenByParent.set(parentKey, []);
    }
    childrenByParent.get(parentKey)!.push(node);
  }

  // Second pass: link children
  for (const [parentKey, children] of childrenByParent.entries()) {
    const parentNode = nodeBySession.get(parentKey);
    if (parentNode) {
      parentNode.children = children;
    }
  }

  // Find roots: parents that are not themselves children
  let roots: HierarchyNode[] = [];
  const rootSessionKeysUsed = new Set<string>();
  const parentKeys = new Set(childrenByParent.keys());
  for (const parentKey of parentKeys) {
    if (!childSessionKeys.has(parentKey)) {
      const children = childrenByParent.get(parentKey) ?? [];
      if (children.length > 0) {
        const rawRootAgentId = extractAgentIdFromSessionKey(parentKey);
        const rootAgentId = rawRootAgentId ? resolveKnownAgentId(cfg, rawRootAgentId) : undefined;
        const rootRole = rootAgentId ? resolveAgentRole(cfg, rootAgentId) : undefined;
        const rootName = rootAgentId ? resolveAgentConfig(cfg, rootAgentId)?.name : undefined;
        const rootNode: HierarchyNode = {
          sessionKey: parentKey,
          agentId: rootAgentId,
          agentRole: rootRole,
          label:
            (rootAgentId ? computeAgentDisplayLabel(cfg, rootAgentId) : undefined) ||
            rootName ||
            "Root Session",
          status: "running",
          children,
        };
        roots.push(rootNode);
        rootSessionKeysUsed.add(parentKey);
      }
    }
  }

  // Always include the default (orchestrator) agent as a root,
  // even when no subagents have been spawned yet.
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const defaultSessionKey = `agent:${defaultAgentId}:main`;
  if (!rootSessionKeysUsed.has(defaultSessionKey)) {
    const defaultRole = resolveAgentRole(cfg, defaultAgentId);
    roots.unshift({
      sessionKey: defaultSessionKey,
      agentId: defaultAgentId,
      agentRole: defaultRole,
      label: computeAgentDisplayLabel(cfg, defaultAgentId),
      status: "running",
      children: [],
    });
  }

  // Extract collaboration edges from active sessions
  const collaborationEdges: CollaborationEdge[] = [];
  try {
    const sessions = getAllCollaborativeSessions();
    for (const session of sessions) {
      const members = session.members
        .map((member) => resolveKnownAgentId(cfg, member))
        .filter((member): member is string => Boolean(member));

      // Build proposal edges from decisions: proposer → proposer (they debated)
      for (const decision of session.decisions) {
        const proposers = decision.proposals
          .map((p) => resolveKnownAgentId(cfg, p.from))
          .filter((p): p is string => Boolean(p));

        for (let i = 0; i < proposers.length; i++) {
          for (let j = i + 1; j < proposers.length; j++) {
            collaborationEdges.push({
              source: proposers[i],
              target: proposers[j],
              type: "proposal",
              topic: decision.topic,
            });
          }
        }
      }

      // Build challenge edges: challenger → proposal author (directional)
      for (const msg of session.messages) {
        if (msg.type !== "challenge" || !msg.referencesDecision) {
          // Non-challenge messages: edge from sender to all members (clarification, agreement, etc.)
          const source = resolveKnownAgentId(cfg, msg.from);
          if (!source) {
            continue;
          }
          for (const member of members) {
            if (member !== source) {
              collaborationEdges.push({
                source,
                target: member,
                type: msg.type,
                topic: session.topic,
              });
            }
          }
          continue;
        }

        // Challenge: find the proposal authors for the referenced decision
        const challenger = resolveKnownAgentId(cfg, msg.from);
        if (!challenger) {
          continue;
        }
        const decision = session.decisions.find((d) => d.id === msg.referencesDecision);
        if (decision) {
          for (const proposal of decision.proposals) {
            const proposer = resolveKnownAgentId(cfg, proposal.from);
            if (proposer && proposer !== challenger) {
              collaborationEdges.push({
                source: challenger,
                target: proposer,
                type: "challenge",
                topic: decision.topic,
              });
            }
          }
        }
      }
    }
  } catch {
    // Collaboration data is optional — don't break hierarchy if it fails
  }

  // Extract delegation edges from active delegations
  try {
    const allDelegations = getAllDelegations();
    for (const deleg of allDelegations) {
      let edgeType: CollaborationEdge["type"];
      if (deleg.state === "rejected" || deleg.state === "failed") {
        edgeType = "rejection";
      } else if (deleg.state === "completed") {
        edgeType = "approval";
      } else if (deleg.state === "assigned" || deleg.state === "in_progress") {
        edgeType = deleg.direction === "upward" ? "approval" : "delegation";
      } else if (deleg.state === "pending_review") {
        edgeType = "request";
      } else if (deleg.state === "redirected") {
        edgeType = "delegation";
      } else {
        edgeType = deleg.direction === "downward" ? "delegation" : "request";
      }

      const source = resolveKnownAgentId(cfg, deleg.fromAgentId);
      const target = resolveKnownAgentId(cfg, deleg.toAgentId);

      if (source && target) {
        collaborationEdges.push({
          source,
          target,
          type: edgeType,
          topic: deleg.task.slice(0, 80),
        });
      }

      // If redirected, add edge to the redirect target
      if (deleg.redirectedTo) {
        const redirectTarget = resolveKnownAgentId(cfg, deleg.redirectedTo.agentId);
        if (target && redirectTarget) {
          collaborationEdges.push({
            source: target,
            target: redirectTarget,
            type: "delegation",
            topic: deleg.redirectedTo.reason.slice(0, 80),
          });
        }
      }
    }
  } catch {
    // Delegation data is optional
  }

  // Ensure agents referenced in collaboration/delegation edges have nodes.
  // This makes agents appear in the graph as communication happens.
  const allNodeAgentIds = new Set<string>();
  for (const root of roots) {
    collectAgentIds(root, allNodeAgentIds);
  }
  const referencedAgentIds = new Set<string>();
  for (const edge of collaborationEdges) {
    referencedAgentIds.add(edge.source);
    referencedAgentIds.add(edge.target);
  }
  // Build a set of agents that have active (non-terminal) delegations
  const agentsWithActiveDelegations = new Set<string>();
  try {
    const allDelegations = getAllDelegations();
    for (const deleg of allDelegations) {
      if (
        deleg.state !== "completed" &&
        deleg.state !== "failed" &&
        deleg.state !== "rejected" &&
        deleg.state !== "redirected"
      ) {
        agentsWithActiveDelegations.add(deleg.fromAgentId);
        agentsWithActiveDelegations.add(deleg.toAgentId);
      }
    }
  } catch {
    // ignore
  }

  for (const referencedAgentId of referencedAgentIds) {
    const agentId = resolveKnownAgentId(cfg, referencedAgentId);
    if (!agentId) {
      continue;
    }
    if (allNodeAgentIds.has(agentId)) {
      continue;
    }
    const sessionKey = `agent:${agentId}:main`;
    if (rootSessionKeysUsed.has(sessionKey)) {
      continue;
    }
    const role = resolveAgentRole(cfg, agentId);
    const delegMetrics = getAgentDelegationMetrics(agentId);
    // Agents only referenced via delegation edges inherit status from delegation state:
    // "running" if they have active delegations, "completed" otherwise.
    const derivedStatus = agentsWithActiveDelegations.has(agentId) ? "running" : "completed";
    roots.push({
      sessionKey,
      agentId,
      agentRole: role,
      label: computeAgentDisplayLabel(cfg, agentId),
      status: derivedStatus,
      children: [],
      delegations: delegMetrics,
    });
    rootSessionKeysUsed.add(sessionKey);
    allNodeAgentIds.add(agentId);
  }

  // Build parent-child relationships from allowAgents config
  // Only include agents that are already active in the graph
  const allAgentIds = listAgentIds(cfg);
  const nodeByAgentId = new Map<string, HierarchyNode>();
  for (const root of roots) {
    if (root.agentId) {
      nodeByAgentId.set(root.agentId, root);
    }
    // Also index children recursively
    const indexChildren = (node: HierarchyNode) => {
      for (const child of node.children) {
        if (child.agentId) {
          nodeByAgentId.set(child.agentId, child);
        }
        indexChildren(child);
      }
    };
    indexChildren(root);
  }

  // Remove completed/error agents that have been idle longer than the TTL.
  // Agents without endedAt are kept (they have no known completion time).
  const COMPLETED_TTL_MS = 120_000; // 2 minutes
  const now = Date.now();
  const filterByTTL = (node: HierarchyNode): boolean => {
    if (node.status === "completed" || node.status === "error") {
      if (typeof node.endedAt === "number" && node.endedAt > 0) {
        if (now - node.endedAt > COMPLETED_TTL_MS) {
          return false; // expired — remove from graph
        }
      }
    }
    node.children = node.children.filter(filterByTTL);
    return true;
  };
  roots = roots.filter(filterByTTL);

  // Remove phantom roots: nodes that were created only as parents of subagent runs,
  // but whose children have all expired via TTL. Keep the default orchestrator agent
  // and any root that has a known agentId (it was explicitly configured).
  roots = roots.filter((root) => {
    // Always keep the default orchestrator
    if (root.sessionKey === defaultSessionKey) {
      return true;
    }
    // Keep roots that have children or a recognized agentId
    if (root.children.length > 0 || root.agentId) {
      return true;
    }
    // Remove phantom roots with no children and no agentId
    return false;
  });

  // Link active agents based on allowAgents config (parent-child hierarchy)
  const agentsAttachedToParent = new Set<string>();
  for (const agentId of allAgentIds) {
    const parentNode = nodeByAgentId.get(agentId);
    if (!parentNode) {
      continue;
    }
    const agentCfg = resolveAgentConfig(cfg, agentId);
    const allowAgents = agentCfg?.subagents?.allowAgents;
    if (!allowAgents || allowAgents.length === 0) {
      continue;
    }
    if (allowAgents.length === 1 && allowAgents[0] === "*") {
      continue;
    }
    const existingChildIds = new Set(parentNode.children.map((c) => c.agentId).filter(Boolean));
    for (const childId of allowAgents) {
      if (existingChildIds.has(childId)) {
        continue;
      }
      const childNode = nodeByAgentId.get(childId);
      if (!childNode) {
        continue;
      }
      if (agentsAttachedToParent.has(childId)) {
        continue;
      }
      parentNode.children.push(childNode);
      agentsAttachedToParent.add(childId);
    }
  }

  // Rebuild roots: only agents NOT attached as children should be roots
  const finalRoots: HierarchyNode[] = [];
  for (const root of roots) {
    if (!root.agentId || !agentsAttachedToParent.has(root.agentId)) {
      finalRoots.push(root);
    }
  }

  return {
    roots: finalRoots,
    collaborationEdges,
    updatedAt: Date.now(),
  };
}

function resolveStatus(run: SubagentRunRecord): HierarchyNode["status"] {
  if (run.outcome) {
    return run.outcome.status === "ok" ? "completed" : "error";
  }
  return run.startedAt ? "running" : "pending";
}

function broadcastHierarchyEvent(event: HierarchyEvent) {
  if (!hierarchyBroadcast) {
    return;
  }
  lastEventSeq++;
  const payload = {
    ...event,
    seq: lastEventSeq,
    snapshot: buildHierarchySnapshot(),
  };
  hierarchyBroadcast("hierarchy", payload, { dropIfSlow: true });
}

export function initHierarchyEventBroadcaster(broadcast: HierarchyBroadcast) {
  hierarchyBroadcast = broadcast;

  if (listenerStop) {
    listenerStop();
    listenerStop = null;
  }

  listenerStop = onAgentEvent((evt) => {
    if (!evt) {
      return;
    }

    // Delegation and collaboration events trigger a full snapshot rebuild
    if (evt.stream === "delegation" || evt.stream === "collaboration") {
      const phase = typeof evt.data?.phase === "string" ? evt.data.phase : "unknown";
      broadcastHierarchyEvent({
        type: phase as HierarchyEventType,
        timestamp: Date.now(),
        runId: evt.runId,
        sessionKey: evt.sessionKey,
      });
      return;
    }

    if (evt.stream !== "lifecycle") {
      return;
    }

    const phase = evt.data?.phase;
    const runId = evt.runId;

    if (phase === "spawn") {
      const parentSessionKey =
        typeof evt.data?.parentSessionKey === "string" ? evt.data.parentSessionKey : undefined;
      const label = typeof evt.data?.label === "string" ? evt.data.label : undefined;
      const task = typeof evt.data?.task === "string" ? evt.data.task : undefined;
      broadcastHierarchyEvent({
        type: "spawn",
        timestamp: Date.now(),
        runId,
        sessionKey: evt.sessionKey,
        parentSessionKey,
        label,
        task,
        status: "pending",
      });
      return;
    }

    if (phase === "start") {
      broadcastHierarchyEvent({
        type: "start",
        timestamp: Date.now(),
        runId,
        sessionKey: evt.sessionKey,
        status: "running",
      });
      return;
    }

    if (phase === "end") {
      broadcastHierarchyEvent({
        type: "end",
        timestamp: Date.now(),
        runId,
        sessionKey: evt.sessionKey,
        status: "completed",
        outcome: { status: "ok" },
      });
      return;
    }

    if (phase === "error") {
      const errorMsg = typeof evt.data?.error === "string" ? evt.data.error : undefined;
      broadcastHierarchyEvent({
        type: "error",
        timestamp: Date.now(),
        runId,
        sessionKey: evt.sessionKey,
        status: "error",
        outcome: { status: "error", error: errorMsg },
      });
      return;
    }

    if (phase === "usage-update") {
      broadcastHierarchyEvent({
        type: "usage-update",
        timestamp: Date.now(),
        runId,
        sessionKey: evt.sessionKey,
        status: "running",
      });
      return;
    }

    if (phase === "progress-update") {
      broadcastHierarchyEvent({
        type: "progress-update",
        timestamp: Date.now(),
        runId,
        sessionKey: evt.sessionKey,
        status: "running",
      });
      return;
    }
  });
}

export function broadcastHierarchySpawn(params: {
  runId: string;
  childSessionKey: string;
  parentSessionKey: string;
  label?: string;
  task: string;
}) {
  broadcastHierarchyEvent({
    type: "spawn",
    timestamp: Date.now(),
    runId: params.runId,
    sessionKey: params.childSessionKey,
    parentSessionKey: params.parentSessionKey,
    label: params.label,
    task: params.task,
    status: "pending",
  });
}

export function broadcastHierarchyFullRefresh() {
  broadcastHierarchyEvent({
    type: "full-refresh",
    timestamp: Date.now(),
  });
}

export function stopHierarchyEventBroadcaster() {
  if (listenerStop) {
    listenerStop();
    listenerStop = null;
  }
  hierarchyBroadcast = null;
}

export function getHierarchySnapshot(): HierarchySnapshot {
  return buildHierarchySnapshot();
}
