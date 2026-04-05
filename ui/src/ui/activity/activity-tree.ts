import type {
  ActivityTree,
  ActivityNode,
  ActivityNodeKind,
  ActivityNodeStatus,
  ActivityMetrics,
} from "./activity-types.ts";

const MAX_TREE_NODES = 500;
const PRUNE_AGE_MS = 5 * 60 * 1000;

export function createActivityTree(): ActivityTree {
  return {
    rootNodes: [],
    nodeById: new Map(),
    sessionKeyToSpawner: new Map(),
    totalNodes: 0,
  };
}

type ActivityEventData = {
  kind: string;
  agentId?: string;
  parentRunId?: string;
  depth?: number;
  toolName?: string;
  toolCallId?: string;
  durationMs?: number;
  isError?: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
};

type IncomingEvent = {
  runId: string;
  ts: number;
  sessionKey?: string;
  data: ActivityEventData;
};

function resolveKind(eventKind: string): ActivityNodeKind {
  if (eventKind.startsWith("tool.")) {
    return "tool";
  }
  if (eventKind.startsWith("thinking.")) {
    return "thinking";
  }
  if (eventKind.startsWith("subagent.")) {
    return "subagent";
  }
  return "run";
}

function summarizeToolArgs(args: unknown): string {
  if (!args) {
    return "";
  }
  const str = typeof args === "string" ? args : "";
  if (!str) {
    return "";
  }
  try {
    const parsed = JSON.parse(str);
    if (typeof parsed !== "object" || parsed === null) {
      return "";
    }
    // Show the most informative field as a short suffix
    const path = parsed.path ?? parsed.file_path ?? parsed.filePath;
    if (typeof path === "string") {
      return path.length > 60 ? `…${path.slice(-55)}` : path;
    }
    const cmd = parsed.command ?? parsed.cmd;
    if (typeof cmd === "string") {
      return cmd.length > 60 ? `${cmd.slice(0, 57)}…` : cmd;
    }
    const action = parsed.action;
    if (typeof action === "string") {
      return action;
    }
  } catch {
    // not JSON
  }
  return "";
}

function resolveLabel(data: ActivityEventData): string {
  if (data.toolName) {
    const argsSummary = summarizeToolArgs(data.metadata?.args);
    return argsSummary ? `${data.toolName}  ${argsSummary}` : data.toolName;
  }
  if (data.kind.startsWith("subagent.") && data.agentId) {
    const task = typeof data.metadata?.task === "string" ? data.metadata.task : "";
    const taskPreview = task.length > 60 ? `${task.slice(0, 57)}…` : task;
    return taskPreview ? `${data.agentId}: ${taskPreview}` : data.agentId;
  }
  if (data.agentId) {
    return data.agentId;
  }
  return data.kind;
}

function resolveNodeId(event: IncomingEvent): string {
  const data = event.data;
  if (data.toolCallId) {
    return `${event.runId}:tool:${data.toolCallId}`;
  }
  if (data.kind.startsWith("subagent.")) {
    return `${event.runId}:subagent:${data.agentId ?? "unknown"}`;
  }
  if (data.kind.startsWith("thinking.")) {
    return `${event.runId}:thinking`;
  }
  return event.runId;
}

