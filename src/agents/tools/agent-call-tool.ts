/**
 * Agent Call Tool - Structured delegation to agents with confidence tracking
 *
 * Replaces sessions_send/sessions_spawn for structured skill-based delegation.
 * Agents declare skills with JSON Schema input/output, and returns include confidence.
 *
 * Design based on A2A Protocol concepts:
 * - Agent Cards declare skills with schemas
 * - Structured I/O instead of freeform text
 * - Confidence and assumption tracking
 */

import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import type { AnyAgentTool } from "./common.js";
import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { AGENT_LANE_NESTED } from "../lanes.js";
import { jsonResult, readStringParam, readNumberParam } from "./common.js";
import { extractAssistantText } from "./sessions-helpers.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
  validateAgentId,
  validateSkillName,
  validateInputSize,
  boundConfidence,
  checkA2APolicy,
  MAX_A2A_INPUT_SIZE,
} from "./sessions-helpers.js";
import { buildAgentToAgentMessageContext } from "./sessions-send-helpers.js";

const AgentCallToolSchema = Type.Object({
  agent: Type.String({ description: "Target agent ID (e.g., 'rca-agent', 'metis')" }),
  skill: Type.String({ description: "Skill to invoke on the target agent" }),
  input: Type.Object(
    {},
    { additionalProperties: true, description: "Structured input matching skill's inputSchema" },
  ),
  mode: Type.Optional(
    Type.String({
      enum: ["execute", "critique"],
      default: "execute",
      description: "execute = run skill, critique = review from agent's perspective",
    }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 3600,
      description: "Timeout in seconds (max: 3600, 0 for fire-and-forget, default: 60)",
    }),
  ),
  instance: Type.Optional(
    Type.String({ description: "Remote instance ID for federation (future)" }),
  ),
});

export interface AgentCallResult {
  status: "completed" | "working" | "error" | "forbidden";
  output?: unknown;
  confidence?: number;
  assumptions?: string[];
  caveats?: string[];
  artifacts?: Array<{ type: string; path: string }>;
  taskId?: string;
  error?: string;
}

/**
 * Parse structured response from agent.
 *
 * Expects agent to output JSON with:
 * - output: the actual result
 * - confidence: 0-1 (optional, default 0.5)
 * - assumptions: string[] (optional)
 * - caveats: string[] (optional)
 */
