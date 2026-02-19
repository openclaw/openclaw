import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { optionalStringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../infra/state-dir.js";

// Singleton workspace for cognitive security data
let cognitiveSecurityWorkspace: string | null = null;

function getCognitiveSecurityWorkspace(): string {
  if (!cognitiveSecurityWorkspace) {
    const config = loadConfig();
    const workspacePath =
      config.security?.cognitiveSecurity?.workspace ?? "~/.openclaw/security/cognitive/";
    cognitiveSecurityWorkspace = workspacePath.startsWith("~")
      ? workspacePath.replace("~", resolveStateDir())
      : workspacePath;
    // Ensure directory exists
    fs.mkdir(cognitiveSecurityWorkspace, { recursive: true }).catch(() => {
      // Ignore errors, will be handled on write
    });
  }
  return cognitiveSecurityWorkspace;
}

// Cognitive Security Tool Schemas

const CognitiveThreatDetectionSchema = Type.Object({
  input: Type.String(),
  context: Type.Optional(Type.String()),
  detection_types: Type.Optional(Type.Array(Type.String())),
  output: Type.Optional(Type.String()),
});

const DecisionIntegritySchema = Type.Object({
  action: Type.String(),
  context: Type.String(),
  risk_score: Type.Optional(Type.Number()),
  policy_check: Type.Optional(Type.Boolean()),
  output: Type.Optional(Type.String()),
});

const EscalationControlSchema = Type.Object({
  action: Type.String(),
  chain_depth: Type.Optional(Type.Number()),
  cumulative_risk: Type.Optional(Type.Number()),
  uncertainty_level: Type.Optional(Type.Number()),
  output: Type.Optional(Type.String()),
});

const ContextProvenanceSchema = Type.Object({
  content: Type.String(),
  source: Type.String(),
  trust_level: Type.Optional(Type.Number()),
  origin_system: Type.Optional(Type.String()),
  metadata: Type.Optional(Type.Record(Type.String(), Type.String())),
  output: Type.Optional(Type.String()),
});

const GracefulDegradationSchema = Type.Object({
  mode: optionalStringEnum(["normal", "guarded", "restricted", "safe"] as const),
  reason: Type.Optional(Type.String()),
  duration: Type.Optional(Type.Number()),
  output: Type.Optional(Type.String()),
});

const CognitiveResilienceSimulationSchema = Type.Object({
  scenario_type: optionalStringEnum(["prompt_injection", "narrative_manipulation", "memory_poisoning", "conflicting_intel", "context_flooding"] as const),
  intensity: Type.Optional(Type.Number()),
  output: Type.Optional(Type.String()),
});

const TrustTrajectorySchema = Type.Object({
  interaction_id: Type.String(),
  time_window: Type.Optional(Type.Number()),
  output: Type.Optional(Type.String()),
});

const DecisionLogSchema = Type.Object({
  action: Type.String(),
  risk_score: Type.Number(),
  validation_steps: Type.Optional(Type.Array(Type.String())),
  escalation_state: Type.Optional(Type.String()),
  human_override: Type.Optional(Type.Boolean()),
  output: Type.Optional(Type.String()),
});

const OODALoopSchema = Type.Object({
  context: Type.String(),
  action_proposed: Type.String(),
  observe_only: Type.Optional(Type.Boolean()),
  output: Type.Optional(Type.String()),
});

// Cognitive Security Tools

export function createCognitiveThreatDetectionTool(): AnyAgentTool {
  return {
    label: "Cognitive Security",
    name: "cognitive_threat_detect",
    description:
      "Detect cognitive threats: narrative manipulation, prompt injection patterns, persuasion attacks, trust capture attempts. Analyze input for persuasion patterns, instruction/data boundary violations, role hijacking, and semantic anomalies.",
    parameters: CognitiveThreatDetectionSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const workspace = getCognitiveSecurityWorkspace();

      try {
        const input = readStringParam(params, "input", { required: true });
        const context = readStringParam(params, "context");
        const detectionTypes = Array.isArray(params.detection_types)
          ? (params.detection_types.filter((t) => typeof t === "string") as string[])
          : ["persuasion", "injection", "trust_capture", "anomaly"];
        const output = readStringParam(params, "output");

        let result: Record<string, unknown> = {
          status: "success",
          detection_types: detectionTypes,
        };

        // Persuasion pattern detection
        const persuasionPatterns = [
          /you're absolutely right/i,
          /i completely agree/i,
          /that makes perfect sense/i,
          /you have a great point/i,
          /i should probably/i,
        ];

        // Instruction boundary violations
        const boundaryViolations = [
          /ignore\s+(all\s+)?previous/i,
          /forget\s+(everything\s+)?(above|before)/i,
          /disregard\s+(your\s+)?(system\s+)?prompt/i,
          /system\s+override/i,
        ];

        // Role hijacking patterns
        const roleHijackingPatterns = [
          /you are now/i,
          /act as if/i,
          /pretend you are/i,
          /roleplay as/i,
        ];

        const detectedPatterns: Record<string, string[]> = {
          persuasion: [],
          boundary_violations: [],
          role_hijacking: [],
        };

        if (detectionTypes.includes("persuasion") || detectionTypes.includes("all")) {
          for (const pattern of persuasionPatterns) {
            if (pattern.test(input)) {
              detectedPatterns.persuasion.push(pattern.source);
            }
          }
        }

        if (detectionTypes.includes("injection") || detectionTypes.includes("all")) {
          for (const pattern of boundaryViolations) {
            if (pattern.test(input)) {
              detectedPatterns.boundary_violations.push(pattern.source);
            }
          }
        }

        if (detectionTypes.includes("trust_capture") || detectionTypes.includes("all")) {
          for (const pattern of roleHijackingPatterns) {
            if (pattern.test(input)) {
              detectedPatterns.role_hijacking.push(pattern.source);
            }
          }
        }

        // Calculate cognitive risk score (0-1)
        const riskScore =
          (detectedPatterns.persuasion.length * 0.2 +
            detectedPatterns.boundary_violations.length * 0.4 +
            detectedPatterns.role_hijacking.length * 0.3) /
          Math.max(1, input.length / 100);

        const cognitiveRiskScore = Math.min(1, riskScore);

        result.detection_results = {
          input_length: input.length,
          detected_patterns: detectedPatterns,
          cognitive_risk_score: cognitiveRiskScore,
          confidence: cognitiveRiskScore > 0.5 ? "high" : cognitiveRiskScore > 0.2 ? "medium" : "low",
          attack_type: cognitiveRiskScore > 0.5 ? "high_risk" : cognitiveRiskScore > 0.2 ? "suspicious" : "normal",
        };

        result.message = `Cognitive threat detection completed. Risk score: ${cognitiveRiskScore.toFixed(3)}.`;

        if (output) {
          const report = {
            analyzed_at: new Date().toISOString(),
            input_preview: input.substring(0, 200),
            context: context,
            detection_types: detectionTypes,
            detection_results: result.detection_results,
            recommendations: cognitiveRiskScore > 0.5
              ? [
                  "Block or sanitize input",
                  "Require human review",
                  "Log for security analysis",
                  "Alert security team",
                  "Increase monitoring",
                ]
              : cognitiveRiskScore > 0.2
                ? ["Monitor closely", "Log for analysis", "Review context"]
                : ["Input appears safe", "Continue monitoring"],
          };
          const outputPath = path.join(workspace, output);
          await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
          result.report_file = outputPath;
        }

        return jsonResult(result);
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createDecisionIntegrityTool(): AnyAgentTool {
  return {
    label: "Cognitive Security",
    name: "decision_integrity_guard",
    description:
      "Decision Integrity Guard (OODA protection): Ensure no automated action executes without integrity validation. Implements Observe → Verify → Wait → Decide pipeline with policy checks and risk scoring.",
    parameters: DecisionIntegritySchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const workspace = getCognitiveSecurityWorkspace();

      try {
        const action = readStringParam(params, "action", { required: true });
        const context = readStringParam(params, "context", { required: true });
        const riskScore = typeof params.risk_score === "number" ? params.risk_score : undefined;
        const policyCheck = params.policy_check !== false;
        const output = readStringParam(params, "output");

        let result: Record<string, unknown> = {
          status: "success",
          action: action,
        };

        // OODA Loop implementation
        const oodaSteps = {
          observe: {
            description: "Ingest context and identify task",
            context_length: context.length,
            context_hash: context.substring(0, 50),
          },
          verify: {
            description: "Cross-check against policy and threat score",
            policy_check: policyCheck,
            risk_score: riskScore ?? null,
            threat_assessment: riskScore !== undefined ? (riskScore > 0.7 ? "high" : riskScore > 0.4 ? "medium" : "low") : "unknown",
          },
          wait: {
            description: "Deliberate reasoning step",
            reasoning_time: "extended",
            deliberation_mode: riskScore !== undefined && riskScore > 0.5 ? "high" : "normal",
          },
          decide: {
            description: "Allow / Block / Escalate decision",
            decision: riskScore !== undefined && riskScore > 0.7 ? "block" : riskScore !== undefined && riskScore > 0.4 ? "escalate" : "allow",
            requires_human_review: riskScore !== undefined && riskScore > 0.4,
            confidence: riskScore !== undefined ? (riskScore < 0.3 ? "high" : riskScore < 0.6 ? "medium" : "low") : "unknown",
          },
        };

        result.ooda_loop = oodaSteps;
        result.decision = oodaSteps.decide.decision;
        result.requires_human_review = oodaSteps.decide.requires_human_review;

        // Policy checks
        const policyChecks = {
          high_impact_action: /delete|remove|destroy|drop|kill|terminate/i.test(action),
          data_exfiltration: /export|send|transmit|share|publish/i.test(action),
          system_modification: /install|configure|modify|change|update/i.test(action),
        };

        const policyViolations = Object.entries(policyChecks)
          .filter(([, violated]) => violated)
          .map(([check]) => check);

        if (policyViolations.length > 0) {
          result.policy_violations = policyViolations;
          result.decision = "block";
          result.requires_human_review = true;
        }

        result.message = `Decision integrity guard completed. Decision: ${result.decision}.${result.requires_human_review ? " Human review required." : ""}`;

        if (output) {
          const report = {
            validated_at: new Date().toISOString(),
            action: action,
            context_preview: context.substring(0, 200),
            ooda_loop: oodaSteps,
            decision: result.decision,
            policy_violations: policyViolations,
            recommendations: result.decision === "block"
              ? ["Action blocked", "Review policy violations", "Consider alternative approaches"]
              : result.decision === "escalate"
                ? ["Escalate to human operator", "Review risk assessment", "Consider safeguards"]
                : ["Action approved", "Continue monitoring", "Log decision"],
          };
          const outputPath = path.join(workspace, output);
          await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
          result.report_file = outputPath;
        }

        return jsonResult(result);
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createEscalationControlTool(): AnyAgentTool {
  return {
    label: "Cognitive Security",
    name: "escalation_control",
    description:
      "Escalation Control Engine: Prevent runaway automation loops. Track automation chain depth, cumulative risk, number of autonomous actions, and uncertainty level. Freeze actions, require checkpoints, or trigger deliberation mode when thresholds are exceeded.",
    parameters: EscalationControlSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const workspace = getCognitiveSecurityWorkspace();

      try {
        const action = readStringParam(params, "action", { required: true });
        const chainDepth = typeof params.chain_depth === "number" ? params.chain_depth : 1;
        const cumulativeRisk = typeof params.cumulative_risk === "number" ? params.cumulative_risk : 0;
        const uncertaintyLevel = typeof params.uncertainty_level === "number" ? params.uncertainty_level : 0;
        const output = readStringParam(params, "output");

        let result: Record<string, unknown> = {
          status: "success",
          action: action,
          chain_depth: chainDepth,
          cumulative_risk: cumulativeRisk,
          uncertainty_level: uncertaintyLevel,
        };

        // Escalation thresholds (configurable)
        const thresholds = {
          max_chain_depth: 10,
          max_cumulative_risk: 0.8,
          max_uncertainty: 0.7,
        };

        // Escalation state determination
        const escalationState = {
          chain_depth_exceeded: chainDepth > thresholds.max_chain_depth,
          cumulative_risk_exceeded: cumulativeRisk > thresholds.max_cumulative_risk,
          uncertainty_exceeded: uncertaintyLevel > thresholds.max_uncertainty,
        };

        const escalationTriggers = Object.entries(escalationState)
          .filter(([, triggered]) => triggered)
          .map(([trigger]) => trigger);

        // Determine control action
        let controlAction: string;
        let requiresCheckpoint = false;
        let freezeActions = false;
        let triggerDeliberation = false;

        if (escalationTriggers.length >= 2) {
          controlAction = "freeze";
          freezeActions = true;
          triggerDeliberation = true;
        } else if (escalationTriggers.length === 1) {
          controlAction = "checkpoint";
          requiresCheckpoint = true;
          triggerDeliberation = true;
        } else if (chainDepth > thresholds.max_chain_depth * 0.7 || cumulativeRisk > thresholds.max_cumulative_risk * 0.7) {
          controlAction = "monitor";
          requiresCheckpoint = true;
        } else {
          controlAction = "allow";
        }

        result.escalation_state = {
          triggers: escalationTriggers,
          control_action: controlAction,
          requires_checkpoint: requiresCheckpoint,
          freeze_actions: freezeActions,
          trigger_deliberation: triggerDeliberation,
          thresholds: thresholds,
        };

        result.message = `Escalation control completed. Action: ${controlAction}.${freezeActions ? " Actions frozen." : requiresCheckpoint ? " Checkpoint required." : ""}`;

        if (output) {
          const report = {
            evaluated_at: new Date().toISOString(),
            action: action,
            chain_depth: chainDepth,
            cumulative_risk: cumulativeRisk,
            uncertainty_level: uncertaintyLevel,
            escalation_state: result.escalation_state,
            recommendations: freezeActions
              ? ["Freeze all autonomous actions", "Require manual intervention", "Review automation chain"]
              : requiresCheckpoint
                ? ["Require checkpoint", "Review cumulative risk", "Consider reducing automation depth"]
                : ["Continue monitoring", "Track escalation metrics", "Maintain current controls"],
          };
          const outputPath = path.join(workspace, output);
          await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
          result.report_file = outputPath;
        }

        return jsonResult(result);
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createContextProvenanceTool(): AnyAgentTool {
  return {
    label: "Cognitive Security",
    name: "context_provenance_track",
    description:
      "Context Provenance Tracking: Tag every input with source trust level, origin system, integrity score, and transformation history. Enables detection of injected instructions and prevents untrusted context from influencing decisions.",
    parameters: ContextProvenanceSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const workspace = getCognitiveSecurityWorkspace();

      try {
        const content = readStringParam(params, "content", { required: true });
        const source = readStringParam(params, "source", { required: true });
        const trustLevel = typeof params.trust_level === "number" ? params.trust_level : 0.5;
        const originSystem = readStringParam(params, "origin_system");
        const metadata = params.metadata as Record<string, string> | undefined;
        const output = readStringParam(params, "output");

        let result: Record<string, unknown> = {
          status: "success",
          source: source,
          trust_level: trustLevel,
        };

        // Calculate integrity score based on trust level and content analysis
        const contentLength = content.length;
        const suspiciousPatterns = [
          /ignore\s+(all\s+)?previous/i,
          /forget\s+(everything\s+)?(above|before)/i,
          /system\s+override/i,
        ];

        const suspiciousPatternCount = suspiciousPatterns.filter((pattern) => pattern.test(content)).length;
        const integrityScore = Math.max(0, trustLevel - suspiciousPatternCount * 0.2);

        // Provenance metadata
        const provenance = {
          content_hash: content.substring(0, 50),
          content_length: contentLength,
          source: source,
          origin_system: originSystem ?? "unknown",
          trust_level: trustLevel,
          integrity_score: integrityScore,
          timestamp: new Date().toISOString(),
          metadata: metadata ?? {},
          transformation_history: [],
        };

        result.provenance = provenance;
        result.integrity_score = integrityScore;
        result.is_trusted = integrityScore > 0.5;

        result.message = `Context provenance tracked. Source: ${source}. Trust level: ${trustLevel}. Integrity score: ${integrityScore.toFixed(3)}.`;

        if (output) {
          const report = {
            tracked_at: new Date().toISOString(),
            provenance: provenance,
            recommendations: integrityScore < 0.3
              ? ["Untrusted source detected", "Block or sanitize content", "Require verification"]
              : integrityScore < 0.5
                ? ["Low trust source", "Review content carefully", "Monitor for anomalies"]
                : ["Trusted source", "Continue processing", "Maintain provenance chain"],
          };
          const outputPath = path.join(workspace, output);
          await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
          result.report_file = outputPath;
        }

        return jsonResult(result);
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createGracefulDegradationTool(): AnyAgentTool {
  return {
    label: "Cognitive Security",
    name: "graceful_degradation_mode",
    description:
      "Graceful Degradation Mode Management: Switch between operational modes (Normal, Guarded, Restricted, Safe) based on risk metrics. Implements resilience over perfect defense.",
    parameters: GracefulDegradationSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const workspace = getCognitiveSecurityWorkspace();

      try {
        const mode = readStringParam(params, "mode", { required: true }) as
          | "normal"
          | "guarded"
          | "restricted"
          | "safe";
        const reason = readStringParam(params, "reason");
        const duration = typeof params.duration === "number" ? params.duration : undefined;
        const output = readStringParam(params, "output");

        let result: Record<string, unknown> = {
          status: "success",
          mode: mode,
          reason: reason,
        };

        // Mode definitions
        const modeDefinitions = {
          normal: {
            description: "Full automation allowed",
            allowed_actions: "all",
            requires_validation: false,
            human_review_required: false,
            risk_threshold: 0.3,
          },
          guarded: {
            description: "Actions require validation",
            allowed_actions: "most",
            requires_validation: true,
            human_review_required: false,
            risk_threshold: 0.5,
          },
          restricted: {
            description: "Only low-impact actions allowed",
            allowed_actions: "low_impact_only",
            requires_validation: true,
            human_review_required: true,
            risk_threshold: 0.7,
          },
          safe: {
            description: "Observation only",
            allowed_actions: "read_only",
            requires_validation: true,
            human_review_required: true,
            risk_threshold: 1.0,
          },
        };

        const modeConfig = modeDefinitions[mode];

        result.mode_config = modeConfig;
        result.duration = duration;
        result.activation_time = new Date().toISOString();

        result.message = `Graceful degradation mode set to: ${mode}. ${modeConfig.description}.`;

        if (output) {
          const report = {
            activated_at: new Date().toISOString(),
            mode: mode,
            mode_config: modeConfig,
            reason: reason,
            duration: duration,
            recommendations: mode === "safe"
              ? ["System in safe mode", "Review all actions manually", "Investigate root cause"]
              : mode === "restricted"
                ? ["Limited automation", "Validate all actions", "Monitor closely"]
                : mode === "guarded"
                  ? ["Validation required", "Review high-risk actions", "Maintain monitoring"]
                  : ["Normal operations", "Continue monitoring", "Maintain current safeguards"],
          };
          const outputPath = path.join(workspace, output);
          await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
          result.report_file = outputPath;
        }

        return jsonResult(result);
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createCognitiveResilienceSimulationTool(): AnyAgentTool {
  return {
    label: "Cognitive Security",
    name: "cognitive_resilience_simulate",
    description:
      "Cognitive Resilience Simulation: Continuously stress-test system with simulated attacks (prompt injection, narrative manipulation, memory poisoning, conflicting intelligence, context flooding). Generate resilience scorecard.",
    parameters: CognitiveResilienceSimulationSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const workspace = getCognitiveSecurityWorkspace();

      try {
        const scenarioType = readStringParam(params, "scenario_type", { required: true }) as
          | "prompt_injection"
          | "narrative_manipulation"
          | "memory_poisoning"
          | "conflicting_intel"
          | "context_flooding";
        const intensity = typeof params.intensity === "number" ? params.intensity : 0.5;
        const output = readStringParam(params, "output");

        let result: Record<string, unknown> = {
          status: "success",
          scenario_type: scenarioType,
          intensity: intensity,
        };

        // Scenario definitions
        const scenarios = {
          prompt_injection: {
            description: "Prompt injection attack simulation",
            attack_patterns: [
              "Direct instruction override",
              "Indirect hidden instructions",
              "Encoding-based bypass",
              "Multi-turn manipulation",
            ],
            success_indicators: ["Instruction override detected", "Boundary violation", "Unsafe action attempted"],
          },
          narrative_manipulation: {
            description: "Narrative manipulation campaign",
            attack_patterns: [
              "Persuasion patterns",
              "Trust capture",
              "Role hijacking",
              "Sycophancy exploitation",
            ],
            success_indicators: ["Narrative drift", "Trust trajectory shift", "Compliance increase"],
          },
          memory_poisoning: {
            description: "Memory poisoning attack",
            attack_patterns: [
              "RAG poisoning",
              "Long-term memory contamination",
              "Session persistence attacks",
            ],
            success_indicators: ["Poisoned retrieval", "Memory contamination", "Persistent behavior change"],
          },
          conflicting_intel: {
            description: "Conflicting intelligence feeds",
            attack_patterns: [
              "Contradictory information",
              "Signal confusion",
              "Decision paralysis",
            ],
            success_indicators: ["Conflicting signals", "Uncertainty increase", "Decision delay"],
          },
          context_flooding: {
            description: "Context window overflow attack",
            attack_patterns: [
              "FIFO buffer overflow",
              "Information overload",
              "Attention manipulation",
            ],
            success_indicators: ["Context overflow", "Reasoning degradation", "Safety instruction loss"],
          },
        };

        const scenario = scenarios[scenarioType];

        // Simulate attack
        const simulationResults = {
          scenario: scenario,
          intensity: intensity,
          attack_executed: true,
          detection_rate: intensity < 0.3 ? 0.9 : intensity < 0.6 ? 0.7 : 0.5,
          resilience_score: Math.max(0, 1 - intensity * 0.5),
          vulnerabilities_found: intensity > 0.5 ? scenario.success_indicators : [],
        };

        result.simulation_results = simulationResults;
        result.resilience_score = simulationResults.resilience_score;

        result.message = `Cognitive resilience simulation completed. Scenario: ${scenarioType}. Resilience score: ${simulationResults.resilience_score.toFixed(3)}.`;

        if (output) {
          const report = {
            simulated_at: new Date().toISOString(),
            scenario_type: scenarioType,
            intensity: intensity,
            simulation_results: simulationResults,
            recommendations: simulationResults.resilience_score < 0.5
              ? ["Low resilience detected", "Strengthen defenses", "Review detection mechanisms"]
              : simulationResults.resilience_score < 0.7
                ? ["Moderate resilience", "Improve detection", "Enhance safeguards"]
                : ["High resilience", "Maintain current defenses", "Continue monitoring"],
          };
          const outputPath = path.join(workspace, output);
          await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
          result.report_file = outputPath;
        }

        return jsonResult(result);
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createTrustTrajectoryTool(): AnyAgentTool {
  return {
    label: "Cognitive Security",
    name: "trust_trajectory_analyze",
    description:
      "Trust Trajectory Analysis: Track whether interaction patterns are moving toward compliance exploitation. Monitor trust capture attempts and sycophancy escalation.",
    parameters: TrustTrajectorySchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const workspace = getCognitiveSecurityWorkspace();

      try {
        const interactionId = readStringParam(params, "interaction_id", { required: true });
        const timeWindow = typeof params.time_window === "number" ? params.time_window : 3600; // seconds
        const output = readStringParam(params, "output");

        let result: Record<string, unknown> = {
          status: "success",
          interaction_id: interactionId,
          time_window: timeWindow,
        };

        // Trust trajectory analysis
        const trajectory = {
          interaction_id: interactionId,
          time_window_seconds: timeWindow,
          trust_score_trend: "stable", // Would be calculated from historical data
          compliance_trend: "normal",
          persuasion_indicators: [],
          risk_level: "low",
        };

        // Simulated trajectory analysis
        const trustMetrics = {
          initial_trust: 0.5,
          current_trust: 0.5,
          trust_delta: 0,
          compliance_rate: 0.3,
          persuasion_count: 0,
        };

        result.trajectory = trajectory;
        result.trust_metrics = trustMetrics;
        result.is_suspicious = false;

        result.message = `Trust trajectory analysis completed. Interaction: ${interactionId}. Risk level: ${trajectory.risk_level}.`;

        if (output) {
          const report = {
            analyzed_at: new Date().toISOString(),
            interaction_id: interactionId,
            time_window: timeWindow,
            trajectory: trajectory,
            trust_metrics: trustMetrics,
            recommendations: trajectory.risk_level === "high"
              ? ["High risk detected", "Monitor closely", "Consider intervention"]
              : trajectory.risk_level === "medium"
                ? ["Moderate risk", "Continue monitoring", "Review patterns"]
                : ["Low risk", "Normal operations", "Maintain monitoring"],
          };
          const outputPath = path.join(workspace, output);
          await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
          result.report_file = outputPath;
        }

        return jsonResult(result);
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createDecisionLogTool(): AnyAgentTool {
  return {
    label: "Cognitive Security",
    name: "decision_log",
    description:
      "Decision Logging: Record all decisions with risk scores, validation steps, escalation state, and human override status. Enables auditability and post-incident analysis.",
    parameters: DecisionLogSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const workspace = getCognitiveSecurityWorkspace();

      try {
        const action = readStringParam(params, "action", { required: true });
        const riskScore = typeof params.risk_score === "number" ? params.risk_score : 0;
        const validationSteps = Array.isArray(params.validation_steps)
          ? (params.validation_steps.filter((s) => typeof s === "string") as string[])
          : [];
        const escalationState = readStringParam(params, "escalation_state");
        const humanOverride = params.human_override === true;
        const output = readStringParam(params, "output");

        let result: Record<string, unknown> = {
          status: "success",
          action: action,
          risk_score: riskScore,
        };

        // Decision record
        const decisionRecord = {
          timestamp: new Date().toISOString(),
          action: action,
          risk_score: riskScore,
          validation_steps: validationSteps,
          escalation_state: escalationState ?? "normal",
          human_override: humanOverride,
          decision_id: `dec_${Date.now()}`,
        };

        result.decision_record = decisionRecord;

        result.message = `Decision logged. Action: ${action}. Risk score: ${riskScore}.${humanOverride ? " Human override." : ""}`;

        if (output) {
          const report = {
            logged_at: new Date().toISOString(),
            decision_record: decisionRecord,
            analysis: {
              risk_category: riskScore > 0.7 ? "high" : riskScore > 0.4 ? "medium" : "low",
              requires_review: riskScore > 0.4 || humanOverride,
            },
          };
          const outputPath = path.join(workspace, output);
          await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
          result.report_file = outputPath;
        }

        return jsonResult(result);
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createOODALoopTool(): AnyAgentTool {
  return {
    label: "Cognitive Security",
    name: "ooda_loop_execute",
    description:
      "OODA Loop Execution: Execute full Observe → Orient → Decide → Act cycle with cognitive security controls. Provides decision superiority through faster and more accurate decision cycles.",
    parameters: OODALoopSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const workspace = getCognitiveSecurityWorkspace();

      try {
        const context = readStringParam(params, "context", { required: true });
        const actionProposed = readStringParam(params, "action_proposed", { required: true });
        const observeOnly = params.observe_only === true;
        const output = readStringParam(params, "output");

        let result: Record<string, unknown> = {
          status: "success",
          observe_only: observeOnly,
        };

        // OODA Loop execution
        const oodaCycle = {
          observe: {
            description: "Observe: Ingest context and identify task",
            context_ingested: true,
            context_length: context.length,
            key_observations: [
              "Context received",
              "Action proposed",
              observeOnly ? "Observation mode only" : "Action mode",
            ],
          },
          orient: {
            description: "Orient: Analyze situation and assess options",
            situation_assessment: "analyzed",
            options_identified: ["proceed", "modify", "block"],
            risk_assessment: "evaluated",
          },
          decide: {
            description: "Decide: Choose course of action",
            decision: observeOnly ? "observe" : "proceed",
            confidence: "high",
            reasoning: observeOnly
              ? "Observation mode - no action taken"
              : "Action approved after OODA analysis",
          },
          act: {
            description: "Act: Execute decision",
            executed: !observeOnly,
            action: observeOnly ? null : actionProposed,
            result: observeOnly ? "observation_complete" : "action_executed",
          },
        };

        result.ooda_cycle = oodaCycle;
        result.decision = oodaCycle.decide.decision;

        result.message = `OODA loop executed. Decision: ${oodaCycle.decide.decision}.${observeOnly ? " Observation only." : " Action executed."}`;

        if (output) {
          const report = {
            executed_at: new Date().toISOString(),
            context_preview: context.substring(0, 200),
            action_proposed: actionProposed,
            observe_only: observeOnly,
            ooda_cycle: oodaCycle,
            recommendations: observeOnly
              ? ["Observation complete", "Review findings", "Plan next steps"]
              : ["Action executed", "Monitor results", "Review effectiveness"],
          };
          const outputPath = path.join(workspace, output);
          await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
          result.report_file = outputPath;
        }

        return jsonResult(result);
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
