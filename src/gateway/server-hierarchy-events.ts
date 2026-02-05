import { listAllSubagentRuns, type SubagentRunRecord } from "../agents/subagent-registry.js";
import { onAgentEvent } from "../infra/agent-events.js";

export type HierarchyEventType = "spawn" | "start" | "end" | "error" | "full-refresh";

export type HierarchyEvent = {
  type: HierarchyEventType;
  timestamp: number;
  runId?: string;
  sessionKey?: string;
  parentSessionKey?: string;
  label?: string;
  task?: string;
  status?: "running" | "completed" | "error" | "pending";
  outcome?: { status: string; error?: string };
};

export type HierarchyNode = {
  sessionKey: string;
  runId?: string;
  label?: string;
  task?: string;
  status: "running" | "completed" | "error" | "pending";
  startedAt?: number;
  endedAt?: number;
  children: HierarchyNode[];
};

export type HierarchySnapshot = {
  roots: HierarchyNode[];
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

function buildHierarchySnapshot(): HierarchySnapshot {
  const runs = listAllSubagentRuns();
  const childrenByParent = new Map<string, HierarchyNode[]>();
  const nodeBySession = new Map<string, HierarchyNode>();
  const childSessionKeys = new Set<string>();

  // First pass: create nodes for all runs
  for (const run of runs) {
    const status = resolveStatus(run);
    const node: HierarchyNode = {
      sessionKey: run.childSessionKey,
      runId: run.runId,
      label: run.label,
      task: run.task,
      status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      children: [],
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

  // Find roots
  const roots: HierarchyNode[] = [];
  const parentKeys = new Set(childrenByParent.keys());
  for (const parentKey of parentKeys) {
    if (!childSessionKeys.has(parentKey)) {
      const children = childrenByParent.get(parentKey) ?? [];
      if (children.length > 0) {
        const rootNode: HierarchyNode = {
          sessionKey: parentKey,
          label: "Root Session",
          status: "running",
          children,
        };
        roots.push(rootNode);
      }
    }
  }

  return {
    roots,
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
    if (!evt || evt.stream !== "lifecycle") {
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
