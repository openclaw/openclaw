/**
 * Security features integration into agent execution pipeline.
 */

import type { OpenClawConfig } from "../config/config.js";
import { createLLMSecurity } from "./llm-security/index.js";
import { createCognitiveSecurity } from "./cognitive-security/index.js";
import { createAdversaryRecommender } from "./arr/index.js";
import { createSwarmAgents } from "./swarm-agents/index.js";
import type { PromptInjectionResult } from "./llm-security/index.js";
import type { ThreatDetectionResult, EscalationControlResult } from "./cognitive-security/index.js";

export type SecurityCheckResult = {
  allowed: boolean;
  reason?: string;
  promptInjection?: PromptInjectionResult;
  threatDetection?: ThreatDetectionResult;
  escalationControl?: EscalationControlResult;
  riskScore: number; // 0-1
};

/**
 * Security integration manager.
 */
export class SecurityIntegration {
  private llmSecurity = createLLMSecurity;
  private cognitiveSecurity = createCognitiveSecurity;
  private arr = createAdversaryRecommender;
  private swarmAgents = createSwarmAgents;

  /**
   * Check message content for security issues before processing.
   */
  checkMessageSecurity(
    config: OpenClawConfig,
    content: string,
    sessionKey: string,
  ): SecurityCheckResult {
    const llmSec = this.llmSecurity(config);
    const cogSec = this.cognitiveSecurity(config);

    let riskScore = 0;
    const reasons: string[] = [];

    // LLM Security: Prompt injection detection
    let promptInjection: PromptInjectionResult | undefined;
    if (llmSec) {
      promptInjection = llmSec.detectPromptInjection(content);
      if (promptInjection.detected) {
        riskScore = Math.max(riskScore, promptInjection.riskScore / 100);
        reasons.push(`Prompt injection detected: ${promptInjection.patterns.length} pattern(s)`);
      }
    }

    // Cognitive Security: Threat detection
    let threatDetection: ThreatDetectionResult | undefined;
    if (cogSec) {
      threatDetection = cogSec.detectThreats(content);
      if (threatDetection.detected) {
        riskScore = Math.max(riskScore, threatDetection.riskScore);
        reasons.push(`Threats detected: ${threatDetection.threatTypes.join(", ")}`);
      }
    }

    // Determine if message should be blocked
    const allowed = riskScore < 0.7; // Block if risk > 70%

    return {
      allowed,
      reason: reasons.length > 0 ? reasons.join("; ") : undefined,
      promptInjection,
      threatDetection,
      riskScore,
    };
  }

  /**
   * Check tool call for escalation control.
   */
  checkToolCallSecurity(
    config: OpenClawConfig,
    toolName: string,
    chainDepth: number,
    cumulativeRisk: number,
    uncertainty: number,
  ): EscalationControlResult {
    const cogSec = this.cognitiveSecurity(config);
    if (!cogSec) {
      return {
        allowed: true,
        chainDepth,
        cumulativeRisk,
        uncertainty,
      };
    }

    return cogSec.checkEscalationControl(chainDepth, cumulativeRisk, uncertainty);
  }

  /**
   * Track provenance of input.
   */
  trackInputProvenance(
    config: OpenClawConfig,
    source: string,
    integrityScore: number = 1.0,
  ): { tracked: boolean; integrityScore: number } {
    const cogSec = this.cognitiveSecurity(config);
    if (!cogSec) {
      return { tracked: false, integrityScore: 1.0 };
    }

    const result = cogSec.trackProvenance(source, integrityScore);
    return {
      tracked: result.tracked,
      integrityScore: result.integrityScore,
    };
  }

  /**
   * Check RAG content for poisoning.
   */
  checkRAGSecurity(
    config: OpenClawConfig,
    content: string,
  ): { detected: boolean; riskScore: number; integrityScore: number } {
    const llmSec = this.llmSecurity(config);
    if (!llmSec) {
      return { detected: false, riskScore: 0, integrityScore: 1.0 };
    }

    const result = llmSec.analyzeRAGPoisoning(content);
    return {
      detected: result.detected,
      riskScore: result.riskScore / 100,
      integrityScore: result.integrityScore,
    };
  }

  /**
   * Update security mode based on risk.
   */
  updateSecurityMode(
    config: OpenClawConfig,
    riskScore: number,
  ): "normal" | "guarded" | "restricted" | "safe" {
    const cogSec = this.cognitiveSecurity(config);
    if (!cogSec) {
      return "normal";
    }

    return cogSec.updateSecurityMode(riskScore);
  }
}

/**
 * Global security integration instance.
 */
let globalSecurityIntegration: SecurityIntegration | null = null;

/**
 * Get or create security integration instance.
 */
export function getSecurityIntegration(): SecurityIntegration {
  if (!globalSecurityIntegration) {
    globalSecurityIntegration = new SecurityIntegration();
  }
  return globalSecurityIntegration;
}
