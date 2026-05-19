export type TaskSource = "claude_desktop" | "claude_cli" | "codex_cli" | "openclaw" | "nuwa_mcp";

export type TaskRoute =
  | "desktop_done"
  | "claude_code_cli"
  | "codex_cli"
  | "local_model"
  | "api"
  | "manual_approval";

export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "blocked";

export type RiskClass =
  | "read_only"
  | "local_write"
  | "external_write"
  | "trading_payment"
  | "credential";

export interface TaskPackage {
  taskId: string;
  traceId: string;
  source: TaskSource;
  task: string;
  context?: string;
  riskClass: RiskClass;
  tags: string[];
  createdAt: string;
}

export interface TaskResult {
  taskId: string;
  traceId: string;
  source: TaskSource;
  route: TaskRoute;
  status: TaskStatus;
  result?: string;
  changedFiles: string[];
  commandsRun: string[];
  risks: string[];
  costUsd: number;
  durationMs: number;
  startedAt: string;
  endedAt: string;
  error?: string;
}

export function createTaskResult(pkg: TaskPackage, route: TaskRoute): TaskResult {
  return {
    taskId: pkg.taskId,
    traceId: pkg.traceId,
    source: pkg.source,
    route,
    status: "running",
    changedFiles: [],
    commandsRun: [],
    risks: [],
    costUsd: 0,
    durationMs: 0,
    startedAt: new Date().toISOString(),
    endedAt: "",
  };
}

export function markSucceeded(result: TaskResult, output: string, costUsd: number): TaskResult {
  const endedAt = new Date().toISOString();
  const durationMs = new Date(endedAt).getTime() - new Date(result.startedAt).getTime();
  return { ...result, status: "succeeded", result: output, costUsd, durationMs, endedAt };
}

export function markFailed(result: TaskResult, error: string): TaskResult {
  const endedAt = new Date().toISOString();
  const durationMs = new Date(endedAt).getTime() - new Date(result.startedAt).getTime();
  return { ...result, status: "failed", error, durationMs, endedAt };
}
