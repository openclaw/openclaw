/**
 * Debate Call Tool - Multi-agent debate orchestration
 *
 * Implements the Proposer → Critic → Resolver pattern for structured multi-agent reasoning.
 * Research shows: 3 critics, 2 rounds is optimal. Accuracy improves from 60% → 95%.
 *
 * Design based on:
 * - Multi-Agent Debate patterns (Schepis 2025)
 * - MARS hierarchical review (efficient multi-agent collaboration)
 * - EmergentMind critique & revision synthesis
 */

import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { AGENT_LANE_NESTED } from "../lanes.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, readNumberParam } from "./common.js";
import { extractAssistantText } from "./sessions-helpers.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
  validateAgentId,
  validateSkillName,
  validateAgentSessionKey,
  validateInputSize,
  boundConfidence,
  checkA2APolicy,
  isAgentSessionKeyRef,
  MAX_A2A_INPUT_SIZE,
} from "./sessions-helpers.js";
import { buildAgentToAgentMessageContext } from "./sessions-send-helpers.js";

// Security audit logging
const LOG_PREFIX = "[debate_call]";
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

// Maximum concurrent critic calls
const MAX_CONCURRENT_CRITICS = 3;

// Schema for a critic configuration
const CriticConfigSchema = Type.Object({
  agent: Type.String({ description: "Critic agent ID or session key" }),
  perspective: Type.Optional(Type.String({ description: "Perspective to apply during critique" })),
  skill: Type.Optional(
    Type.String({ description: "Critic skill to invoke (default: 'critique')" }),
  ),
  weight: Type.Optional(
    Type.Number({ minimum: 0, maximum: 1, description: "Confidence weight for this critic" }),
  ),
});

// Schema for proposer/resolver configuration
const AgentRefSchema = Type.Object({
  agent: Type.String({ description: "Agent ID or session key" }),
  skill: Type.String({ description: "Skill to invoke" }),
});

// Main tool schema
const DebateCallToolSchema = Type.Object({
  topic: Type.String({ description: "Topic/question to resolve through debate" }),
  proposer: AgentRefSchema,
  critics: Type.Array(CriticConfigSchema, {
    minItems: 1,
    maxItems: 10,
    description: "Critics to review proposals (max: 10)",
  }),
  resolver: AgentRefSchema,
  input: Type.Object(
    {},
    { additionalProperties: true, description: "Input data for the proposer" },
  ),
  rounds: Type.Optional(
    Type.Number({ minimum: 1, maximum: 5, description: "Number of critique rounds (default: 2)" }),
  ),
  minConfidence: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 1,
      description: "Stop when confidence >= threshold (default: 0.85)",
    }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 3600,
      description: "Per-agent timeout in seconds (max: 3600, 0 for fire-and-forget, default: 60)",
    }),
  ),
});

interface DebateRound {
  proposal: {
    output: unknown;
    confidence: number;
    assumptions: string[];
  };
  critiques: Array<{
    agent: string;
    output: unknown;
    flaws: string[];
    alternatives: string[];
    confidence: number;
  }>;
  refinement?: {
    output: unknown;
    confidence: number;
    addressedCritiques: string[];
  };
}

export interface DebateCallResult {
  status: "resolved" | "unresolved" | "error";
  conclusion: unknown;
  confidence: number;
  confidenceHistory: number[];
  rounds: DebateRound[];
  dissent?: string;
  assumptions: string[];
  correlationId?: string; // For response routing (RFC-A2A-RESPONSE-ROUTING)
}

/**
 * Invoke an agent skill and get structured output with confidence.
 *
 * Reuses sessions_send pattern but expects structured JSON response.
 */