export function applyActivityEvent(tree: ActivityTree, event: IncomingEvent): ActivityTree {
  const data = event.data;
  const kind = data.kind;
  const nodeId = resolveNodeId(event);

  if (kind.endsWith(".start")) {
    const node: ActivityNode = {
      id: nodeId,
      runId: event.runId,
      parentId: null,
      kind: resolveKind(kind),
      status: "running",
      label: resolveLabel(data),
      startedAt: event.ts,
      endedAt: null,
      durationMs: null,
      depth: typeof data.depth === "number" ? data.depth : 0,
      children: [],
      isError: false,
      error: null,
      metadata: {
        ...data.metadata,
        ...(event.sessionKey ? { _sessionKey: event.sessionKey } : {}),
      },
    };

    const nodeKind = resolveKind(kind);

    // Register subagent session key → spawner mapping.
    if (nodeKind === "subagent" && typeof data.metadata?.childSessionKey === "string") {
      tree.sessionKeyToSpawner.set(data.metadata.childSessionKey, nodeId);
    }

    // Link tool and thinking nodes to their parent run.
    // For these kinds, event.runId is the parent run's ID.
    if (nodeKind === "tool" || nodeKind === "thinking") {
      const parentRun = tree.nodeById.get(event.runId);
      if (parentRun) {
        node.parentId = event.runId;
        node.depth = parentRun.depth + 1;
        if (!parentRun.children.includes(nodeId)) {
          parentRun.children.push(nodeId);
        }
      }
    }

    // Link subagent nodes to their parent run by session key.
    // The subagent event's sessionKey is the parent's session key.
    if (nodeKind === "subagent" && event.sessionKey) {
      for (const [candidateId, candidate] of tree.nodeById) {
        if (candidate.kind === "run" && candidate.status === "running") {
          // Match by session key: find a running run node whose events
          // came from the same session as this subagent spawn.
          const candidateSessionKey = candidate.metadata._sessionKey;
          if (candidateSessionKey === event.sessionKey) {
            node.parentId = candidateId;
            node.depth = candidate.depth + 1;
            if (!candidate.children.includes(nodeId)) {
              candidate.children.push(nodeId);
            }
            break;
          }
        }
      }
    }

    // For run nodes, check if this session was spawned by a subagent.
    if (nodeKind === "run" && !node.parentId) {
      let matched = false;

      // Try session key matching first.
      if (event.sessionKey) {
        const spawnerNodeId = tree.sessionKeyToSpawner.get(event.sessionKey);
        if (spawnerNodeId) {
          const spawner = tree.nodeById.get(spawnerNodeId);
          if (spawner) {
            node.parentId = spawnerNodeId;
            node.depth = spawner.depth + 1;
            if (!spawner.children.includes(nodeId)) {
              spawner.children.push(nodeId);
            }
            matched = true;
          }
        }
      }

      // Fallback: find a recent unmatched subagent node with the same agentId.
      if (!matched && data.agentId) {
        for (const [candidateId, candidate] of tree.nodeById) {
          if (
            candidate.kind === "subagent" &&
            candidate.label.startsWith(data.agentId) &&
            candidate.children.length === 0
          ) {
            node.parentId = candidateId;
            node.depth = candidate.depth + 1;
            if (!candidate.children.includes(nodeId)) {
              candidate.children.push(nodeId);
            }
            break;
          }
        }
      }
    }

    tree.nodeById.set(nodeId, node);
    if (!node.parentId && !tree.rootNodes.includes(nodeId)) {
      tree.rootNodes.push(nodeId);
    }
    tree.totalNodes = tree.nodeById.size;

    if (tree.totalNodes > MAX_TREE_NODES) {
      pruneCompletedBranches(tree, 0);
    }

    return tree;
  }

  if (kind.endsWith(".end") || kind.endsWith(".error")) {
    const existing = tree.nodeById.get(nodeId);
    if (existing) {
      existing.status = data.isError || kind.endsWith(".error") ? "error" : "completed";
      existing.endedAt = event.ts;
      existing.durationMs = data.durationMs ?? event.ts - existing.startedAt;
      existing.isError = data.isError ?? kind.endsWith(".error");
      existing.error = data.error ?? null;
      if (data.metadata) {
        existing.metadata = { ...existing.metadata, ...data.metadata };
      }
    }
    return tree;
  }

  // Handle subagent.completed — merge outcome into the existing subagent node.
  if (kind === "subagent.completed") {
    // Find the subagent node by runId match.
    const subagentNodeId = `${event.runId}:subagent:${data.agentId ?? "unknown"}`;
    let target = tree.nodeById.get(subagentNodeId);
    // Fallback: find any subagent node with matching runId.
    if (!target) {
      for (const node of tree.nodeById.values()) {
        if (node.kind === "subagent" && node.runId === event.runId) {
          target = node;
          break;
        }
      }
    }
    if (target) {
      target.status = data.isError || data.error ? "error" : "completed";
      target.endedAt = event.ts;
      target.durationMs = event.ts - target.startedAt;
      target.isError = Boolean(data.isError || data.error);
      target.error = typeof data.error === "string" ? data.error : null;
      if (data.metadata) {
        target.metadata = { ...target.metadata, ...data.metadata };
      }
    }
    return tree;
  }

  return tree;
}

