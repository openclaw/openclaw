// External service observer.
// Generic HTTP probing with explicit typed policy: bounded timeout, AbortSignal,
// zero or one approved retry, endpoint-specific readiness rules.
// Tests must use mocked transport only. No live network, no real credentials.
import type { EvidenceRecord } from "../config/zod-schema.registry-validation.js";
import {
  createEvidenceRecord,
  redactSensitiveString,
  redactSensitiveUrl,
} from "./observer-evidence.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ServiceOutcome =
  | "READY"
  | "REACHABLE_NOT_READY"
  | "TIMEOUT"
  | "CONNECTION_REFUSED"
  | "DNS_ERROR"
  | "TLS_ERROR"
  | "AUTH_REQUIRED"
  | "UNEXPECTED_RESPONSE"
  | "INVALID_POLICY"
  | "INTERNAL_ERROR";

export type ServiceType = "n8n" | "qdrant" | "vllm";

export interface ServicePolicy {
  serviceId: string;
  serviceType: ServiceType;
  /** Sanitized endpoint identifier (no credentials). */
  endpointId: string;
  url: string;
  method: "GET" | "POST" | "HEAD";
  timeoutMs: number;
  retryCount: 0 | 1;
  /** Expected status conditions (e.g. [200]). */
  expectedStatus: number[];
  /** Optional expected response metadata (e.g. {"status": "ok"}). */
  expectedResponseMetadata?: Record<string, unknown> | null;
  /** Authentication provider type or sanitized headers (no secrets). */
  authProvider?: string | null;
  /** Sanitized headers (secrets already removed). */
  sanitizedHeaders?: Record<string, string> | null;
  /** Response-body retention policy: "never" by default. */
  responseBodyPolicy?: "never" | "metadata-only";
  /** Redaction policy for error messages. */
  redactionPolicy?: "strict" | "none";
}

export interface ServiceProbeDeps {
  /** Injected HTTP transport — must be mocked in tests. */
  fetch: (
    url: string,
    init: {
      method: string;
      headers?: Record<string, string>;
      signal: AbortSignal;
    },
  ) => Promise<ServiceProbeResponse>;
  /** Injected AbortController factory. */
  createAbortController: () => AbortController;
  /** Injected timeout factory. */
  createTimeout: (
    ms: number,
    signal: AbortSignal,
  ) => { cancel: () => void; promise: Promise<void> };
}

export interface ServiceProbeResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Response body as text (will be discarded unless policy permits). */
  bodyText?: string;
}

export interface ServiceObservationResult {
  serviceId: string;
  endpointId: string;
  outcome: ServiceOutcome;
  httpStatus: number | null;
  latencyMs: number | null;
  attemptCount: number;
  timestamp: string;
  evidence: EvidenceRecord[];
  /** Redacted error message. */
  error: string | null;
  /** Whether response body was retained (always false by default policy). */
  bodyRetained: boolean;
}

// ---------------------------------------------------------------------------
// Observer
// ---------------------------------------------------------------------------

/**
 * Probes an external service endpoint with an explicit typed policy.
 * Separates reachability from readiness.
 * Generic HTTP 200 does not automatically produce READY.
 * Timeout proves only that the probe timed out — does NOT determine CapabilityStatus.
 */
export function observeService(
  policy: ServicePolicy,
  deps: ServiceProbeDeps,
  meta: { now: () => string },
): Promise<ServiceObservationResult> {
  return observeServiceWithTimestamp(policy, deps, meta.now());
}