function parseStructuredResponse(raw: string): {
  output: unknown;
  confidence: number;
  assumptions: string[];
  caveats: string[];
} {
  let output: unknown;
  let confidence = 0.5;
  let assumptions: string[] = [];
  let caveats: string[] = [];

  try {
    // Try to extract JSON from response
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);

      // Handle nested output structure
      output = parsed.output ?? parsed.result ?? parsed;

      // Extract confidence (look in multiple places) - bound to [0, 1]
      const rawConfidence =
        typeof parsed.confidence === "number"
          ? parsed.confidence
          : typeof parsed.output?.confidence === "number"
            ? parsed.output.confidence
            : 0.5;
      confidence = boundConfidence(rawConfidence);

      // Extract assumptions
      assumptions = Array.isArray(parsed.assumptions)
        ? parsed.assumptions
        : Array.isArray(parsed.output?.assumptions)
          ? parsed.output.assumptions
          : typeof parsed.assumptions === "string"
            ? [parsed.assumptions]
            : [];

      // Extract caveats
      caveats = Array.isArray(parsed.caveats)
        ? parsed.caveats
        : Array.isArray(parsed.output?.caveats)
          ? parsed.output.caveats
          : [];
    } else {
      // Unstructured response
      output = raw;
      confidence = 0.5;
    }
  } catch (err) {
    // Log parsing failures in development mode
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        `[agent_call] Failed to parse agent response JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    output = raw;
    confidence = 0.3; // Lower confidence for failed parse
  }

  return { output, confidence: boundConfidence(confidence), assumptions, caveats };
}

/**
 * Resolve agent ID to session key.
 */
function resolveAgentSessionKey(agentId: string): string {
  const normalized = validateAgentId(agentId);
  // Main session for the agent
  return `agent:${normalized}:main`;
}

// Security audit logging
const LOG_PREFIX = "[agent_call]";
const logAudit = (event: string, data: Record<string, unknown>) => {
  if (process.env.NODE_ENV !== "test") {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "audit",
        component: LOG_PREFIX,
        event,
        ...data,
      }),
    );
  }
};

export function createAgentCallTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  sandboxed?: boolean;
}): AnyAgentTool {
  return {
    label: "Agent Call",
    name: "agent_call",
    description:
      "Call another agent with structured input/output and get confidence-tracked result. " +
      "Prefer this over sessions_send for skill-based delegation.",
    parameters: AgentCallToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const skillRaw = readStringParam(params, "skill", { required: true });
      const input = params.input as Record<string, unknown>;
      const mode = readStringParam(params, "mode") ?? "execute";
      const timeoutSeconds = readNumberParam(params, "timeoutSeconds") ?? 60;
      const timeoutMs = timeoutSeconds * 1000;
      const instance = readStringParam(params, "instance"); // Future: federation

      // Fix 1: Agent ID validation (must happen early to prevent injection)
      let agentId: string;
      try {
        agentId = validateAgentId(readStringParam(params, "agent", { required: true }));
      } catch (err) {
        logAudit("validation_failed", {
          field: "agent",
          error: err instanceof Error ? err.message : String(err),
        });
        return jsonResult({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        } as AgentCallResult);
      }

      // Fix 10: Skill name validation
      let skill: string;
      try {
        skill = validateSkillName(skillRaw);
      } catch (err) {
        logAudit("validation_failed", {
          field: "skill",
          error: err instanceof Error ? err.message : String(err),
        });
        return jsonResult({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        } as AgentCallResult);
      }

      // Fix 3: Input size validation
      try {
        validateInputSize(input, MAX_A2A_INPUT_SIZE);
      } catch (err) {
        logAudit("validation_failed", {
          field: "input",
          error: err instanceof Error ? err.message : String(err),
        });
        return jsonResult({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        } as AgentCallResult);
      }

      const cfg = loadConfig();
      const { mainKey, alias } = resolveMainSessionAlias(cfg);
      const requesterSessionKey = opts?.agentSessionKey
        ? resolveInternalSessionKey({ key: opts.agentSessionKey, alias, mainKey })
        : undefined;

      // Resolve session keys
      const targetSessionKey = resolveAgentSessionKey(agentId);

      // Get agent IDs for policy check
      const requesterAgentId = requesterSessionKey?.split(":")[1] ?? "main";
      const targetAgentId = agentId;

      // Fix 2: Self-call prevention (infinite loop protection)
      if (requesterAgentId === targetAgentId) {
        logAudit("self_call_blocked", { agent: requesterAgentId, skill });
        return jsonResult({
          status: "error",
          error: "Self-call not allowed: agent cannot invoke itself (infinite loop prevention)",
        } as AgentCallResult);
      }

      // Check A2A policy
      const policy = checkA2APolicy(cfg, requesterAgentId, targetAgentId);
      if (!policy.allowed) {
        // Fix 7: Security audit logging for policy denial
        logAudit("policy_denied", { requester: requesterAgentId, target: targetAgentId, skill });
        return jsonResult({
          status: "forbidden",
          error: policy.error,
        } as AgentCallResult);
      }

      // Fix 7: Security audit logging for invocation
      logAudit("invocation", { requester: requesterAgentId, target: targetAgentId, skill });

      // Construct skill invocation message
      const skillInvocation = {
        kind: "skill_invocation",
        skill,
        input,
        mode,
        requester: requesterSessionKey,
      };

      const agentContext = buildAgentToAgentMessageContext({
        requesterSessionKey,
        requesterChannel: opts?.agentChannel,
        targetSessionKey,
      });

      const idempotencyKey = randomUUID();

      // Fire-and-forget mode (timeout=0)
      if (timeoutSeconds === 0) {
        try {
          await callGateway<{ runId: string }>({
            method: "agent",
            params: {
              message: JSON.stringify(skillInvocation),
              sessionKey: targetSessionKey,
              idempotencyKey,
              deliver: false,
              channel: INTERNAL_MESSAGE_CHANNEL,
              lane: AGENT_LANE_NESTED,
              extraSystemPrompt: agentContext,
              inputProvenance: {
                kind: "tool_invocation" as const,
                sourceSessionKey: requesterSessionKey,
                sourceTool: "agent_call",
                skill,
                mode,
              },
            },
            timeoutMs: 10_000,
          });

          return jsonResult({
            status: "working",
            taskId: idempotencyKey,
          } as AgentCallResult);
        } catch (err) {
          return jsonResult({
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          } as AgentCallResult);
        }
      }

      // Synchronous call with wait
      let runId: string = idempotencyKey;
      try {
        const response = await callGateway<{ runId: string }>({
          method: "agent",
          params: {
            message: JSON.stringify(skillInvocation),
            sessionKey: targetSessionKey,
            idempotencyKey,
            deliver: false,
            channel: INTERNAL_MESSAGE_CHANNEL,
            lane: AGENT_LANE_NESTED,
            extraSystemPrompt: agentContext,
            inputProvenance: {
              kind: "tool_invocation" as const,
              sourceSessionKey: requesterSessionKey,
              sourceTool: "agent_call",
              skill,
              mode,
            },
          },
          timeoutMs: 10_000,
        });
        if (typeof response?.runId === "string" && response.runId) {
          runId = response.runId;
        }
      } catch (err) {
        return jsonResult({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        } as AgentCallResult);
      }

      // Wait for completion
      let waitStatus: string | undefined;
      let waitError: string | undefined;
      try {
        const wait = await callGateway<{ status?: string; error?: string }>({
          method: "agent.wait",
          params: { runId, timeoutMs },
          timeoutMs: timeoutMs + 2000,
        });
        waitStatus = wait?.status;
        waitError = wait?.error;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return jsonResult({
          status: msg.includes("timeout") ? "working" : "error",
          error: msg,
          taskId: runId,
        } as AgentCallResult);
      }

      if (waitStatus === "timeout") {
        return jsonResult({
          status: "working",
          error: waitError,
          taskId: runId,
        } as AgentCallResult);
      }

      if (waitStatus === "error") {
        return jsonResult({
          status: "error",
          error: waitError ?? "agent error",
        } as AgentCallResult);
      }

      // Get result
      const history = await callGateway<{ messages: Array<unknown> }>({
        method: "chat.history",
        params: { sessionKey: targetSessionKey, limit: 50 },
      });

      const messages = Array.isArray(history?.messages) ? history.messages : [];
      const lastAssistant = messages.filter((m: any) => m?.role === "assistant").pop() as any;

      // Use canonical helper to extract text from content blocks
      const raw = extractAssistantText(lastAssistant) ?? "";

      // Validate that we got a response
      if (!lastAssistant || raw.trim() === "") {
        // Fix 6: Don't expose internal session keys in error messages
        return jsonResult({
          status: "error",
          error: "Agent returned empty or invalid response",
        } as AgentCallResult);
      }

      const { output, confidence, assumptions, caveats } = parseStructuredResponse(raw);

      return jsonResult({
        status: "completed",
        output,
        confidence,
        assumptions,
        caveats,
        taskId: runId,
      } as AgentCallResult);
    },
  };
}
