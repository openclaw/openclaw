import type { InjectionInspectionResult } from "../security/external-content.js";
import type { MemoryRiskClass, MemoryRiskLevel, MemoryRiskMetadata } from "./types.js";

const MAX_STORED_PATTERNS = 10;
const MAX_WARNING_PATTERNS = 5;

export function toMemoryRiskMetadata(inspection: InjectionInspectionResult): MemoryRiskMetadata {
  return {
    riskLevel: inspection.riskLevel,
    score: inspection.score,
    classesMatched: inspection.classesMatched,
    patternsTop: inspection.patterns.slice(0, MAX_STORED_PATTERNS),
    encodedMatches: inspection.encodedMatches,
  };
}

export function clampPatternsForWarning(patterns: string[]): string[] {
  return patterns.slice(0, MAX_WARNING_PATTERNS);
}

export function buildRiskWarning(params: {
  risk: MemoryRiskMetadata;
  prefix: "WARNING" | "CRITICAL";
}): string {
  const patterns = clampPatternsForWarning(params.risk.patternsTop).join(", ");
  const classes = params.risk.classesMatched.join(", ");
  return `${params.prefix}: prompt-injection patterns detected (risk=${params.risk.riskLevel}, classes=${classes}, patterns=${patterns})`;
}

export function parseRiskLevel(raw: unknown): MemoryRiskLevel {
  if (raw === "low" || raw === "medium" || raw === "high" || raw === "critical") {
    return raw;
  }
  return "low";
}

export function parseRiskClasses(raw: unknown): MemoryRiskClass[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const classes: MemoryRiskClass[] = [];
  for (const entry of raw) {
    if (
      entry === "role_confusion" ||
      entry === "instruction_override" ||
      entry === "tool_invocation" ||
      entry === "exfiltration" ||
      entry === "privilege_escalation" ||
      entry === "encoding"
    ) {
      classes.push(entry);
    }
  }
  return classes;
}

export function parseRiskMetadataRow(row: {
  risk_level?: unknown;
  risk_score?: unknown;
  risk_classes?: unknown;
  risk_patterns?: unknown;
  risk_encoded_matches?: unknown;
}): MemoryRiskMetadata {
  let classesRaw: unknown = [];
  let patternsRaw: unknown = [];
  try {
    if (typeof row.risk_classes === "string") {
      classesRaw = JSON.parse(row.risk_classes);
    }
  } catch {}
  try {
    if (typeof row.risk_patterns === "string") {
      patternsRaw = JSON.parse(row.risk_patterns);
    }
  } catch {}
  return {
    riskLevel: parseRiskLevel(row.risk_level),
    score:
      typeof row.risk_score === "number"
        ? row.risk_score
        : typeof row.risk_score === "string"
          ? Number.parseInt(row.risk_score, 10) || 0
          : 0,
    classesMatched: parseRiskClasses(classesRaw),
    patternsTop: Array.isArray(patternsRaw)
      ? patternsRaw.filter((entry): entry is string => typeof entry === "string").slice(0, 10)
      : [],
    encodedMatches:
      typeof row.risk_encoded_matches === "number"
        ? row.risk_encoded_matches
        : typeof row.risk_encoded_matches === "string"
          ? Number.parseInt(row.risk_encoded_matches, 10) || 0
          : 0,
  };
}

export function coerceRiskMetadata(raw: {
  riskLevel?: unknown;
  score?: unknown;
  classesMatched?: unknown;
  patternsTop?: unknown;
  encodedMatches?: unknown;
}): MemoryRiskMetadata {
  return {
    riskLevel: parseRiskLevel(raw.riskLevel),
    score:
      typeof raw.score === "number"
        ? raw.score
        : typeof raw.score === "string"
          ? Number.parseInt(raw.score, 10) || 0
          : 0,
    classesMatched: parseRiskClasses(raw.classesMatched),
    patternsTop: Array.isArray(raw.patternsTop)
      ? raw.patternsTop.filter((entry): entry is string => typeof entry === "string").slice(0, 10)
      : [],
    encodedMatches:
      typeof raw.encodedMatches === "number"
        ? raw.encodedMatches
        : typeof raw.encodedMatches === "string"
          ? Number.parseInt(raw.encodedMatches, 10) || 0
          : 0,
  };
}

export function riskScoreMultiplier(level: MemoryRiskLevel): number {
  if (level === "critical") {
    return 0.55;
  }
  if (level === "high") {
    return 0.7;
  }
  if (level === "medium") {
    return 0.85;
  }
  return 1;
}
