import { z } from "zod";

/**
 * LLM Output Schemas — Phase 1: Foundation
 *
 * These schemas enforce structured outputs from LLM calls using Zod.
 * Used with Instructor for automatic validation and retry logic.
 */

// ============================================================================
// Tool Call Schemas
// ============================================================================

export const ToolCallSchema = z.object({
  id: z.string().describe("Unique identifier for this tool call"),
  name: z.string().describe("Name of the tool to invoke"),
  arguments: z.record(z.unknown()).describe("Tool arguments as key-value pairs"),
});

export const ToolResultSchema = z.object({
  toolCallId: z.string().describe("ID of the corresponding tool call"),
  name: z.string().describe("Tool name"),
  result: z.unknown().describe("Tool execution result"),
  error: z.string().optional().describe("Error message if tool failed"),
});

// ============================================================================
// Agent Output Schemas
// ============================================================================

export const AgentActionSchema = z.object({
  tool: z.string().describe("Name of the tool to invoke"),
  parameters: z.record(z.unknown()).describe("Tool parameters"),
  reasoning: z.string().describe("Why this action was chosen"),
});

export const AgentOutputSchema = z.object({
  thinking: z.string().optional().describe("Internal reasoning process"),
  actions: z.array(AgentActionSchema).max(10).describe("Tools to invoke (max 10)"),
  response: z.string().optional().describe("Final response to user"),
  confidence: z.number().min(0).max(1).optional().describe("Confidence score (0-1)"),
});

export const AgentStepSchema = z.object({
  stepNumber: z.number().int().positive().describe("Sequential step number"),
  thought: z.string().describe("Agent's reasoning at this step"),
  action: AgentActionSchema.optional().describe("Action taken (if any)"),
  observation: z.string().optional().describe("Result of the action"),
});

export const AgentTrajectorySchema = z.object({
  steps: z.array(AgentStepSchema).describe("Sequential agent steps"),
  finalAnswer: z.string().describe("Final answer/recommendation"),
  citations: z.array(z.string()).optional().describe("Source citations"),
});

// ============================================================================
// Chat Completion Schemas
// ============================================================================

export const ChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]).describe("Message role"),
  content: z.string().describe("Message content"),
  name: z.string().optional().describe("Name for tool/function messages"),
  toolCalls: z.array(ToolCallSchema).optional().describe("Tool calls from assistant"),
  toolCallId: z.string().optional().describe("Tool call ID for tool responses"),
});

export const ChatCompletionRequestSchema = z.object({
  model: z.string().describe("Model identifier"),
  messages: z.array(ChatMessageSchema).describe("Conversation messages"),
  temperature: z.number().min(0).max(2).optional().describe("Sampling temperature"),
  maxTokens: z.number().int().positive().optional().describe("Maximum tokens to generate"),
  tools: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        parameters: z.record(z.unknown()),
      }),
    )
    .optional()
    .describe("Available tools"),
});

export const ChatCompletionResponseSchema = z.object({
  id: z.string().describe("Response ID"),
  model: z.string().describe("Model used"),
  content: z.string().describe("Generated content"),
  toolCalls: z.array(ToolCallSchema).optional().describe("Tool calls requested"),
  usage: z
    .object({
      promptTokens: z.number().int(),
      completionTokens: z.number().int(),
      totalTokens: z.number().int(),
    })
    .optional()
    .describe("Token usage statistics"),
  finishReason: z
    .enum(["stop", "length", "tool_calls", "content_filter"])
    .describe("Why generation stopped"),
});

// ============================================================================
// Reasoning & Analysis Schemas
// ============================================================================

export const ReasoningChainSchema = z.object({
  premise: z.string().describe("Starting premise or assumption"),
  steps: z
    .array(
      z.object({
        statement: z.string().describe("Logical statement"),
        justification: z.string().describe("Why this step follows"),
      }),
    )
    .describe("Chain of reasoning steps"),
  conclusion: z.string().describe("Final conclusion"),
  confidence: z.number().min(0).max(1).describe("Confidence in conclusion"),
});

export const AnalysisResultSchema = z.object({
  summary: z.string().describe("Executive summary"),
  keyPoints: z.array(z.string()).describe("Key findings/points"),
  recommendations: z
    .array(
      z.object({
        action: z.string().describe("Recommended action"),
        priority: z.enum(["high", "medium", "low"]).describe("Priority level"),
        rationale: z.string().describe("Why this action"),
      }),
    )
    .optional()
    .describe("Actionable recommendations"),
  risks: z
    .array(
      z.object({
        description: z.string().describe("Risk description"),
        likelihood: z.enum(["high", "medium", "low"]).describe("Likelihood"),
        impact: z.enum(["high", "medium", "low"]).describe("Impact severity"),
      }),
    )
    .optional()
    .describe("Identified risks"),
});

// ============================================================================
// Validation & Safety Schemas
// ============================================================================

export const ValidationResultSchema = z.object({
  valid: z.boolean().describe("Whether output passed validation"),
  errors: z
    .array(
      z.object({
        field: z.string().describe("Field with error"),
        message: z.string().describe("Error description"),
        severity: z.enum(["error", "warning"]).describe("Error severity"),
      }),
    )
    .describe("Validation errors/warnings"),
  metadata: z.record(z.unknown()).optional().describe("Additional metadata"),
});

export const SafetyCheckResultSchema = z.object({
  safe: z.boolean().describe("Whether content passed safety checks"),
  flags: z
    .array(
      z.object({
        category: z
          .enum(["pii", "prompt_injection", "harmful_content", "biased_content"])
          .describe("Flag category"),
        severity: z.enum(["high", "medium", "low"]).describe("Severity level"),
        description: z.string().describe("Description of the issue"),
        matchedPattern: z.string().optional().describe("Pattern that matched"),
      }),
    )
    .describe("Safety flags raised"),
});

// ============================================================================
// Type Exports
// ============================================================================

export type ToolCall = z.infer<typeof ToolCallSchema>;
export type ToolResult = z.infer<typeof ToolResultSchema>;
export type AgentAction = z.infer<typeof AgentActionSchema>;
export type AgentOutput = z.infer<typeof AgentOutputSchema>;
export type AgentStep = z.infer<typeof AgentStepSchema>;
export type AgentTrajectory = z.infer<typeof AgentTrajectorySchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;
export type ChatCompletionResponse = z.infer<typeof ChatCompletionResponseSchema>;
export type ReasoningChain = z.infer<typeof ReasoningChainSchema>;
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;
export type ValidationResult = z.infer<typeof ValidationResultSchema>;
export type SafetyCheckResult = z.infer<typeof SafetyCheckResultSchema>;
