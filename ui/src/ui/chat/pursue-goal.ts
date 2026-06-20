export type ChatGoalStatus =
  | "queued"
  | "running"
  | "waiting"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "lost";

export type ChatGoalTaskSummary = {
  id?: string;
  taskId?: string;
  flowId?: string;
  title?: string;
  status?: string;
  runId?: string;
  progressSummary?: string;
  terminalSummary?: string;
  blockedReason?: string;
  judgeStatus?: string;
  judgeVerdict?: string;
};

export type ChatGoalFlowSummary = {
  id: string;
  flowId?: string;
  ownerKey?: string;
  status: ChatGoalStatus;
  goal: string;
  currentStep?: string;
  blockedTaskId?: string;
  blockedSummary?: string;
  cancelRequestedAt?: number | string;
  createdAt?: number | string;
  updatedAt?: number | string;
  endedAt?: number | string;
  tasks?: ChatGoalTaskSummary[];
  taskSummary?: {
    total?: number;
    active?: number;
    terminal?: number;
    failures?: number;
  };
};

const ACTIVE_GOAL_STATUSES = new Set<ChatGoalStatus>(["queued", "running", "waiting", "blocked"]);

export function isActiveChatGoal(status: string | undefined): boolean {
  return ACTIVE_GOAL_STATUSES.has(status as ChatGoalStatus);
}

export function resolveCurrentChatGoal(
  flows: readonly ChatGoalFlowSummary[] | undefined,
): ChatGoalFlowSummary | null {
  if (!flows?.length) {
    return null;
  }
  return flows.find((flow) => isActiveChatGoal(flow.status)) ?? flows[0] ?? null;
}

export function chatGoalStatusLabel(flow: ChatGoalFlowSummary | null | undefined): string {
  if (!flow) {
    return "No goal";
  }
  if (flow.cancelRequestedAt && flow.status !== "cancelled") {
    return "Cancelling";
  }
  switch (flow.status) {
    case "queued":
      return "Queued";
    case "running":
      return "Pursuing";
    case "waiting":
      return "Waiting";
    case "blocked":
      return "Blocked";
    case "succeeded":
      return "Complete";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "lost":
      return "Lost";
  }
  return "Unknown";
}

export function buildChatGoalContinuationPrompt(flow: ChatGoalFlowSummary): string {
  return [
    "Continue pursuing this goal from the current verified state.",
    "",
    `Goal: ${flow.goal}`,
    "",
    "Do not repeat completed or mutating work.",
    "Verify concrete evidence before claiming completion.",
    "If the goal is not 100% complete, report the exact blocker and next build gap.",
  ].join("\n");
}