export function pruneCompletedBranches(tree: ActivityTree, maxAgeMs: number = PRUNE_AGE_MS): void {
  const now = Date.now();
  const toRemove: string[] = [];

  for (const [id, node] of tree.nodeById) {
    if (
      (node.status === "completed" || node.status === "error") &&
      node.endedAt !== null &&
      now - node.endedAt > maxAgeMs
    ) {
      toRemove.push(id);
    }
  }

  for (const id of toRemove) {
    tree.nodeById.delete(id);
    const rootIdx = tree.rootNodes.indexOf(id);
    if (rootIdx !== -1) {
      tree.rootNodes.splice(rootIdx, 1);
    }
  }

  tree.totalNodes = tree.nodeById.size;
}

export function computeMetrics(tree: ActivityTree): ActivityMetrics {
  let activeRuns = 0;
  let activeTools = 0;
  let totalToolCalls = 0;
  let totalErrors = 0;
  let completedNodes = 0;

  for (const node of tree.nodeById.values()) {
    if (node.kind === "run" && node.status === "running") {
      activeRuns++;
    }
    if (node.kind === "tool") {
      totalToolCalls++;
      if (node.status === "running") {
        activeTools++;
      }
    }
    if (node.isError) {
      totalErrors++;
    }
    if (node.status === "completed" || node.status === "error") {
      completedNodes++;
    }
  }

  return { activeRuns, activeTools, totalToolCalls, totalErrors, completedNodes };
}

export type ActivityFilterCriteria = {
  kinds: Set<ActivityNodeKind>;
  search: string;
  timeRangeMs: number | null;
};

export function filterTree(tree: ActivityTree, filters: ActivityFilterCriteria): ActivityTree {
  const now = Date.now();
  const filtered: ActivityTree = {
    rootNodes: [],
    nodeById: new Map(),
    sessionKeyToSpawner: new Map(tree.sessionKeyToSpawner),
    totalNodes: 0,
  };

  for (const [id, node] of tree.nodeById) {
    if (!filters.kinds.has(node.kind)) {
      continue;
    }
    if (filters.timeRangeMs !== null && now - node.startedAt > filters.timeRangeMs) {
      continue;
    }
    if (
      filters.search &&
      !node.label.toLowerCase().includes(filters.search.toLowerCase()) &&
      !node.id.toLowerCase().includes(filters.search.toLowerCase())
    ) {
      continue;
    }
    filtered.nodeById.set(id, node);
  }

  for (const rootId of tree.rootNodes) {
    if (filtered.nodeById.has(rootId)) {
      filtered.rootNodes.push(rootId);
    }
  }

  filtered.totalNodes = filtered.nodeById.size;
  return filtered;
}

export type TimelineEntry = {
  id: string;
  kind: string;
  label: string;
  status: ActivityNodeStatus;
  ts: number;
  durationMs: number | null;
  isError: boolean;
};

export function flattenTimeline(tree: ActivityTree): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const node of tree.nodeById.values()) {
    entries.push({
      id: node.id,
      kind: node.kind,
      label: node.label,
      status: node.status,
      ts: node.startedAt,
      durationMs: node.durationMs,
      isError: node.isError,
    });
  }
  entries.sort((a, b) => a.ts - b.ts);
  return entries;
}
