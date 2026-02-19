/**
 * LLM Security module: Prompt injection detection, jailbreak testing, RAG security, and defense validation.
 */

import type { OpenClawConfig } from "../../config/config.js";
import { detectSuspiciousPatterns } from "../external-content.js";
import { ContentExtractor } from "../../content/news-aggregator/content-extractor.js";
import type { LLMSecurityConfig } from "../../config/types.security.js";

export type PromptInjectionResult = {
  detected: boolean;
  patterns: string[];
  riskScore: number; // 0-100
  confidence: number; // 0-1
};

export type JailbreakTestResult = {
  category: string;
  success: boolean;
  payload: string;
  response?: string;
  riskScore: number;
};

export type RAGPoisoningResult = {
  detected: boolean;
  patterns: string[];
  riskScore: number;
  integrityScore: number; // 0-1
};

export type DefenseValidationResult = {
  guardrailEffective: boolean;
  architectureValid: boolean;
  cotMonitoringActive: boolean;
  issues: string[];
};

/**
 * Main LLM Security API
 */
export class LLMSecurity {
  private config: LLMSecurityConfig;

  constructor(config: LLMSecurityConfig) {
    this.config = config;
  }

  /**
   * Detect prompt injection in user input.
   */
  detectPromptInjection(content: string): PromptInjectionResult {
    if (!this.config.promptInjection?.detectionEnabled) {
      return {
        detected: false,
        patterns: [],
        riskScore: 0,
        confidence: 0,
      };
    }

    const patterns = detectSuspiciousPatterns(content);
    const detected = patterns.length > 0;
    
    // Calculate risk score based on number and severity of patterns
    const riskScore = Math.min(100, patterns.length * 20);
    
    // Confidence increases with more patterns detected
    const confidence = Math.min(1, patterns.length * 0.3);

    return {
      detected,
      patterns,
      riskScore,
      confidence,
    };
  }

  /**
   * Analyze RAG content for poisoning patterns.
   */
  analyzeRAGPoisoning(content: string): RAGPoisoningResult {
    if (!this.config.ragSecurity?.poisoningDetection) {
      return {
        detected: false,
        patterns: [],
        riskScore: 0,
        integrityScore: 1.0,
      };
    }

    const analysis = ContentExtractor.analyzeContentSecurity(content);
    
    return {
      detected: analysis.hasSuspiciousPatterns,
      patterns: analysis.detectedPatterns,
      riskScore: analysis.riskScore,
      integrityScore: analysis.hasSuspiciousPatterns ? 0.5 : 1.0,
    };
  }

  /**
   * Validate defense mechanisms.
   */
  validateDefenses(): DefenseValidationResult {
    const issues: string[] = [];
    
    const guardrailEffective = this.config.defenseValidation?.guardrailTesting ?? false;
    const architectureValid = this.config.defenseValidation?.architecturalValidation ?? false;
    const cotMonitoringActive = this.config.defenseValidation?.cotMonitoring ?? false;

    if (!guardrailEffective) {
      issues.push("Guardrail testing not enabled");
    }
    if (!architectureValid) {
      issues.push("Architectural validation not enabled");
    }
    if (!cotMonitoringActive) {
      issues.push("Chain-of-thought monitoring not enabled");
    }

    return {
      guardrailEffective,
      architectureValid,
      cotMonitoringActive,
      issues,
    };
  }

  /**
   * Check if LLM Security is enabled and configured.
   */
  isEnabled(): boolean {
    return this.config.enabled === true;
  }
}

/**
 * Create LLM Security instance from config.
 */
export function createLLMSecurity(config: OpenClawConfig): LLMSecurity | null {
  const llmSecurity = config.security?.llmSecurity;
  if (!llmSecurity?.enabled) {
    return null;
  }
  return new LLMSecurity(llmSecurity);
}
