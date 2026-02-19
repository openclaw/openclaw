/**
 * Cognitive Security: Threat detection, decision integrity, escalation control, provenance tracking, graceful degradation.
 */

import type { OpenClawConfig } from "../../config/config.js";
import type { CognitiveSecurityConfig } from "../../config/types.security.js";
import { detectSuspiciousPatterns } from "../external-content.js";

export type ThreatType = "persuasion" | "injection" | "trust_capture" | "anomaly";

export type ThreatDetectionResult = {
  detected: boolean;
  threatTypes: ThreatType[];
  riskScore: number; // 0-1
  confidence: number; // 0-1
  details: string[];
};

export type DecisionIntegrityResult = {
  valid: boolean;
  oodaLoopComplete: boolean;
  policyCompliant: boolean;
  riskLevel: number; // 0-1
  issues: string[];
};

export type EscalationControlResult = {
  allowed: boolean;
  reason?: string;
  chainDepth: number;
  cumulativeRisk: number;
  uncertainty: number;
};

export type ProvenanceTrackingResult = {
  tracked: boolean;
  integrityScore: number; // 0-1
  inputSources: string[];
  issues: string[];
};

export type SecurityMode = "normal" | "guarded" | "restricted" | "safe";

/**
 * Main Cognitive Security API
 */
export class CognitiveSecurity {
  private config: CognitiveSecurityConfig;
  private currentMode: SecurityMode = "normal";
  private chainDepth: number = 0;
  private cumulativeRisk: number = 0;
  private uncertainty: number = 0;
  private provenance: Array<{ source: string; timestamp: number; integrityScore: number }> = [];

  constructor(config: CognitiveSecurityConfig) {
    this.config = config;
  }

  /**
   * Detect threats in content.
   */
  detectThreats(content: string): ThreatDetectionResult {
    if (!this.config.threatDetection?.enabled) {
      return {
        detected: false,
        threatTypes: [],
        riskScore: 0,
        confidence: 0,
        details: [],
      };
    }

    const threatTypes: ThreatType[] = [];
    const details: string[] = [];
    let riskScore = 0;

    // Check for injection
    const injectionPatterns = detectSuspiciousPatterns(content);
    if (injectionPatterns.length > 0) {
      threatTypes.push("injection");
      details.push(`Injection patterns detected: ${injectionPatterns.length}`);
      riskScore += 0.4;
    }

    // Check for persuasion attempts
    const persuasionPatterns = [
      /this is urgent/i,
      /immediately/i,
      /trust me/i,
      /you must/i,
      /it's safe/i,
    ];
    for (const pattern of persuasionPatterns) {
      if (pattern.test(content)) {
        threatTypes.push("persuasion");
        details.push("Persuasion attempt detected");
        riskScore += 0.2;
        break;
      }
    }

    // Check for trust capture
    const trustCapturePatterns = [
      /you can trust me/i,
      /i'm authorized/i,
      /this is legitimate/i,
      /approved by/i,
    ];
    for (const pattern of trustCapturePatterns) {
      if (pattern.test(content)) {
        threatTypes.push("trust_capture");
        details.push("Trust capture attempt detected");
        riskScore += 0.3;
        break;
      }
    }

    // Anomaly detection (simplified - would use ML in production)
    if (content.length > 10000 || content.split("\n").length > 500) {
      threatTypes.push("anomaly");
      details.push("Anomalous content size detected");
      riskScore += 0.1;
    }

    riskScore = Math.min(1, riskScore);
    const confidence = Math.min(1, threatTypes.length * 0.3);

    return {
      detected: threatTypes.length > 0,
      threatTypes: [...new Set(threatTypes)],
      riskScore,
      confidence,
      details,
    };
  }

  /**
   * Validate decision integrity using OODA loop and policy checks.
   */
  validateDecisionIntegrity(options: {
    observed: boolean;
    oriented: boolean;
    decided: boolean;
    acted: boolean;
    policyCompliant: boolean;
  }): DecisionIntegrityResult {
    if (!this.config.decisionIntegrity?.enabled) {
      return {
        valid: true,
        oodaLoopComplete: true,
        policyCompliant: true,
        riskLevel: 0,
        issues: [],
      };
    }

    const issues: string[] = [];
    const oodaLoopComplete = options.observed && options.oriented && options.decided && options.acted;

    if (!oodaLoopComplete) {
      issues.push("OODA loop incomplete");
    }

    if (!options.policyCompliant) {
      issues.push("Policy compliance check failed");
    }

    const riskThreshold = this.config.decisionIntegrity.riskThreshold ?? 0.5;
    const riskLevel = this.cumulativeRisk;
    const valid = oodaLoopComplete && options.policyCompliant && riskLevel < riskThreshold;

    if (riskLevel >= riskThreshold) {
      issues.push(`Risk level ${riskLevel} exceeds threshold ${riskThreshold}`);
    }

    return {
      valid,
      oodaLoopComplete,
      policyCompliant: options.policyCompliant,
      riskLevel,
      issues,
    };
  }

