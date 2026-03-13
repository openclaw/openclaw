import type { TriageLane } from "./triage-router.js";

export type LaneExecutionInput = {
  requestId: string;
  lane: TriageLane;
  messageText: string;
  intentSlug: string;
  unitId?: string;
  propertyId?: string;
  args: Record<string, unknown>;
};

export type LaneEvidence = {
  source: "appfolio_api" | "gateway_tool" | "llm";
  ref: string;
  latencyMs: number;
  freshnessMs?: number;
};

export type LaneExecutionResult = {
  lane: TriageLane;
  status: "ok" | "clarify" | "stepup" | "deny" | "error";
  answerText: string;
  evidence: LaneEvidence[];
  usage: {
    apiCalls: number;
    llmCalls: number;
    promptTokens?: number;
    completionTokens?: number;
  };
  escalation: {
    required: boolean;
    reason?: string;
  };
  retriable?: boolean;
  errorCode?: string;
};

type ApiExecuteResult = {
  ok: boolean;
  data?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  retriable?: boolean;
  sourceLatencyMs: number;
};

export type LaneExecutorDeps = {
  executeApiIntent?: (input: {
    requestId: string;
    intentSlug: string;
    unitId?: string;
    propertyId?: string;
    messageText: string;
    args: Record<string, unknown>;
  }) => Promise<ApiExecuteResult>;
  runLowLlm?: (input: {
    messageText: string;
    intentSlug: string;
    evidence: LaneEvidence[];
  }) => Promise<{ text: string; promptTokens?: number; completionTokens?: number }>;
  runHighLlm?: (input: {
    messageText: string;
    intentSlug: string;
    evidence: LaneEvidence[];
  }) => Promise<{ text: string; promptTokens?: number; completionTokens?: number }>;
};

function toCompactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

async function executeApiOnlyLane(
  input: LaneExecutionInput,
  deps: LaneExecutorDeps,
): Promise<LaneExecutionResult> {
  if (!deps.executeApiIntent) {
    return {
      lane: "api_only",
      status: "error",
      answerText: "I could not reach the account system right now.",
      evidence: [],
      usage: { apiCalls: 0, llmCalls: 0 },
      escalation: { required: false },
      retriable: true,
      errorCode: "api_adapter_not_configured",
    };
  }

  const result = await deps.executeApiIntent({
    requestId: input.requestId,
    intentSlug: input.intentSlug,
    unitId: input.unitId,
    propertyId: input.propertyId,
    messageText: input.messageText,
    args: input.args,
  });

  if (!result.ok) {
    return {
      lane: "api_only",
      status: "error",
      answerText: result.errorMessage || "I could not complete that API request.",
      evidence: [
        {
          source: "appfolio_api",
          ref: input.intentSlug,
          latencyMs: result.sourceLatencyMs,
        },
      ],
      usage: { apiCalls: 1, llmCalls: 0 },
      escalation: { required: false },
      retriable: result.retriable === true,
      errorCode: result.errorCode || "api_execution_failed",
    };
  }

  return {
    lane: "api_only",
    status: "ok",
    answerText: `Result for ${input.intentSlug}: ${toCompactJson(result.data ?? {})}`,
    evidence: [
      {
        source: "appfolio_api",
        ref: input.intentSlug,
        latencyMs: result.sourceLatencyMs,
      },
    ],
    usage: { apiCalls: 1, llmCalls: 0 },
    escalation: { required: false },
  };
}

async function executeLowLlmLane(
  input: LaneExecutionInput,
  deps: LaneExecutorDeps,
): Promise<LaneExecutionResult> {
  const baselineText =
    "I can help with that. I used a lightweight synthesis path based on the current request context.";

  if (!deps.runLowLlm) {
    return {
      lane: "low_llm",
      status: "ok",
      answerText: baselineText,
      evidence: [{ source: "llm", ref: "low_llm_default", latencyMs: 0 }],
      usage: { apiCalls: 0, llmCalls: 1 },
      escalation: { required: false },
    };
  }

  const generated = await deps.runLowLlm({
    messageText: input.messageText,
    intentSlug: input.intentSlug,
    evidence: [],
  });
  return {
    lane: "low_llm",
    status: "ok",
    answerText: generated.text,
    evidence: [{ source: "llm", ref: "low_llm", latencyMs: 0 }],
    usage: {
      apiCalls: 0,
      llmCalls: 1,
      promptTokens: generated.promptTokens,
      completionTokens: generated.completionTokens,
    },
    escalation: { required: false },
  };
}

async function executeHighLlmLane(
  input: LaneExecutionInput,
  deps: LaneExecutorDeps,
): Promise<LaneExecutionResult> {
  const baselineText =
    "I can help with that. I used a deeper reasoning path and may still escalate if policy review is required.";

  if (!deps.runHighLlm) {
    return {
      lane: "high_llm",
      status: "ok",
      answerText: baselineText,
      evidence: [{ source: "llm", ref: "high_llm_default", latencyMs: 0 }],
      usage: { apiCalls: 0, llmCalls: 1 },
      escalation: { required: false },
    };
  }

  const generated = await deps.runHighLlm({
    messageText: input.messageText,
    intentSlug: input.intentSlug,
    evidence: [],
  });
  return {
    lane: "high_llm",
    status: "ok",
    answerText: generated.text,
    evidence: [{ source: "llm", ref: "high_llm", latencyMs: 0 }],
    usage: {
      apiCalls: 0,
      llmCalls: 1,
      promptTokens: generated.promptTokens,
      completionTokens: generated.completionTokens,
    },
    escalation: { required: false },
  };
}

export async function executeLane(
  input: LaneExecutionInput,
  deps: LaneExecutorDeps,
): Promise<LaneExecutionResult> {
  if (input.lane === "api_only") {
    return executeApiOnlyLane(input, deps);
  }
  if (input.lane === "low_llm") {
    return executeLowLlmLane(input, deps);
  }
  return executeHighLlmLane(input, deps);
}