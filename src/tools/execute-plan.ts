export type ExecutePlanStepInput = {
  action?: unknown;
  name?: unknown;
  tool?: unknown;
  input?: unknown;
  args?: unknown;
  arguments?: unknown;
};

export type ExecutePlanInput =
  | readonly ExecutePlanStepInput[]
  | {
      steps?: unknown;
    };

export type ExecutePlanToolInvokeResult = {
  ok: boolean;
  toolName?: string;
  output?: unknown;
  source?: string;
  requiresApproval?: boolean;
  error?: {
    code?: string;
    message?: string;
  };
};

export type ExecutePlanStepResult = {
  index: number;
  action: string;
  status: "completed" | "blocked" | "failed";
  durationMs: number;
  source?: string;
  output?: unknown;
  error?: {
    code?: string;
    message: string;
    requiresApproval?: boolean;
  };
};

export type ExecutePlanResult = {
  ok: boolean;
  stopped: boolean;
  stopReason?: "blocked_tool" | "failed_tool";
  steps: ExecutePlanStepResult[];
};

export type ExecutePlanOptions = {
  continueOnError?: boolean;
  invoke: (step: {
    action: string;
    args: Record<string, unknown>;
    index: number;
  }) => Promise<ExecutePlanToolInvokeResult>;
};

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeArgs(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function isPlanObject(input: ExecutePlanInput): input is { steps?: unknown } {
  return Boolean(input && typeof input === "object" && !Array.isArray(input));
}

function resolvePlanSteps(input: ExecutePlanInput): ExecutePlanStepInput[] {
  if (Array.isArray(input)) {
    return [...input];
  }
  if (isPlanObject(input) && Array.isArray(input.steps)) {
    return [...(input.steps as ExecutePlanStepInput[])];
  }
  throw new Error("execute plan must be a JSON array or an object with a steps array");
}

function normalizeStep(
  raw: ExecutePlanStepInput,
  index: number,
): { action: string; args: Record<string, unknown> } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`step ${index} must be an object`);
  }
  const action = normalizeOptionalString(raw.action ?? raw.name ?? raw.tool);
  if (!action) {
    throw new Error(`step ${index} requires action, name, or tool`);
  }
  return {
    action,
    args: normalizeArgs(raw.input ?? raw.args ?? raw.arguments),
  };
}

function classifyFailure(result: ExecutePlanToolInvokeResult): {
  status: "blocked" | "failed";
  stopReason: "blocked_tool" | "failed_tool";
} {
  const code = result.error?.code;
  if (result.requiresApproval || code === "forbidden" || code === "requires_approval") {
    return { status: "blocked", stopReason: "blocked_tool" };
  }
  return { status: "failed", stopReason: "failed_tool" };
}

export async function executeToolPlan(
  input: ExecutePlanInput,
  options: ExecutePlanOptions,
): Promise<ExecutePlanResult> {
  const steps = resolvePlanSteps(input).map((step, index) => normalizeStep(step, index));
  const results: ExecutePlanStepResult[] = [];
  let stopped = false;
  let stopReason: ExecutePlanResult["stopReason"];

  for (const [index, step] of steps.entries()) {
    const started = performance.now();
    const result = await options.invoke({ ...step, index });
    const durationMs = Math.max(0, Math.round(performance.now() - started));

    if (result.ok) {
      results.push({
        index,
        action: result.toolName ?? step.action,
        status: "completed",
        durationMs,
        ...(result.source ? { source: result.source } : {}),
        output: result.output,
      });
      continue;
    }

    const failure = classifyFailure(result);
    results.push({
      index,
      action: result.toolName ?? step.action,
      status: failure.status,
      durationMs,
      error: {
        code: result.error?.code,
        message: result.error?.message ?? "tool execution failed",
        ...(result.requiresApproval ? { requiresApproval: true } : {}),
      },
    });

    if (!options.continueOnError) {
      stopped = true;
      stopReason = failure.stopReason;
      break;
    }
  }

  return {
    ok: results.every((step) => step.status === "completed"),
    stopped,
    ...(stopReason ? { stopReason } : {}),
    steps: results,
  };
}
