type MediaGenerateActionResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

type TaskStatusTextBuilder<Task> = (task: Task, params?: { duplicateGuard?: boolean }) => string;

export type { MediaGenerateActionResult };

export function createMediaGenerateStatusActionResult<Task>(params: {
  sessionKey?: string;
  inactiveText: string;
  findActiveTask: (sessionKey?: string) => Task | undefined;
  buildStatusText: TaskStatusTextBuilder<Task>;
  buildStatusDetails: (task: Task) => Record<string, unknown>;
}): MediaGenerateActionResult {
  const activeTask = params.findActiveTask(params.sessionKey);
  if (!activeTask) {
    return {
      content: [{ type: "text", text: params.inactiveText }],
      details: {
        action: "status",
        active: false,
      },
    };
  }
  return {
    content: [{ type: "text", text: params.buildStatusText(activeTask) }],
    details: {
      action: "status",
      ...params.buildStatusDetails(activeTask),
    },
  };
}

export function createMediaGenerateDuplicateGuardResult<Task>(params: {
  sessionKey?: string;
  findActiveTask: (sessionKey?: string) => Task | undefined;
  buildStatusText: TaskStatusTextBuilder<Task>;
  buildStatusDetails: (task: Task) => Record<string, unknown>;
}): MediaGenerateActionResult | undefined {
  const activeTask = params.findActiveTask(params.sessionKey);
  if (!activeTask) {
    return undefined;
  }
  return {
    content: [
      {
        type: "text",
        text: params.buildStatusText(activeTask, { duplicateGuard: true }),
      },
    ],
    details: {
      action: "status",
      duplicateGuard: true,
      ...params.buildStatusDetails(activeTask),
    },
  };
}