async function observeServiceWithTimestamp(
  policy: ServicePolicy,
  deps: ServiceProbeDeps,
  collectedAt: string,
): Promise<ServiceObservationResult> {
  const evidence: EvidenceRecord[] = [];

  // Validate policy
  const policyError = validatePolicy(policy);
  if (policyError) {
    evidence.push(
      createEvidenceRecord(
        {
          evidenceType: "HTTP",
          source: `service-probe:${policy.serviceId}`,
          collector: "ServiceObserver",
          confidence: "LOW",
          value: null,
          notes: `Invalid policy: ${policyError}`,
        },
        collectedAt,
      ),
    );
    return {
      serviceId: policy.serviceId,
      endpointId: policy.endpointId,
      outcome: "INVALID_POLICY",
      httpStatus: null,
      latencyMs: null,
      attemptCount: 0,
      timestamp: collectedAt,
      evidence,
      error: policyError,
      bodyRetained: false,
    };
  }

  const maxAttempts = policy.retryCount + 1;
  let lastError: string | null = null;
  let lastStatus: number | null = null;
  let lastLatency: number | null = null;
  let attemptCount = 0;
  const redaction = policy.redactionPolicy ?? "strict";

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    attemptCount++;
    const attemptStartedAt = Date.now();
    let timeoutHandle: { cancel: () => void; promise: Promise<void> } | null = null;

    try {
      const controller = deps.createAbortController();
      timeoutHandle = deps.createTimeout(policy.timeoutMs, controller.signal);
      const sanitizedUrl = redactSensitiveUrl(policy.url);
      const fetchPromise = deps.fetch(sanitizedUrl, {
        method: policy.method,
        headers: policy.sanitizedHeaders ?? {},
        signal: controller.signal,
      });
      const raceResult = await Promise.race([
        fetchPromise.then((response) => ({ kind: "response" as const, response })),
        timeoutHandle.promise.then(() => ({ kind: "timeout" as const })),
      ]);

      if (raceResult.kind === "timeout") {
        controller.abort();
        lastLatency = Date.now() - attemptStartedAt;
        evidence.push(
          createEvidenceRecord(
            {
              evidenceType: "HTTP",
              source: `service-probe:${policy.endpointId}`,
              collector: "ServiceObserver",
              confidence: "HIGH",
              value: null,
              notes: `Timeout after ${policy.timeoutMs}ms (attempt ${attemptCount})`,
            },
            collectedAt,
          ),
        );
        lastError = `Timeout after ${policy.timeoutMs}ms`;
        if (attempt === maxAttempts - 1) {
          return {
            serviceId: policy.serviceId,
            endpointId: policy.endpointId,
            outcome: "TIMEOUT",
            httpStatus: null,
            latencyMs: lastLatency,
            attemptCount,
            timestamp: collectedAt,
            evidence,
            error: lastError,
            bodyRetained: false,
          };
        }
        continue;
      }

      const response = raceResult.response;
      lastLatency = Date.now() - attemptStartedAt;
      lastStatus = response.status;

      // Check if response meets expected status
      if (policy.expectedStatus.includes(response.status)) {
        // Check readiness rules (separate from reachability)
        const readinessResult = checkReadiness(policy, response);
        if (readinessResult.ready) {
          evidence.push(
            createEvidenceRecord(
              {
                evidenceType: "HTTP",
                source: `service-probe:${policy.endpointId}`,
                collector: "ServiceObserver",
                confidence: "HIGH",
                value: null,
                notes: `Ready: status=${response.status}, latency=${lastLatency}ms, attempts=${attemptCount}`,
              },
              collectedAt,
            ),
          );
          return {
            serviceId: policy.serviceId,
            endpointId: policy.endpointId,
            outcome: "READY",
            httpStatus: response.status,
            latencyMs: lastLatency,
            attemptCount,
            timestamp: collectedAt,
            evidence,
            error: null,
            bodyRetained: false,
          };
        }

        // Reachable but not ready
        evidence.push(
          createEvidenceRecord(
            {
              evidenceType: "HTTP",
              source: `service-probe:${policy.endpointId}`,
              collector: "ServiceObserver",
              confidence: "HIGH",
              value: null,
              notes: `Reachable but not ready: status=${response.status}, reason=${readinessResult.reason}`,
            },
            collectedAt,
          ),
        );
        lastError = `Not ready: ${readinessResult.reason}`;
        // No more retries — return REACHABLE_NOT_READY
        if (attempt === maxAttempts - 1) {
          return {
            serviceId: policy.serviceId,
            endpointId: policy.endpointId,
            outcome: "REACHABLE_NOT_READY",
            httpStatus: response.status,
            latencyMs: lastLatency,
            attemptCount,
            timestamp: collectedAt,
            evidence,
            error: lastError,
            bodyRetained: false,
          };
        }
        continue; // retry if allowed
      } else {
        // Unexpected status
        const safeNotes =
          redaction === "strict"
            ? `Unexpected status: ${response.status}`
            : `Unexpected status: ${response.status} ${response.statusText}`;
        evidence.push(
          createEvidenceRecord(
            {
              evidenceType: "HTTP",
              source: `service-probe:${policy.endpointId}`,
              collector: "ServiceObserver",
              confidence: "HIGH",
              value: null,
              notes: safeNotes,
            },
            collectedAt,
          ),
        );
        lastError = safeNotes;

        // Check for auth required
        if (response.status === 401 || response.status === 403) {
          return {
            serviceId: policy.serviceId,
            endpointId: policy.endpointId,
            outcome: "AUTH_REQUIRED",
            httpStatus: response.status,
            latencyMs: lastLatency,
            attemptCount,
            timestamp: collectedAt,
            evidence,
            error: lastError,
            bodyRetained: false,
          };
        }

        continue; // retry if allowed
      }
    } catch (err) {
      lastLatency = Date.now() - attemptStartedAt;
      const errMsg = err instanceof Error ? err.message : String(err);
      const safeError = redaction === "strict" ? redactSensitiveString(errMsg) : errMsg;

      // Classify error
      if (
        errMsg.includes("aborted") ||
        errMsg.includes("timeout") ||
        errMsg.includes("TimeoutError")
      ) {
        evidence.push(
          createEvidenceRecord(
            {
              evidenceType: "HTTP",
              source: `service-probe:${policy.endpointId}`,
              collector: "ServiceObserver",
              confidence: "HIGH",
              value: null,
              notes: `Timeout after ${policy.timeoutMs}ms (attempt ${attemptCount})`,
            },
            collectedAt,
          ),
        );
        lastError = `Timeout after ${policy.timeoutMs}ms`;
        // Timeout proves only that the probe timed out — do not classify further
        if (attempt === maxAttempts - 1) {
          return {
            serviceId: policy.serviceId,
            endpointId: policy.endpointId,
            outcome: "TIMEOUT",
            httpStatus: null,
            latencyMs: lastLatency,
            attemptCount,
            timestamp: collectedAt,
            evidence,
            error: lastError,
            bodyRetained: false,
          };
        }
        continue;
      }

      if (errMsg.includes("ECONNREFUSED") || errMsg.includes("connection refused")) {
        evidence.push(
          createEvidenceRecord(
            {
              evidenceType: "HTTP",
              source: `service-probe:${policy.endpointId}`,
              collector: "ServiceObserver",
              confidence: "HIGH",
              value: null,
              notes: `Connection refused (attempt ${attemptCount})`,
            },
            collectedAt,
          ),
        );
        lastError = "Connection refused";
        if (attempt === maxAttempts - 1) {
          return {
            serviceId: policy.serviceId,
            endpointId: policy.endpointId,
            outcome: "CONNECTION_REFUSED",
            httpStatus: null,
            latencyMs: lastLatency,
            attemptCount,
            timestamp: collectedAt,
            evidence,
            error: lastError,
            bodyRetained: false,
          };
        }
        continue;
      }

      if (errMsg.includes("ENOTFOUND") || errMsg.includes("getaddrinfo")) {
        evidence.push(
          createEvidenceRecord(
            {
              evidenceType: "HTTP",
              source: `service-probe:${policy.endpointId}`,
              collector: "ServiceObserver",
              confidence: "HIGH",
              value: null,
              notes: `DNS error (attempt ${attemptCount})`,
            },
            collectedAt,
          ),
        );
        return {
          serviceId: policy.serviceId,
          endpointId: policy.endpointId,
          outcome: "DNS_ERROR",
          httpStatus: null,
          latencyMs: lastLatency,
          attemptCount,
          timestamp: collectedAt,
          evidence,
          error: "DNS resolution failed",
          bodyRetained: false,
        };
      }

      if (errMsg.includes("certificate") || errMsg.includes("SSL") || errMsg.includes("TLS")) {
        evidence.push(
          createEvidenceRecord(
            {
              evidenceType: "HTTP",
              source: `service-probe:${policy.endpointId}`,
              collector: "ServiceObserver",
              confidence: "HIGH",
              value: null,
              notes: `TLS error (attempt ${attemptCount})`,
            },
            collectedAt,
          ),
        );
        return {
          serviceId: policy.serviceId,
          endpointId: policy.endpointId,
          outcome: "TLS_ERROR",
          httpStatus: null,
          latencyMs: lastLatency,
          attemptCount,
          timestamp: collectedAt,
          evidence,
          error: safeError,
          bodyRetained: false,
        };
      }

      // Generic unexpected response / internal error
      evidence.push(
        createEvidenceRecord(
          {
            evidenceType: "HTTP",
            source: `service-probe:${policy.endpointId}`,
            collector: "ServiceObserver",
            confidence: "LOW",
            value: null,
            notes: `Internal error (attempt ${attemptCount}): ${safeError}`,
          },
          collectedAt,
        ),
      );
      lastError = safeError;

      if (attempt === maxAttempts - 1) {
        return {
          serviceId: policy.serviceId,
          endpointId: policy.endpointId,
          outcome: "INTERNAL_ERROR",
          httpStatus: null,
          latencyMs: lastLatency,
          attemptCount,
          timestamp: collectedAt,
          evidence,
          error: lastError,
          bodyRetained: false,
        };
      }
    } finally {
      timeoutHandle?.cancel();
    }
  }

  // Exhausted retries — return last error state
  return {
    serviceId: policy.serviceId,
    endpointId: policy.endpointId,
    outcome: "UNEXPECTED_RESPONSE",
    httpStatus: lastStatus,
    latencyMs: lastLatency,
    attemptCount,
    timestamp: collectedAt,
    evidence,
    error: lastError,
    bodyRetained: false,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validatePolicy(policy: ServicePolicy): string | null {
  if (!policy.serviceId || policy.serviceId.trim() === "") {
    return "serviceId is required";
  }
  if (!policy.endpointId || policy.endpointId.trim() === "") {
    return "endpointId is required";
  }
  if (!policy.url || policy.url.trim() === "") {
    return "url is required";
  }
  try {
    void new URL(policy.url);
  } catch {
    return "url is not a valid URL";
  }
  if (policy.timeoutMs <= 0 || !Number.isFinite(policy.timeoutMs)) {
    return "timeoutMs must be a positive finite number";
  }
  if (policy.retryCount !== 0 && policy.retryCount !== 1) {
    return "retryCount must be 0 or 1";
  }
  if (policy.expectedStatus.length === 0) {
    return "expectedStatus must not be empty";
  }
  return null;
}

function checkReadiness(
  policy: ServicePolicy,
  _response: ServiceProbeResponse,
): { ready: boolean; reason: string } {
  // Service-type-specific readiness rules (beyond HTTP 200)
  switch (policy.serviceType) {
    case "n8n":
      // n8n readiness endpoint — REQUIRES SOURCE VERIFICATION
      // Do not invent production readiness endpoints
      // If an endpoint cannot be proven, mark as REQUIRES SOURCE VERIFICATION
      // For now, generic HTTP 200 is not sufficient for READY
      return { ready: false, reason: "n8n readiness endpoint REQUIRES SOURCE VERIFICATION" };
    case "qdrant":
      // Qdrant readiness endpoint — REQUIRES SOURCE VERIFICATION
      return { ready: false, reason: "Qdrant readiness endpoint REQUIRES SOURCE VERIFICATION" };
    case "vllm":
      // vLLM readiness endpoint — REQUIRES SOURCE VERIFICATION
      return { ready: false, reason: "vLLM readiness endpoint REQUIRES SOURCE VERIFICATION" };
    default:
      // Unknown service type — do not produce READY from generic HTTP 200
      return { ready: false, reason: `Unknown service type: ${policy.serviceType}` };
  }
}
