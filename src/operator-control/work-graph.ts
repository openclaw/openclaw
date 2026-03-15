export const WORK_GRAPH_DEPENDENCY_TYPES = ["FS", "SS", "FF", "SF"] as const;
export type WorkGraphDependencyType = (typeof WORK_GRAPH_DEPENDENCY_TYPES)[number];

export const WORK_GRAPH_NODE_STATES = [
  "pending",
  "ready",
  "running",
  "completed",
  "failed",
  "blocked",
] as const;
export type WorkGraphNodeState = (typeof WORK_GRAPH_NODE_STATES)[number];
export type WorkGraphTerminalOutcome = "completed" | "failed";

export type WorkGraphNode = {
  id: string;
  state: WorkGraphNodeState;
  startedAt?: number;
  endedAt?: number;
  failureReason?: string;
  pendingTerminalOutcome?: WorkGraphTerminalOutcome;
};

export type WorkGraphDependency = {
  from: string;
  to: string;
  type: WorkGraphDependencyType;
};

export type WorkGraphState = {
  nodes: Record<string, WorkGraphNode>;
  dependencies: WorkGraphDependency[];
  maxParallel: number | null;
};

function normalizeId(id: string): string {
  return id.trim();
}

function isKnownNode(state: WorkGraphState, nodeId: string): boolean {
  return Boolean(state.nodes[normalizeId(nodeId)]);
}

function getIncomingDependencies(state: WorkGraphState, nodeId: string): WorkGraphDependency[] {
  const normalized = normalizeId(nodeId);
  return state.dependencies.filter((dependency) => dependency.to === normalized);
}

function hasStarted(node: WorkGraphNode): boolean {
  return typeof node.startedAt === "number";
}

function blocksOnFailure(dependency: WorkGraphDependencyType): boolean {
  return dependency === "FS" || dependency === "FF";
}

function satisfiesStartDependency(
  predecessor: WorkGraphNode,
  dependency: WorkGraphDependencyType,
): boolean {
  if (dependency === "FS") {
    return predecessor.state === "completed";
  }
  if (dependency === "SS") {
    return hasStarted(predecessor);
  }
  return true;
}

function satisfiesFinishDependency(
  predecessor: WorkGraphNode,
  dependency: WorkGraphDependencyType,
): boolean {
  if (dependency === "FF") {
    return predecessor.state === "completed";
  }
  if (dependency === "SF") {
    return hasStarted(predecessor);
  }
  return true;
}

function dependencyHasBecomeImpossible(
  predecessor: WorkGraphNode,
  dependency: WorkGraphDependencyType,
): boolean {
  if (blocksOnFailure(dependency)) {
    return predecessor.state === "failed" || predecessor.state === "blocked";
  }
  return (
    (predecessor.state === "failed" || predecessor.state === "blocked") && !hasStarted(predecessor)
  );
}

function recomputeGraph(state: WorkGraphState): WorkGraphState {
  let changed = true;
  while (changed) {
    changed = false;

    for (const node of Object.values(state.nodes)) {
      if (node.state === "pending" || node.state === "ready") {
        const dependencies = getIncomingDependencies(state, node.id);
        if (
          dependencies.some((dependency) =>
            dependencyHasBecomeImpossible(state.nodes[dependency.from], dependency.type),
          )
        ) {
          node.state = "blocked";
          changed = true;
          continue;
        }

        const ready = dependencies.every((dependency) =>
          satisfiesStartDependency(state.nodes[dependency.from], dependency.type),
        );
        const nextState: WorkGraphNodeState = ready ? "ready" : "pending";
        if (node.state !== nextState) {
          node.state = nextState;
          changed = true;
        }
      }
    }

    for (const node of Object.values(state.nodes)) {
      if (node.state !== "running" || !node.pendingTerminalOutcome) {
        continue;
      }
      const dependencies = getIncomingDependencies(state, node.id);
      if (
        dependencies.some((dependency) =>
          dependencyHasBecomeImpossible(state.nodes[dependency.from], dependency.type),
        )
      ) {
        if (node.pendingTerminalOutcome === "failed") {
          node.state = "failed";
        } else {
          node.state = "blocked";
        }
        node.pendingTerminalOutcome = undefined;
        changed = true;
        continue;
      }

      const finishSatisfied = dependencies.every((dependency) =>
        satisfiesFinishDependency(state.nodes[dependency.from], dependency.type),
      );
      if (!finishSatisfied) {
        continue;
      }
      node.state = node.pendingTerminalOutcome;
      node.pendingTerminalOutcome = undefined;
      changed = true;
    }
  }

  return state;
}

