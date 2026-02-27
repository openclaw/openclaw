import fs from "node:fs/promises";
import { deepInspectForInjection, type InjectionInspectionResult } from "./external-content.js";

const DEFAULT_WARNING_PATTERN_LIMIT = 5;
const MAX_WARNING_PATTERN_LIMIT = 25;
const DEFAULT_CRITICAL_ERROR_PREFIX = "critical security risk patterns detected";
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;

export class FileReadSecurityError extends Error {
  readonly filePath?: string;
  readonly inspection: InjectionInspectionResult;

  constructor(params: {
    message: string;
    filePath?: string;
    inspection: InjectionInspectionResult;
  }) {
    super(params.message);
    this.name = "FileReadSecurityError";
    this.filePath = params.filePath;
    this.inspection = params.inspection;
  }
}

export class FileReadTooLargeError extends Error {
  readonly filePath: string;
  readonly actualBytes: number;
  readonly maxBytes: number;

  constructor(params: { filePath: string; actualBytes: number; maxBytes: number }) {
    super(
      `file too large for safe read (${params.actualBytes} bytes > ${params.maxBytes} bytes): ${params.filePath}`,
    );
    this.name = "FileReadTooLargeError";
    this.filePath = params.filePath;
    this.actualBytes = params.actualBytes;
    this.maxBytes = params.maxBytes;
  }
}

type InspectTextContentOptions = {
  allowUntrusted?: boolean;
  warningPatternLimit?: number;
  criticalErrorPrefix?: string;
  filePath?: string;
  maxBytes?: number;
};

export type SafeReadTextResult = {
  content: string;
  warnings: string[];
  inspection: InjectionInspectionResult;
};

function clampPatternLimit(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_WARNING_PATTERN_LIMIT;
  }
  return Math.min(MAX_WARNING_PATTERN_LIMIT, Math.max(1, Math.floor(value)));
}

function clampMaxBytes(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_FILE_BYTES;
  }
  return Math.max(1, Math.floor(value));
}

function topPatterns(inspection: InjectionInspectionResult, limit: number): string[] {
  return inspection.patterns.slice(0, limit);
}

export function buildInjectionWarning(params: {
  inspection: InjectionInspectionResult;
  prefix: "WARNING" | "CRITICAL";
  patternLimit?: number;
}): string {
  const limit = clampPatternLimit(params.patternLimit);
  const patterns = topPatterns(params.inspection, limit).join(", ");
  const classes = params.inspection.classesMatched.join(", ");
  return `${params.prefix}: prompt-injection patterns detected (risk=${params.inspection.riskLevel}, classes=${classes}, patterns=${patterns})`;
}

export function inspectTextContent(
  content: string,
  options: InspectTextContentOptions = {},
): { inspection: InjectionInspectionResult; warnings: string[] } {
  const inspection = deepInspectForInjection(content);
  const warnings: string[] = [];
  const criticalPrefix = options.criticalErrorPrefix ?? DEFAULT_CRITICAL_ERROR_PREFIX;
  const patternLimit = clampPatternLimit(options.warningPatternLimit);
  if (inspection.riskLevel === "critical") {
    if (!options.allowUntrusted) {
      throw new FileReadSecurityError({
        message: `${criticalPrefix}: ${topPatterns(inspection, patternLimit).join(", ")}`,
        filePath: options.filePath,
        inspection,
      });
    }
    warnings.push(
      buildInjectionWarning({
        inspection,
        prefix: "CRITICAL",
        patternLimit,
      }),
    );
    return { inspection, warnings };
  }
  if (inspection.riskLevel === "medium" || inspection.riskLevel === "high") {
    warnings.push(
      buildInjectionWarning({
        inspection,
        prefix: "WARNING",
        patternLimit,
      }),
    );
  }
  return { inspection, warnings };
}

/** Fire-and-forget security event emission. Errors are swallowed so that event
 * infrastructure failures never interrupt the caller's read path. */
async function emitInjectionEventAsync(
  filePath: string,
  inspection: InjectionInspectionResult,
): Promise<void> {
  try {
    const { emitSecurityEvent } = await import("./security-events.js");
    emitSecurityEvent({
      type: "injection_detected",
      severity: inspection.riskLevel === "critical" ? "critical" : "warn",
      source: "safe-file-read",
      message: `Injection patterns detected in file: ${filePath}`,
      details: {
        filePath,
        riskLevel: inspection.riskLevel,
        patterns: inspection.patterns.slice(0, 5),
        classesMatched: inspection.classesMatched,
        score: inspection.score,
      },
      remediation: "Review the file for prompt injection patterns before processing.",
    });
  } catch {
    // Event emission must never interrupt the read.
  }
}

export async function safeReadTextFile(
  filePath: string,
  options: Omit<InspectTextContentOptions, "filePath"> = {},
): Promise<SafeReadTextResult> {
  const maxBytes = clampMaxBytes(options.maxBytes);
  // Read first, check size afterward to eliminate the stat→read TOCTOU window.
  // A file could be replaced with a larger one between a pre-read stat and the
  // actual read; measuring the decoded byte length after reading is race-free.
  const content = await fs.readFile(filePath, "utf-8");
  const actualBytes = Buffer.byteLength(content, "utf-8");
  if (actualBytes > maxBytes) {
    throw new FileReadTooLargeError({
      filePath,
      actualBytes,
      maxBytes,
    });
  }
  const inspected = inspectTextContent(content, {
    ...options,
    filePath,
  });

  if (inspected.inspection.riskLevel === "high" || inspected.inspection.riskLevel === "critical") {
    void emitInjectionEventAsync(filePath, inspected.inspection);
  }

  return {
    content,
    warnings: inspected.warnings,
    inspection: inspected.inspection,
  };
}
