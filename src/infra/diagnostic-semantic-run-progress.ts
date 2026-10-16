import {
  emitTrustedDiagnosticEvent,
  type DiagnosticEventInput,
  type DiagnosticEventMetadata,
} from "./diagnostic-events.js";
import type { DiagnosticEmbeddedRunOwner } from "./diagnostic-model-request-provenance.js";
import {
  CORE_SEMANTIC_RUN_PROGRESS_METADATA_KEY,
  markCoreSemanticRunProgressDiagnosticEvent,
  type CoreSemanticRunProgressProvenance,
} from "./diagnostic-semantic-run-progress-provenance.js";

type CoreSemanticRunProgressEventInput = Omit<
  Extract<DiagnosticEventInput, { type: "run.progress" }>,
  "runId" | "type"
> & { runId: string };

type CoreSemanticRunProgressMetadata = DiagnosticEventMetadata &
  Readonly<{
    [CORE_SEMANTIC_RUN_PROGRESS_METADATA_KEY]?: CoreSemanticRunProgressProvenance;
  }>;

/** Emits semantic run progress from the core boundary that validated useful work. */
export function emitCoreSemanticRunProgressDiagnosticEvent(
  event: CoreSemanticRunProgressEventInput,
  owner?: DiagnosticEmbeddedRunOwner,
): void {
  emitTrustedDiagnosticEvent(
    markCoreSemanticRunProgressDiagnosticEvent({ ...event, type: "run.progress" }, owner),
  );
}

/** Returns the private provenance attached by the core progress emitter. */
export function resolveCoreSemanticRunProgressDiagnosticMetadata(
  metadata: DiagnosticEventMetadata,
): CoreSemanticRunProgressProvenance | undefined {
  return (metadata as CoreSemanticRunProgressMetadata)[CORE_SEMANTIC_RUN_PROGRESS_METADATA_KEY];
}
