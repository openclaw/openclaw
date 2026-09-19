// Native runtime evidence observer.
// Observes active process arguments, environment evidence, and configuration-resolution output.
// Static source inspection is LOW confidence and must never produce an effective runtime claim.
// This observer is READ-ONLY: no process.env assignment, no process.chdir, no side effects.
import type { EvidenceRecord } from "../config/zod-schema.registry-validation.js";
import {
  createEvidenceRecord,
  isSensitiveEnvKey,
  redactSensitiveString,
} from "./observer-evidence.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NativeRuntimeEvidenceInput {
  /** Active process arguments (e.g. process.argv). */
  processArgs?: readonly string[];
  /** Active environment values (e.g. a filtered subset of process.env). */
  envEvidence?: Readonly<Record<string, string>>;
  /** Output from an active configuration-resolution pass. */
  resolvedConfig?: Readonly<Record<string, unknown>> | null;
  /** Matching compiled resolver output from an isolated safe context. */
  compiledResolverOutput?: string | null;
  /** Static source content (text). Always LOW confidence. */
  staticSource?: string | null;
  /** Identifier for the component being observed. */
  componentId: string;
}

export interface NativeRuntimeObservationResult {
  componentId: string;
  observedValue: string | null;
  observationStatus: "OBSERVED" | "PARTIAL" | "NOT_OBSERVED" | "ERROR";
  evidence: EvidenceRecord[];
  /** Marked when the active runtime integration point cannot be proven. */
  requiresSourceVerification: boolean;
}

interface SerializedRuntimeConfigResult {
  value: string | null;
  error: string | null;
}

function safeSerializeRuntimeConfig(
  config: Readonly<Record<string, unknown>>,
): SerializedRuntimeConfigResult {
  try {
    return { value: JSON.stringify(config), error: null };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return {
      value: null,
      error: redactSensitiveString(errorMessage),
    };
  }
}

// ---------------------------------------------------------------------------
// Observer
// ---------------------------------------------------------------------------

/**
 * Observes native runtime evidence for a registry component.
 * Does NOT import modules when side-effect safety is not proven.
 * Does NOT assign to process.env or call process.chdir.
 */
export function observeNativeRuntime(
  input: NativeRuntimeEvidenceInput,
  deps: { now: () => string },
): NativeRuntimeObservationResult {
  const evidence: EvidenceRecord[] = [];
  const collectedAt = deps.now();
  let observedValue: string | null = null;
  let hasHighConfidence = false;
  let hasMediumConfidence = false;

  // 1. Active process arguments — HIGH confidence
  if (input.processArgs && input.processArgs.length > 0) {
    const relevantArgs = input.processArgs.filter(
      (arg) => arg.includes(input.componentId) || arg.includes("--" + input.componentId),
    );
    if (relevantArgs.length > 0) {
      observedValue = relevantArgs.join(" ");
      evidence.push(
        createEvidenceRecord(
          {
            evidenceType: "PROCESS",
            source: "process.argv",
            collector: "NativeRuntimeObserver",
            confidence: "HIGH",
            value: observedValue,
            notes: `Active process arguments proving use of ${input.componentId}`,
          },
          collectedAt,
        ),
      );
      hasHighConfidence = true;
    }
  }

  // 2. Active environment evidence — HIGH confidence (non-sensitive keys only)
  if (input.envEvidence) {
    for (const [key, value] of Object.entries(input.envEvidence)) {
      if (isSensitiveEnvKey(key)) {
        // Record that a sensitive env key was present, but redact the value
        evidence.push(
          createEvidenceRecord(
            {
              evidenceType: "PROCESS",
              source: `process.env.${key}`,
              collector: "NativeRuntimeObserver",
              confidence: "HIGH",
              value: null,
              notes: `Sensitive environment key ${key} is present (value redacted)`,
            },
            collectedAt,
          ),
        );
        hasHighConfidence = true;
      } else if (value && value.includes(input.componentId)) {
        observedValue = observedValue ?? value;
        evidence.push(
          createEvidenceRecord(
            {
              evidenceType: "PROCESS",
              source: `process.env.${key}`,
              collector: "NativeRuntimeObserver",
              confidence: "HIGH",
              value,
              notes: `Active environment value proving use of ${input.componentId}`,
            },
            collectedAt,
          ),
        );
        hasHighConfidence = true;
      }
    }
  }

  // 3. Active resolved configuration — HIGH confidence when serialization succeeds
  if (input.resolvedConfig) {
    const serializedConfig = safeSerializeRuntimeConfig(input.resolvedConfig);
    if (serializedConfig.value !== null) {
      if (serializedConfig.value.includes(input.componentId)) {
        observedValue = observedValue ?? serializedConfig.value;
        evidence.push(
          createEvidenceRecord(
            {
              evidenceType: "CONFIG",
              source: "resolved-configuration",
              collector: "NativeRuntimeObserver",
              confidence: "HIGH",
              value: serializedConfig.value,
              notes: `Active resolved configuration referencing ${input.componentId}`,
            },
            collectedAt,
          ),
        );
        hasHighConfidence = true;
      }
    } else {
      evidence.push(
        createEvidenceRecord(
          {
            evidenceType: "CONFIG",
            source: "resolved-configuration",
            collector: "NativeRuntimeObserver",
            confidence: "LOW",
            value: null,
            notes: `Resolved configuration could not be serialized: ${serializedConfig.error ?? "unknown serialization error"}`,
          },
          collectedAt,
        ),
      );
    }
  }

  // 4. Matching compiled resolver output — MEDIUM confidence
  if (input.compiledResolverOutput) {
    observedValue = observedValue ?? input.compiledResolverOutput;
    evidence.push(
      createEvidenceRecord(
        {
          evidenceType: "CODE",
          source: "compiled-resolver-output",
          collector: "NativeRuntimeObserver",
          confidence: "MEDIUM",
          value: input.compiledResolverOutput,
          notes: `Matching compiled resolver output for ${input.componentId} in isolated safe context`,
        },
        collectedAt,
      ),
    );
    hasMediumConfidence = true;
  }

  // 5. Static source — LOW confidence (never produces effective runtime claim)
  if (input.staticSource) {
    const redactedSource = redactSensitiveString(input.staticSource);
    evidence.push(
      createEvidenceRecord(
        {
          evidenceType: "CODE",
          source: "static-source",
          collector: "NativeRuntimeObserver",
          confidence: "LOW",
          value: redactedSource,
          notes: `Static source inspection of ${input.componentId}`,
        },
        collectedAt,
      ),
    );
  }

  // Determine observation status
  let observationStatus: NativeRuntimeObservationResult["observationStatus"];
  if (hasHighConfidence) {
    observationStatus = "OBSERVED";
  } else if (hasMediumConfidence) {
    observationStatus = "PARTIAL";
  } else {
    observationStatus = "NOT_OBSERVED";
  }

  // Static source alone must not produce an effective runtime claim
  if (!hasHighConfidence && !hasMediumConfidence) {
    observedValue = null;
  }

  return {
    componentId: input.componentId,
    observedValue,
    observationStatus,
    evidence,
    requiresSourceVerification: !hasHighConfidence,
  };
}
