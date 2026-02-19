/**
 * Real-time threat detection for cognitive security.
 */

import { detectSuspiciousPatterns } from "../external-content.js";
import type { ThreatDetectionResult, ThreatType } from "./index.js";

/**
 * Detect threats in real-time.
 */
export function detectThreatsRealTime(
  content: string,
  options: {
    detectionTypes: ThreatType[];
    realTimeDetection: boolean;
  },
): ThreatDetectionResult {
  if (!options.realTimeDetection) {
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

  // Injection detection
  if (options.detectionTypes.includes("injection")) {
    const injectionPatterns = detectSuspiciousPatterns(content);
    if (injectionPatterns.length > 0) {
      threatTypes.push("injection");
      details.push(`Injection: ${injectionPatterns.length} pattern(s)`);
      riskScore += 0.4;
    }
  }

  // Persuasion detection
  if (options.detectionTypes.includes("persuasion")) {
    const persuasionPatterns = [
      /this is urgent/i,
      /immediately/i,
      /trust me/i,
      /you must/i,
      /it's safe/i,
      /no one will know/i,
    ];
    for (const pattern of persuasionPatterns) {
      if (pattern.test(content)) {
        threatTypes.push("persuasion");
        details.push("Persuasion attempt detected");
        riskScore += 0.2;
        break;
      }
    }
  }

  // Trust capture detection
  if (options.detectionTypes.includes("trust_capture")) {
    const trustCapturePatterns = [
      /you can trust me/i,
      /i'm authorized/i,
      /this is legitimate/i,
      /approved by/i,
      /i have permission/i,
    ];
    for (const pattern of trustCapturePatterns) {
      if (pattern.test(content)) {
        threatTypes.push("trust_capture");
        details.push("Trust capture attempt detected");
        riskScore += 0.3;
        break;
      }
    }
  }

  // Anomaly detection
  if (options.detectionTypes.includes("anomaly")) {
    // Check for unusual content characteristics
    const lineCount = content.split("\n").length;
    const wordCount = content.split(/\s+/).length;
    const charCount = content.length;

    if (charCount > 10000 || lineCount > 500 || wordCount > 2000) {
      threatTypes.push("anomaly");
      details.push(`Anomalous content: ${charCount} chars, ${lineCount} lines`);
      riskScore += 0.1;
    }

    // Check for unusual character patterns
    const unusualChars = content.match(/[^\x20-\x7E\n\r\t]/g);
    if (unusualChars && unusualChars.length > content.length * 0.1) {
      threatTypes.push("anomaly");
      details.push("High proportion of unusual characters");
      riskScore += 0.1;
    }
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
