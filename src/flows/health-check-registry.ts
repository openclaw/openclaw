import { normalizeHealthCheck } from "./health-check-adapter.js";
import type { HealthCheck, RegisteredHealthCheck } from "./health-checks.js";

const REGISTRY = new Map<string, RegisteredHealthCheck>();

export class HealthCheckRegistrationError extends Error {
  readonly code = "OC_DOCTOR_DUPLICATE_CHECK";
  constructor(readonly checkId: string) {
    super(`health check already registered: ${checkId}`);
    this.name = "HealthCheckRegistrationError";
  }
}

export function registerHealthCheck(check: HealthCheck): void {
  if (REGISTRY.has(check.id)) {
    throw new HealthCheckRegistrationError(check.id);
  }
  REGISTRY.set(check.id, normalizeHealthCheck(check));
}

export function listHealthChecks(): readonly RegisteredHealthCheck[] {
  return [...REGISTRY.values()];
}

export function getHealthCheck(id: string): RegisteredHealthCheck | undefined {
  return REGISTRY.get(id);
}

export function clearHealthChecksForTest(): void {
  REGISTRY.clear();
}