async function invokeAgentSkill(params: {
  sessionKey: string;
  skill: string;
  input: unknown;
  mode?: "execute" | "critique";
  timeoutMs: number;
  requesterSessionKey?: string;
}): Promise<{ output: unknown; confidence: number; assumptions: string[]; raw: string }> {
  const idempotencyKey = randomUUID();

  // Fix 3: Input size validation
  validateInputSize(params.input, MAX_A2A_INPUT_SIZE);

  // Construct the message to send - includes skill invocation context
  // RFC-A2A-RESPONSE-ROUTING: Add correlationId, returnTo, timeout
  const correlationId = idempotencyKey;
  const timeoutMs = params.timeoutMs;

  const messageContext = {
    kind: "skill_invocation",
    skill: params.skill,
    input: params.input,
    mode: params.mode ?? "execute",
    requesterSession: params.requesterSessionKey,
    correlationId, // RFC: Matches request to response
    returnTo: params.requesterSessionKey, // RFC: Where to deliver response
    timeout: timeoutMs, // RFC: Per-call timeout
  };

  const agentContext = buildAgentToAgentMessageContext({
    requesterSessionKey: params.requesterSessionKey,
    requesterChannel: undefined,
    targetSessionKey: params.sessionKey,
  });

  const response = await callGateway<{ runId: string }>({
    method: "agent",
    params: {
      message: JSON.stringify(messageContext),
      sessionKey: params.sessionKey,
      idempotencyKey,
      deliver: false,
      lane: AGENT_LANE_NESTED,
      extraSystemPrompt: agentContext,
      // Include skill invocation hint in provenance
      inputProvenance: {
        kind: "tool_invocation" as const,
        sourceSessionKey: params.requesterSessionKey,
        sourceTool: "debate_call",
        skill: params.skill,
        mode: params.mode ?? "execute",
      },
    },
    timeoutMs: 10_000,
  });

  const runId = response?.runId ?? idempotencyKey;

  // Wait for completion with status check
  const waitResult = await callGateway<{ status: string; error?: string }>({
    method: "agent.wait",
    params: { runId, timeoutMs: params.timeoutMs },
    timeoutMs: params.timeoutMs + 2000,
  });

  // P1 fix: Check wait status before reading history to avoid stale data
  if (waitResult?.status !== "ok" && waitResult?.status !== "completed") {
    throw new Error(
      waitResult?.error ?? `Agent wait failed with status: ${waitResult?.status ?? "unknown"}`,
    );
  }

  // Get response
  const history = await callGateway<{ messages: Array<unknown> }>({
    method: "chat.history",
    params: { sessionKey: params.sessionKey, limit: 10 },
  });

  const messages = Array.isArray(history?.messages) ? history.messages : [];
  const lastAssistant = messages
    .filter((m: unknown) => (m as { role?: string })?.role === "assistant")
    .pop() as { content?: unknown } | undefined;

  // Use canonical helper to extract text from content blocks
  const raw = extractAssistantText(lastAssistant) ?? "";

  // Validate that we got a response
  if (!lastAssistant || raw.trim() === "") {
    // Fix 6: Don't expose internal session keys in error messages
    throw new Error("Agent returned empty or invalid response");
  }

  // Parse structured output
  // Expect format: JSON with output, confidence, assumptions
  let output: unknown;
  let confidence = 0.5;
  let assumptions: string[] = [];

  try {
    // Try to extract JSON from response
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      output = parsed.output ?? parsed;
      // Fix 4: Bound confidence to [0, 1]
      const rawConfidence = typeof parsed.confidence === "number" ? parsed.confidence : 0.5;
      confidence = boundConfidence(rawConfidence);
      assumptions = Array.isArray(parsed.assumptions)
        ? parsed.assumptions
        : typeof parsed.assumptions === "string"
          ? [parsed.assumptions]
          : [];
    } else {
      output = raw;
      confidence = 0.5; // Default for unstructured response
    }
  } catch (err) {
    // Log parsing failures in development mode
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        `[debate_call] Failed to parse agent response JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    output = raw;
    confidence = 0.3; // Lower confidence for failed parse
  }

  return { output, confidence: boundConfidence(confidence), assumptions, raw };
}

/**
 * Resolve agent reference to session key.
 *
 * Supports both agent IDs (e.g., "rca-agent") and full session keys.
 * Validates both formats strictly.
 */
async function resolveAgentSession(agentRef: string, _requesterAgentId: string): Promise<string> {
  // If it looks like a session key, validate and use it directly
  if (isAgentSessionKeyRef(agentRef)) {
    return validateAgentSessionKey(agentRef);
  }

  // Otherwise, validate as agent ID and resolve to main session
  const normalized = validateAgentId(agentRef);
  return `agent:${normalized}:main`;
}

export function createDebateCallTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
}): AnyAgentTool {
  return {
    label: "Debate",
    name: "debate_call",
    description:
      "Orchestrate multi-agent debate with proposer, critics, and resolver. " +
      "Returns structured conclusion with confidence trace. " +
      "Optimal: 3 critics, 2 rounds for 60% → 95% accuracy improvement.",
    parameters: DebateCallToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const topic = readStringParam(params, "topic", { required: true });
      const proposer = params.proposer as { agent: string; skill: string };
      const critics = params.critics as Array<{
        agent: string;
        perspective?: string;
        skill?: string;
        weight?: number;
      }>;
      const resolver = params.resolver as { agent: string; skill: string };
      const input = params.input as Record<string, unknown>;
      const maxRounds = readNumberParam(params, "rounds") ?? 2;
      const minConfidence = readNumberParam(params, "minConfidence") ?? 0.85;
      const timeoutSeconds = readNumberParam(params, "timeoutSeconds") ?? 60;
      const timeoutMs = timeoutSeconds * 1000;

      // RFC-A2A-RESPONSE-ROUTING: Generate correlation ID for this debate
      const correlationId = randomUUID();

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
          conclusion: null,
          confidence: 0,
          confidenceHistory: [],
          rounds: [],
          assumptions: [],
          error: err instanceof Error ? err.message : String(err),
        } as DebateCallResult);
      }

      // Fix 10: Skill name validation for proposer, critics, and resolver
      let proposerSkill: string;
      let resolverSkill: string;
      const criticSkills: string[] = [];

      try {
        proposerSkill = validateSkillName(proposer.skill);
        resolverSkill = validateSkillName(resolver.skill);
        for (const critic of critics) {
          const skillName = critic.skill || "critique";
          criticSkills.push(validateSkillName(skillName));
        }
      } catch (err) {
        logAudit("validation_failed", {
          field: "skill",
          error: err instanceof Error ? err.message : String(err),
        });
        return jsonResult({
          status: "error",
          conclusion: null,
          confidence: 0,
          confidenceHistory: [],
          rounds: [],
          assumptions: [],
          error: err instanceof Error ? err.message : String(err),
        } as DebateCallResult);
      }

      const cfg = loadConfig();
      const { mainKey, alias } = resolveMainSessionAlias(cfg);
      const requesterSessionKey = opts?.agentSessionKey
        ? resolveInternalSessionKey({ key: opts.agentSessionKey, alias, mainKey })
        : undefined;

      // Fix 5: Use checkA2APolicy for all agents in the debate
      const requesterAgentId = requesterSessionKey?.split(":")[1] ?? "main";
      const targetAgents = [proposer.agent, ...critics.map((c) => c.agent), resolver.agent];

      for (const targetAgent of targetAgents) {
        let targetId: string;
        try {
          // Extract agent ID from session key or use directly
          if (isAgentSessionKeyRef(targetAgent)) {
            targetId = validateAgentSessionKey(targetAgent).split(":")[1];
          } else {
            targetId = validateAgentId(targetAgent);
          }
        } catch (err) {
          logAudit("validation_failed", {
            field: "agent",
            error: err instanceof Error ? err.message : String(err),
          });
          return jsonResult({
            status: "error",
            conclusion: null,
            confidence: 0,
            confidenceHistory: [],
            rounds: [],
            assumptions: [],
            error: `Invalid agent reference: ${err instanceof Error ? err.message : String(err)}`,
          } as DebateCallResult);
        }

        // Fix 2: Self-call prevention (debate participant cannot be requester)
        if (requesterAgentId === targetId) {
          logAudit("self_call_blocked", { agent: requesterAgentId });
          return jsonResult({
            status: "error",
            conclusion: null,
            confidence: 0,
            confidenceHistory: [],
            rounds: [],
            assumptions: [],
            error: `Self-call not allowed: agent '${requesterAgentId}' cannot participate in its own debate (infinite loop prevention)`,
          } as DebateCallResult);
        }

        // Check A2A policy
        const policy = checkA2APolicy(cfg, requesterAgentId, targetId);
        if (!policy.allowed) {
          // Fix 7: Security audit logging for policy denial
          logAudit("policy_denied", { requester: requesterAgentId, target: targetId });
          return jsonResult({
            status: "error",
            conclusion: null,
            confidence: 0,
            confidenceHistory: [],
            rounds: [],
            assumptions: [],
            error: policy.error,
          } as DebateCallResult);
        }
      }

      // Fix 7: Security audit logging for invocation
      logAudit("invocation", {
        requester: requesterAgentId,
        targets: targetAgents,
        proposerSkill,
        criticSkills,
        resolverSkill,
      });

      const rounds: DebateRound[] = [];
      let currentProposal: unknown = null;
      let currentConfidence = 0;
      let currentAssumptions: string[] = [];
      const confidenceHistory: number[] = [];

      try {
        // Resolve all session keys
        const proposerSession = await resolveAgentSession(
          proposer.agent,
          requesterSessionKey ?? "main",
        );
        const criticSessions = await Promise.all(
          critics.map((c) => resolveAgentSession(c.agent, requesterSessionKey ?? "main")),
        );
        const resolverSession = await resolveAgentSession(
          resolver.agent,
          requesterSessionKey ?? "main",
        );

        // Round 0: Initial proposal
        const initialResult = await invokeAgentSkill({
          sessionKey: proposerSession,
          skill: proposerSkill,
          input,
          timeoutMs,
          requesterSessionKey,
        });

        currentProposal = initialResult.output;
        currentConfidence = initialResult.confidence;
        currentAssumptions = initialResult.assumptions;
        confidenceHistory.push(currentConfidence);

        // Check if we can stop early (very high confidence)
        if (currentConfidence >= 0.95) {
          const conclusion = await invokeAgentSkill({
            sessionKey: resolverSession,
            skill: resolverSkill,
            input: { topic, finalProposal: currentProposal, rounds },
            timeoutMs,
            requesterSessionKey,
          });

          return jsonResult({
            status: "resolved",
            conclusion: conclusion.output,
            confidence: conclusion.confidence,
            confidenceHistory,
            rounds,
            assumptions: Array.from(new Set([...currentAssumptions, ...conclusion.assumptions])),
          } as DebateCallResult);
        }

        // Critique rounds
        for (let round = 0; round < maxRounds; round++) {
          // Fix 8: Concurrency limit for critics - run in batches
          const runCriticsInBatches = async (
            criticList: typeof critics,
            sessions: string[],
            maxConcurrent: number,
          ) => {
            const results: Array<{
              agent: string;
              output: unknown;
              flaws: string[];
              alternatives: string[];
              confidence: number;
            }> = [];

            for (let i = 0; i < criticList.length; i += maxConcurrent) {
              const batch = criticList.slice(i, i + maxConcurrent);
              const batchSessions = sessions.slice(i, i + maxConcurrent);
              const batchSkills = criticSkills.slice(i, i + maxConcurrent);

              const batchResults = await Promise.all(
                batch.map(async (critic, batchIdx) => {
                  const _globalIdx = i + batchIdx;
                  try {
                    const result = await invokeAgentSkill({
                      sessionKey: batchSessions[batchIdx],
                      skill: batchSkills[batchIdx],
                      input: {
                        proposal: currentProposal,
                        perspective: critic.perspective,
                        round: round + 1,
                      },
                      mode: "critique",
                      timeoutMs,
                      requesterSessionKey,
                    });

                    // Safely extract flaws and alternatives from output
                    const outputObj = result.output as Record<string, unknown> | null | undefined;
                    const flawsArr = outputObj?.flaws;
                    const altArr = outputObj?.alternatives;
                    const flaws = Array.isArray(flawsArr) ? ([...flawsArr] as string[]) : [];
                    const alternatives = Array.isArray(altArr) ? ([...altArr] as string[]) : [];

                    return {
                      agent: critic.agent,
                      output: result.output,
                      flaws,
                      alternatives,
                      confidence: result.confidence,
                    };
                  } catch (err) {
                    return {
                      agent: critic.agent,
                      output: null,
                      flaws: [
                        `Critic failed: ${err instanceof Error ? err.message : "Unknown error"}`,
                      ],
                      alternatives: [],
                      confidence: 0,
                    };
                  }
                }),
              );

              results.push(...batchResults);
            }

            return results;
          };

          const critiques = await runCriticsInBatches(
            critics,
            criticSessions,
            MAX_CONCURRENT_CRITICS,
          );

          // Fix 9: Minimum critic success threshold
          const successfulCritiques = critiques.filter((c) => c.confidence > 0);
          if (successfulCritiques.length === 0) {
            return jsonResult({
              status: "error",
              conclusion: null,
              confidence: 0,
              confidenceHistory,
              rounds,
              error: "All critics failed - cannot proceed with resolution",
              assumptions: [],
            } as DebateCallResult);
          }

          // Check if we can stop early (high confidence after critique consideration)
          if (currentConfidence >= minConfidence) {
            rounds.push({
              proposal: {
                output: currentProposal,
                confidence: currentConfidence,
                assumptions: currentAssumptions,
              },
              critiques,
              refinement: undefined,
            });
            break;
          }

          // Refine based on critiques
          const refinement = await invokeAgentSkill({
            sessionKey: proposerSession,
            skill: "refine", // Standard refinement skill
            input: {
              originalProposal: currentProposal,
              critiques: critiques.map((c) => ({
                agent: c.agent,
                flaws: c.flaws,
                alternatives: c.alternatives,
              })),
              addressedConcerns:
                rounds.length > 0 ? rounds[rounds.length - 1]?.refinement?.addressedCritiques : [],
            },
            timeoutMs,
            requesterSessionKey,
          });

          currentProposal = refinement.output;
          currentConfidence = refinement.confidence;
          currentAssumptions = [...currentAssumptions, ...refinement.assumptions];
          confidenceHistory.push(currentConfidence);

          rounds.push({
            proposal: {
              output: currentProposal,
              confidence: currentConfidence,
              assumptions: currentAssumptions,
            },
            critiques,
            refinement: {
              output: refinement.output,
              confidence: refinement.confidence,
              addressedCritiques: critiques.flatMap((c) => c.flaws).slice(0, 3),
            },
          });

          // Check early stop after refinement
          if (currentConfidence >= minConfidence) {
            break;
          }
        }

        // Final resolution
        const resolution = await invokeAgentSkill({
          sessionKey: resolverSession,
          skill: resolverSkill,
          input: {
            topic,
            finalProposal: currentProposal,
            debateHistory: rounds,
            assumptions: currentAssumptions,
          },
          timeoutMs,
          requesterSessionKey,
        });

        const finalConfidence = resolution.confidence;

        return jsonResult({
          status: finalConfidence >= minConfidence ? "resolved" : "unresolved",
          conclusion: resolution.output,
          confidence: finalConfidence,
          confidenceHistory: [...confidenceHistory, finalConfidence],
          rounds,
          dissent:
            typeof (resolution.output as Record<string, unknown> | null)?.dissent === "string"
              ? ((resolution.output as Record<string, unknown>).dissent as string)
              : undefined,
          assumptions: Array.from(new Set([...currentAssumptions, ...resolution.assumptions])),
          correlationId, // RFC: For response routing
        } as DebateCallResult);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return jsonResult({
          status: "error",
          conclusion: null,
          confidence: 0,
          confidenceHistory,
          rounds,
          error: errorMsg,
          assumptions: [],
          correlationId, // RFC: For response routing
        } as DebateCallResult);
      }
    },
  };
}
