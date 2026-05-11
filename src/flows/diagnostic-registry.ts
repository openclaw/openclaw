import type { DiagnosticCheck } from "./diagnostics.js";

const REGISTRY = new Map<string, DiagnosticCheck>();

export class DiagnosticRegistrationError extends Error {
  readonly code = "OC_LINT_DUPLICATE_CHECK";
  constructor(readonly checkId: string) {
    super(`diagnostic check already registered: ${checkId}`);
    this.name = "DiagnosticRegistrationError";
  }
}

export function registerDiagnosticCheck(check: DiagnosticCheck): void {
  if (REGISTRY.has(check.id)) {
    throw new DiagnosticRegistrationError(check.id);
  }
  REGISTRY.set(check.id, check);
}

export function listDiagnosticChecks(): readonly DiagnosticCheck[] {
  return [...REGISTRY.values()];
}

export function getDiagnosticCheck(id: string): DiagnosticCheck | undefined {
  return REGISTRY.get(id);
}

export function clearDiagnosticChecksForTest(): void {
  REGISTRY.clear();
}