export function createWorkGraphState(params: {
  nodeIds: string[];
  dependencies?: WorkGraphDependency[];
  maxParallel?: number | null;
}): WorkGraphState {
  const seen = new Set<string>();
  const nodes: Record<string, WorkGraphNode> = {};
  for (const rawId of params.nodeIds) {
    const id = normalizeId(rawId);
    if (!id) {
      throw new Error("work graph node id is required");
    }
    if (seen.has(id)) {
      throw new Error(`duplicate work graph node id: ${id}`);
    }
    seen.add(id);
    nodes[id] = {
      id,
      state: "pending",
    };
  }

  const dependencies = (params.dependencies ?? []).map((dependency) => ({
    from: normalizeId(dependency.from),
    to: normalizeId(dependency.to),
    type: dependency.type,
  }));
  for (const dependency of dependencies) {
    if (!WORK_GRAPH_DEPENDENCY_TYPES.includes(dependency.type)) {
      throw new Error(`invalid work graph dependency type: ${dependency.type}`);
    }
    if (!isKnownNode({ nodes, dependencies: [], maxParallel: null }, dependency.from)) {
      throw new Error(`unknown work graph dependency source: ${dependency.from}`);
    }
    if (!isKnownNode({ nodes, dependencies: [], maxParallel: null }, dependency.to)) {
      throw new Error(`unknown work graph dependency target: ${dependency.to}`);
    }
    if (dependency.from === dependency.to) {
      throw new Error(`work graph dependency cannot be self-referential: ${dependency.from}`);
    }
  }

  return recomputeGraph({
    nodes,
    dependencies,
    maxParallel:
      typeof params.maxParallel === "number" && Number.isFinite(params.maxParallel)
        ? Math.max(1, Math.floor(params.maxParallel))
        : null,
  });
}

export function listWorkGraphReadyNodeIds(state: WorkGraphState): string[] {
  return Object.values(state.nodes)
    .filter((node) => node.state === "ready")
    .map((node) => node.id)
    .toSorted((left, right) => left.localeCompare(right));
}

export function markWorkGraphNodeStarted(
  state: WorkGraphState,
  nodeId: string,
  startedAt = Date.now(),
): WorkGraphState {
  const node = state.nodes[normalizeId(nodeId)];
  if (!node) {
    throw new Error(`unknown work graph node: ${nodeId}`);
  }
  if (node.state !== "ready") {
    throw new Error(`work graph node ${node.id} is not ready`);
  }
  node.state = "running";
  node.startedAt = startedAt;
  return recomputeGraph(state);
}

export function markWorkGraphNodeFinished(params: {
  state: WorkGraphState;
  nodeId: string;
  outcome: WorkGraphTerminalOutcome;
  endedAt?: number;
  failureReason?: string;
}): WorkGraphState {
  const node = params.state.nodes[normalizeId(params.nodeId)];
  if (!node) {
    throw new Error(`unknown work graph node: ${params.nodeId}`);
  }
  if (node.state !== "running") {
    throw new Error(`work graph node ${node.id} is not running`);
  }
  node.endedAt = params.endedAt ?? Date.now();
  node.failureReason = params.failureReason;
  node.pendingTerminalOutcome = params.outcome;
  return recomputeGraph(params.state);
}

export function markWorkGraphNodeTerminal(params: {
  state: WorkGraphState;
  nodeId: string;
  outcome: Exclude<WorkGraphNodeState, "pending" | "ready" | "running">;
  endedAt?: number;
  failureReason?: string;
}): WorkGraphState {
  const node = params.state.nodes[normalizeId(params.nodeId)];
  if (!node) {
    throw new Error(`unknown work graph node: ${params.nodeId}`);
  }
  if (!["pending", "ready", "running"].includes(node.state)) {
    throw new Error(`work graph node ${node.id} is already terminal`);
  }
  node.state = params.outcome;
  node.endedAt = params.endedAt ?? Date.now();
  node.failureReason = params.failureReason;
  node.pendingTerminalOutcome = undefined;
  return recomputeGraph(params.state);
}

export function summarizeWorkGraph(state: WorkGraphState): Record<WorkGraphNodeState, number> {
  return Object.values(state.nodes).reduce<Record<WorkGraphNodeState, number>>(
    (summary, node) => {
      summary[node.state] += 1;
      return summary;
    },
    {
      pending: 0,
      ready: 0,
      running: 0,
      completed: 0,
      failed: 0,
      blocked: 0,
    },
  );
}

export function isWorkGraphTerminal(state: WorkGraphState): boolean {
  return Object.values(state.nodes).every((node) =>
    ["completed", "failed", "blocked"].includes(node.state),
  );
}
