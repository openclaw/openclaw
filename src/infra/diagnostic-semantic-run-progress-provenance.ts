import type { DiagnosticEmbeddedRunOwner } from "./diagnostic-model-request-provenance.js";

type CoreSemanticRunProgressEvent = { type: "run.progress" };
export type CoreSemanticRunProgressProvenance = true | DiagnosticEmbeddedRunOwner;

export const CORE_SEMANTIC_RUN_PROGRESS_METADATA_KEY = "coreSemanticRunProgress";

const coreSemanticRunProgressEvents = new WeakMap<object, CoreSemanticRunProgressProvenance>();

// Exact object identity is the core-only authority; payload fields cannot forge it.
export function markCoreSemanticRunProgressDiagnosticEvent<T extends CoreSemanticRunProgressEvent>(
  event: T,
  owner?: DiagnosticEmbeddedRunOwner,
): T {
  coreSemanticRunProgressEvents.set(event, owner ?? true);
  return event;
}

export function consumeCoreSemanticRunProgressDiagnosticEvent(
  event: object,
): CoreSemanticRunProgressProvenance | undefined {
  const provenance = coreSemanticRunProgressEvents.get(event);
  coreSemanticRunProgressEvents.delete(event);
  return provenance;
}
