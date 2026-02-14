/**
 * Contract enforcement tests for OpenClaw internal message types.
 *
 * A1-A5: Schema validation tests
 * A6-A9: Dispatcher exclusivity invariant tests
 */

import { describe, expect, it } from "vitest";
import {
  EscalationSignalSchema,
  MemoryWriteSchema,
  PlanArtifactSchema,
  PlanRequestSchema,
  ResultSchema,
  TaskEnvelopeSchema,
  validateEscalationSignal,
  validateMemoryWrite,
  validatePlanArtifact,
  validatePlanRequest,
  validateResult,
  validateTaskEnvelope,
} from "./schemas.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const now = Date.now();

const validPlanRequest = {
  requestId: "req-001",
  sessionId: "session-abc",
  sessionKey: "agent:main:telegram",
  channel: "telegram",
  body: "Hello world",
  timestamp: now,
  callerRole: "dispatcher" as const,
};

const validPlanArtifact = {
  requestId: "req-001",
  provider: "anthropic",
  model: "claude-opus-4-6",
  sessionId: "session-abc",
  sessionKey: "agent:main:telegram",
  producedBy: "dispatcher" as const,
  decidedAt: now,
};

const validTaskEnvelope = {
  requestId: "req-001",
  taskId: "task-001",
  planArtifact: validPlanArtifact,
  prompt: "Hello world",
  dispatchedBy: "dispatcher" as const,
  dispatchedAt: now,
};

const validResult = {
  taskId: "task-001",
  requestId: "req-001",
  ok: true,
  payloads: [{ text: "Response text" }],
  producedBy: "executor" as const,
  completedAt: now,
};

const validEscalation = {
  taskId: "task-001",
  requestId: "req-001",
  reason: "repeated_failure" as const,
  description: "Model failed twice with same error",
  escalatedBy: "dispatcher" as const,
  escalatedAt: now,
};

const validMemoryWrite = {
  sessionId: "session-abc",
  content: "Learned: user prefers dark mode",
  target: "memory/2026-02-14.md",
  writtenBy: "dispatcher" as const,
  writtenAt: now,
};

// ---------------------------------------------------------------------------
// A1: PlanRequest schema validation
// ---------------------------------------------------------------------------

