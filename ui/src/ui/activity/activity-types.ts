export type ActivityNodeStatus = "pending" | "running" | "completed" | "error";

export type ActivityNodeKind = "run" | "tool" | "thinking" | "subagent";

export type ActivityNode = {
  id: string;
  runId: string;
  parentId: string | null;
  kind: ActivityNodeKind;
  status: ActivityNodeStatus;
  label: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  depth: number;
  children: string[];
  isError: boolean;
  error: string | null;
  metadata: Record<string, unknown>;
};

export type ActivityTree = {
  rootNodes: string[];
  nodeById: Map<string, ActivityNode>;
  totalNodes: number;
};

export type ActivityMetrics = {
  activeRuns: number;
  activeTools: number;
  totalToolCalls: number;
  totalErrors: number;
  completedNodes: number;
};