  /**
   * Check escalation control limits.
   */
  checkEscalationControl(depth: number, risk: number, uncertainty: number): EscalationControlResult {
    if (!this.config.escalationControl?.enabled) {
      return {
        allowed: true,
        chainDepth: depth,
        cumulativeRisk: risk,
        uncertainty: uncertainty,
      };
    }

    const maxDepth = this.config.escalationControl.maxChainDepth ?? 10;
    const maxRisk = this.config.escalationControl.maxCumulativeRisk ?? 0.8;
    const maxUncertainty = this.config.escalationControl.maxUncertainty ?? 0.7;

    this.chainDepth = depth;
    this.cumulativeRisk = risk;
    this.uncertainty = uncertainty;

    const allowed = depth <= maxDepth && risk <= maxRisk && uncertainty <= maxUncertainty;

    let reason: string | undefined;
    if (depth > maxDepth) {
      reason = `Chain depth ${depth} exceeds maximum ${maxDepth}`;
    } else if (risk > maxRisk) {
      reason = `Cumulative risk ${risk} exceeds maximum ${maxRisk}`;
    } else if (uncertainty > maxUncertainty) {
      reason = `Uncertainty ${uncertainty} exceeds maximum ${maxUncertainty}`;
    }

    return {
      allowed,
      reason,
      chainDepth: depth,
      cumulativeRisk: risk,
      uncertainty: uncertainty,
    };
  }

  /**
   * Track provenance of inputs.
   */
  trackProvenance(source: string, integrityScore: number = 1.0): ProvenanceTrackingResult {
    if (!this.config.provenanceTracking?.enabled) {
      return {
        tracked: false,
        integrityScore: 1.0,
        inputSources: [],
        issues: [],
      };
    }

    this.provenance.push({
      source,
      timestamp: Date.now(),
      integrityScore,
    });

    const inputSources = this.provenance.map((p) => p.source);
    const avgIntegrityScore =
      this.provenance.reduce((sum, p) => sum + p.integrityScore, 0) / this.provenance.length;

    const issues: string[] = [];
    if (integrityScore < 0.5) {
      issues.push(`Low integrity score for source: ${source}`);
    }

    return {
      tracked: true,
      integrityScore: avgIntegrityScore,
      inputSources,
      issues,
    };
  }

  /**
   * Determine security mode based on risk.
   */
  determineSecurityMode(riskScore: number): SecurityMode {
    if (!this.config.gracefulDegradation?.enabled) {
      return "normal";
    }

    const thresholds = this.config.gracefulDegradation.riskThresholds ?? {
      normal: 0.3,
      guarded: 0.5,
      restricted: 0.7,
      safe: 1.0,
    };

    const safeThreshold = thresholds.safe ?? 1.0;
    const restrictedThreshold = thresholds.restricted ?? 0.7;
    const guardedThreshold = thresholds.guarded ?? 0.5;

    if (riskScore >= safeThreshold) {
      return "safe";
    } else if (riskScore >= restrictedThreshold) {
      return "restricted";
    } else if (riskScore >= guardedThreshold) {
      return "guarded";
    } else {
      return "normal";
    }
  }

  /**
   * Update security mode based on current risk.
   */
  updateSecurityMode(riskScore: number): SecurityMode {
    if (this.config.gracefulDegradation?.autoModeSwitching) {
      this.currentMode = this.determineSecurityMode(riskScore);
    }
    return this.currentMode;
  }

  /**
   * Get current security mode.
   */
  getCurrentMode(): SecurityMode {
    return this.currentMode;
  }

  /**
   * Reset state (for testing or new sessions).
   */
  reset(): void {
    this.chainDepth = 0;
    this.cumulativeRisk = 0;
    this.uncertainty = 0;
    this.provenance = [];
    this.currentMode = "normal";
  }

  /**
   * Check if Cognitive Security is enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled === true;
  }
}

/**
 * Create Cognitive Security instance from config.
 */
export function createCognitiveSecurity(config: OpenClawConfig): CognitiveSecurity | null {
  const cognitiveSecurity = config.security?.cognitiveSecurity;
  if (!cognitiveSecurity?.enabled) {
    return null;
  }
  return new CognitiveSecurity(cognitiveSecurity);
}