describe("A1: PlanRequest schema", () => {
  it("accepts valid PlanRequest", () => {
    expect(() => validatePlanRequest(validPlanRequest)).not.toThrow();
  });

  it("accepts PlanRequest with optional fields", () => {
    expect(() =>
      validatePlanRequest({
        ...validPlanRequest,
        sender: "user123",
        chatType: "group",
        mediaUrls: ["https://example.com/img.png"],
        isHeartbeat: true,
      }),
    ).not.toThrow();
  });

  it("rejects PlanRequest with missing requestId", () => {
    const { requestId, ...rest } = validPlanRequest;
    expect(() => validatePlanRequest(rest)).toThrow();
  });

  it("rejects PlanRequest with empty body allowed (can be empty string)", () => {
    // body is z.string() without min(1), so empty is allowed
    expect(() => validatePlanRequest({ ...validPlanRequest, body: "" })).not.toThrow();
  });

  it("rejects PlanRequest with invalid chatType", () => {
    expect(() => validatePlanRequest({ ...validPlanRequest, chatType: "unknown" })).toThrow();
  });

  it("rejects PlanRequest with extra unknown fields (strict mode)", () => {
    expect(() => validatePlanRequest({ ...validPlanRequest, sneakyField: "hack" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// A2: PlanArtifact schema validation
// ---------------------------------------------------------------------------

describe("A2: PlanArtifact schema", () => {
  it("accepts valid PlanArtifact", () => {
    expect(() => validatePlanArtifact(validPlanArtifact)).not.toThrow();
  });

  it("accepts PlanArtifact with optional fields", () => {
    expect(() =>
      validatePlanArtifact({
        ...validPlanArtifact,
        thinkLevel: "medium",
        agentId: "main",
        useSubagent: true,
        subagentLabel: "research",
        contextBudget: 128000,
        outputBudget: 4096,
        skillFilter: ["web_search", "browser"],
      }),
    ).not.toThrow();
  });

  it("rejects PlanArtifact with missing provider", () => {
    const { provider, ...rest } = validPlanArtifact;
    expect(() => validatePlanArtifact(rest)).toThrow();
  });

  it("rejects PlanArtifact with invalid thinkLevel", () => {
    expect(() => validatePlanArtifact({ ...validPlanArtifact, thinkLevel: "ultra" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// A3: TaskEnvelope schema validation
// ---------------------------------------------------------------------------

describe("A3: TaskEnvelope schema", () => {
  it("accepts valid TaskEnvelope", () => {
    expect(() => validateTaskEnvelope(validTaskEnvelope)).not.toThrow();
  });

  it("accepts TaskEnvelope with optional fields", () => {
    expect(() =>
      validateTaskEnvelope({
        ...validTaskEnvelope,
        systemPromptOverride: "You are a helpful assistant.",
        lane: "subagent",
        timeoutMs: 30000,
        abortSignalId: "abort-001",
      }),
    ).not.toThrow();
  });

  it("rejects TaskEnvelope with invalid nested planArtifact", () => {
    expect(() =>
      validateTaskEnvelope({
        ...validTaskEnvelope,
        planArtifact: { ...validPlanArtifact, producedBy: "executor" },
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// A4: Result schema validation
// ---------------------------------------------------------------------------

describe("A4: Result schema", () => {
  it("accepts valid success Result", () => {
    expect(() => validateResult(validResult)).not.toThrow();
  });

  it("accepts valid error Result", () => {
    expect(() =>
      validateResult({
        ...validResult,
        ok: false,
        error: {
          kind: "model_failure",
          message: "Rate limited",
          retryable: true,
        },
      }),
    ).not.toThrow();
  });

  it("accepts Result with full metadata", () => {
    expect(() =>
      validateResult({
        ...validResult,
        meta: {
          provider: "anthropic",
          model: "claude-opus-4-6",
          durationMs: 1500,
          usage: { input: 1000, output: 500, total: 1500 },
          stopReason: "completed",
        },
      }),
    ).not.toThrow();
  });

  it("rejects Result with invalid error kind", () => {
    expect(() =>
      validateResult({
        ...validResult,
        ok: false,
        error: { kind: "magic_failure", message: "oops" },
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// A5: EscalationSignal schema validation
// ---------------------------------------------------------------------------

describe("A5: EscalationSignal schema", () => {
  it("accepts valid EscalationSignal", () => {
    expect(() => validateEscalationSignal(validEscalation)).not.toThrow();
  });

  it("accepts EscalationSignal with optional fields", () => {
    expect(() =>
      validateEscalationSignal({
        ...validEscalation,
        suggestedAction: "retry_different_model",
        retryCount: 1,
        failedResult: { ...validResult, ok: false },
      }),
    ).not.toThrow();
  });

  it("rejects EscalationSignal with invalid reason", () => {
    expect(() => validateEscalationSignal({ ...validEscalation, reason: "boredom" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// A6: Only dispatcher routes tasks
// ---------------------------------------------------------------------------

describe("A6: Only dispatcher routes tasks", () => {
  it("rejects TaskEnvelope where dispatchedBy is not 'dispatcher'", () => {
    const result = TaskEnvelopeSchema.safeParse({
      ...validTaskEnvelope,
      dispatchedBy: "executor",
    });
    expect(result.success).toBe(false);
  });

  it("rejects TaskEnvelope where dispatchedBy is not 'dispatcher' (subagent)", () => {
    const result = TaskEnvelopeSchema.safeParse({
      ...validTaskEnvelope,
      dispatchedBy: "subagent",
    });
    expect(result.success).toBe(false);
  });

  it("rejects PlanRequest where callerRole is not 'dispatcher'", () => {
    const result = PlanRequestSchema.safeParse({
      ...validPlanRequest,
      callerRole: "executor",
    });
    expect(result.success).toBe(false);
  });

  it("accepts TaskEnvelope where dispatchedBy is 'dispatcher'", () => {
    const result = TaskEnvelopeSchema.safeParse(validTaskEnvelope);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A7: Only dispatcher selects models
// ---------------------------------------------------------------------------

describe("A7: Only dispatcher selects models", () => {
  it("rejects PlanArtifact where producedBy is not 'dispatcher'", () => {
    const result = PlanArtifactSchema.safeParse({
      ...validPlanArtifact,
      producedBy: "executor",
    });
    expect(result.success).toBe(false);
  });

  it("rejects PlanArtifact where producedBy is not 'dispatcher' (planner)", () => {
    const result = PlanArtifactSchema.safeParse({
      ...validPlanArtifact,
      producedBy: "planner",
    });
    expect(result.success).toBe(false);
  });

  it("model selection fields only exist in PlanArtifact (produced by dispatcher)", () => {
    // Verify that model+provider are required in PlanArtifact
    const withoutModel = PlanArtifactSchema.safeParse({
      ...validPlanArtifact,
      model: undefined,
    });
    expect(withoutModel.success).toBe(false);

    const withoutProvider = PlanArtifactSchema.safeParse({
      ...validPlanArtifact,
      provider: undefined,
    });
    expect(withoutProvider.success).toBe(false);
  });

  it("accepts PlanArtifact where producedBy is 'dispatcher'", () => {
    const result = PlanArtifactSchema.safeParse(validPlanArtifact);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A8: Only dispatcher escalates
// ---------------------------------------------------------------------------

describe("A8: Only dispatcher escalates", () => {
  it("rejects EscalationSignal where escalatedBy is not 'dispatcher'", () => {
    const result = EscalationSignalSchema.safeParse({
      ...validEscalation,
      escalatedBy: "executor",
    });
    expect(result.success).toBe(false);
  });

  it("rejects EscalationSignal where escalatedBy is not 'dispatcher' (model)", () => {
    const result = EscalationSignalSchema.safeParse({
      ...validEscalation,
      escalatedBy: "model",
    });
    expect(result.success).toBe(false);
  });

  it("accepts EscalationSignal where escalatedBy is 'dispatcher'", () => {
    const result = EscalationSignalSchema.safeParse(validEscalation);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A9: Only dispatcher writes memory
// ---------------------------------------------------------------------------

describe("A9: Only dispatcher writes memory", () => {
  it("rejects MemoryWrite where writtenBy is not 'dispatcher'", () => {
    const result = MemoryWriteSchema.safeParse({
      ...validMemoryWrite,
      writtenBy: "executor",
    });
    expect(result.success).toBe(false);
  });

  it("rejects MemoryWrite where writtenBy is not 'dispatcher' (subagent)", () => {
    const result = MemoryWriteSchema.safeParse({
      ...validMemoryWrite,
      writtenBy: "subagent",
    });
    expect(result.success).toBe(false);
  });

  it("rejects MemoryWrite with empty content", () => {
    const result = MemoryWriteSchema.safeParse({
      ...validMemoryWrite,
      content: "",
    });
    expect(result.success).toBe(false);
  });

  it("accepts MemoryWrite where writtenBy is 'dispatcher'", () => {
    const result = MemoryWriteSchema.safeParse(validMemoryWrite);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: type safety & strict mode
// ---------------------------------------------------------------------------

describe("Cross-cutting contract invariants", () => {
  it("all schemas reject null input", () => {
    expect(PlanRequestSchema.safeParse(null).success).toBe(false);
    expect(PlanArtifactSchema.safeParse(null).success).toBe(false);
    expect(TaskEnvelopeSchema.safeParse(null).success).toBe(false);
    expect(ResultSchema.safeParse(null).success).toBe(false);
    expect(EscalationSignalSchema.safeParse(null).success).toBe(false);
    expect(MemoryWriteSchema.safeParse(null).success).toBe(false);
  });

  it("all schemas reject undefined input", () => {
    expect(PlanRequestSchema.safeParse(undefined).success).toBe(false);
    expect(PlanArtifactSchema.safeParse(undefined).success).toBe(false);
    expect(TaskEnvelopeSchema.safeParse(undefined).success).toBe(false);
    expect(ResultSchema.safeParse(undefined).success).toBe(false);
    expect(EscalationSignalSchema.safeParse(undefined).success).toBe(false);
    expect(MemoryWriteSchema.safeParse(undefined).success).toBe(false);
  });

  it("all schemas reject empty object", () => {
    expect(PlanRequestSchema.safeParse({}).success).toBe(false);
    expect(PlanArtifactSchema.safeParse({}).success).toBe(false);
    expect(TaskEnvelopeSchema.safeParse({}).success).toBe(false);
    expect(ResultSchema.safeParse({}).success).toBe(false);
    expect(EscalationSignalSchema.safeParse({}).success).toBe(false);
    expect(MemoryWriteSchema.safeParse({}).success).toBe(false);
  });

  it("requestId must be non-empty across all schemas that require it", () => {
    expect(PlanRequestSchema.safeParse({ ...validPlanRequest, requestId: "" }).success).toBe(false);
    expect(PlanArtifactSchema.safeParse({ ...validPlanArtifact, requestId: "" }).success).toBe(
      false,
    );
    expect(TaskEnvelopeSchema.safeParse({ ...validTaskEnvelope, requestId: "" }).success).toBe(
      false,
    );
    expect(ResultSchema.safeParse({ ...validResult, requestId: "" }).success).toBe(false);
    expect(EscalationSignalSchema.safeParse({ ...validEscalation, requestId: "" }).success).toBe(
      false,
    );
  });
});
