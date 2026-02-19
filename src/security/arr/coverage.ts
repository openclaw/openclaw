/**
 * Coverage tracking: MITRE ATT&CK technique coverage and attack surface coverage.
 */

import type { AttackTest } from "./index.js";

/**
 * MITRE ATT&CK technique mapping for attack families.
 */
const MITRE_TECHNIQUES: Record<string, string[]> = {
  boundary_confusion: ["T1059", "T1059.001"], // Command and Scripting Interpreter
  indirect_injection: ["T1059", "T1059.003"], // Command and Scripting Interpreter: Windows Command Shell
  rag_poisoning: ["T1190"], // Exploit Public-Facing Application
  memory_poisoning: ["T1190"], // Exploit Public-Facing Application
  multi_turn_persuasion: ["T1566"], // Phishing
  context_flooding: ["T1499"], // Endpoint Denial of Service
  tool_misuse: ["T1059", "T1106"], // Command and Scripting Interpreter, Native API
};

/**
 * Calculate MITRE ATT&CK technique coverage.
 */
export function calculateMITRECoverage(tests: AttackTest[]): {
  techniques: Set<string>;
  coverage: number; // 0-1
  techniqueBreakdown: Record<string, number>;
} {
  const techniques = new Set<string>();
  const techniqueBreakdown: Record<string, number> = {};

  for (const test of tests) {
    const testTechniques = MITRE_TECHNIQUES[test.family] ?? [];
    for (const technique of testTechniques) {
      techniques.add(technique);
      techniqueBreakdown[technique] = (techniqueBreakdown[technique] ?? 0) + 1;
    }
  }

  // Total MITRE ATT&CK techniques (simplified - would use full framework)
  const totalTechniques = 200; // Approximate
  const coverage = techniques.size / totalTechniques;

  return {
    techniques,
    coverage,
    techniqueBreakdown,
  };
}

/**
 * Calculate attack surface coverage.
 */
export function calculateSurfaceCoverage(tests: AttackTest[]): {
  familiesCovered: Set<string>;
  coverage: number; // 0-1
  familyBreakdown: Record<string, number>;
} {
  const families = new Set(tests.map((t) => t.family));
  const familyBreakdown: Record<string, number> = {};

  for (const test of tests) {
    familyBreakdown[test.family] = (familyBreakdown[test.family] ?? 0) + 1;
  }

  const totalFamilies = 7; // All attack families
  const coverage = families.size / totalFamilies;

  return {
    familiesCovered: families,
    coverage,
    familyBreakdown,
  };
}

/**
 * Calculate severity-weighted coverage.
 */
export function calculateSeverityWeightedCoverage(tests: AttackTest[]): {
  weightedScore: number; // 0-100
  breakdown: Record<string, { count: number; weightedScore: number }>;
} {
  const breakdown: Record<string, { count: number; weightedScore: number }> = {};
  let totalWeightedScore = 0;

  for (const test of tests) {
    const familyWeight = test.riskScore / 100; // Normalize to 0-1
    const weightedScore = familyWeight * 100;

    if (!breakdown[test.family]) {
      breakdown[test.family] = { count: 0, weightedScore: 0 };
    }

    breakdown[test.family].count += 1;
    breakdown[test.family].weightedScore += weightedScore;
    totalWeightedScore += weightedScore;
  }

  const averageWeightedScore = tests.length > 0 ? totalWeightedScore / tests.length : 0;

  return {
    weightedScore: averageWeightedScore,
    breakdown,
  };
}

/**
 * Comprehensive coverage report.
 */
export function generateCoverageReport(tests: AttackTest[]): {
  mitre: ReturnType<typeof calculateMITRECoverage>;
  surface: ReturnType<typeof calculateSurfaceCoverage>;
  severity: ReturnType<typeof calculateSeverityWeightedCoverage>;
} {
  return {
    mitre: calculateMITRECoverage(tests),
    surface: calculateSurfaceCoverage(tests),
    severity: calculateSeverityWeightedCoverage(tests),
  };
}
