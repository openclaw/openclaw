import { normalizeSortedUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import {
  WORKER_PROTOCOL_MAX_FEATURE_LENGTH,
  WORKER_PROTOCOL_MAX_FEATURES,
  WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type {
  WorkerDesktopEndpoint,
  WorkerSshEndpoint,
} from "../../plugins/capability-provider.types.js";
import { isValidSecretRef } from "../../secrets/ref-contract.js";
import type { WorkerEnvironmentBootstrapReceipt } from "./environment-record.js";
import { workerEnvironmentStateRequiresLease, type WorkerEnvironmentState } from "./state.js";

export const TERMINAL_STATES: WorkerEnvironmentState[] = ["destroyed", "failed", "orphaned"];
const WORKER_BUNDLE_HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_HOST_KEY_LENGTH = 16_384;
const MAX_SSH_FALLBACK_PORTS = 10;
const WORKER_CREDENTIAL_HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const OPENSSH_HOST_KEY_TYPE_PATTERN =
  /^(?:ssh|ecdsa-sha2|sk-(?:ssh|ecdsa-sha2))-[A-Za-z0-9@._+-]+$/u;
const OPENSSH_HOST_KEY_DATA_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u;
export function requireWorkerEnvironmentString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Worker environment ${field} must be a non-empty string`);
  }
  return value.trim();
}
function normalizeOpenSshHostKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_HOST_KEY_LENGTH ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    throw new Error("Worker environment SSH host key must be one OpenSSH public-key line");
  }
  const tokens = value.trim().split(/\s+/u);
  const [algorithm, encodedKey] = tokens;
  if (
    tokens.length !== 2 ||
    !algorithm ||
    !encodedKey ||
    !OPENSSH_HOST_KEY_TYPE_PATTERN.test(algorithm) ||
    !OPENSSH_HOST_KEY_DATA_PATTERN.test(encodedKey) ||
    encodedKey.length % 4 !== 0
  ) {
    throw new Error("Worker environment SSH host key must use OpenSSH public-key format");
  }
  return `${algorithm} ${encodedKey}`;
}
export function normalizeBootstrapReceipt(value: {
  bundleHash: unknown;
  openclawVersion: unknown;
  protocolFeatures: unknown;
  installKind?: unknown;
}): WorkerEnvironmentBootstrapReceipt {
  const bundleHash = requireWorkerEnvironmentString(value.bundleHash, "bootstrap bundle hash");
  if (!WORKER_BUNDLE_HASH_PATTERN.test(bundleHash)) {
    throw new Error("Worker environment bootstrap bundle hash must be lowercase SHA-256 hex");
  }
  if (!Array.isArray(value.protocolFeatures)) {
    throw new Error("Worker environment bootstrap protocol features must be an array");
  }
  if (
    value.protocolFeatures.length > WORKER_PROTOCOL_MAX_FEATURES ||
    value.protocolFeatures.some(
      (feature) =>
        typeof feature !== "string" || feature.trim().length > WORKER_PROTOCOL_MAX_FEATURE_LENGTH,
    )
  ) {
    throw new Error("Worker environment bootstrap protocol features exceed admission limits");
  }
  if (
    value.installKind !== undefined &&
    value.installKind !== "bundle" &&
    value.installKind !== "local"
  ) {
    throw new Error("Worker environment bootstrap install kind is invalid");
  }
  return {
    bundleHash,
    openclawVersion: requireWorkerEnvironmentString(
      value.openclawVersion,
      "bootstrap OpenClaw version",
    ),
    protocolFeatures: normalizeSortedUniqueTrimmedStringList(value.protocolFeatures),
    ...(value.installKind ? { installKind: value.installKind } : {}),
  };
}
export function normalizeCredentialHash(value: unknown): string {
  const credentialHash = requireWorkerEnvironmentString(value, "credential hash");
  if (!WORKER_CREDENTIAL_HASH_PATTERN.test(credentialHash)) {
    throw new Error("Worker credential hash must be a SHA-256 base64url digest");
  }
  return credentialHash;
}
export function normalizeSessionId(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  const sessionId = requireWorkerEnvironmentString(value, "credential session id");
  if (sessionId.length > WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH) {
    throw new Error("Worker credential session id exceeds the admission limit");
  }
  return sessionId;
}
export function normalizeAttachedSessionIds(value: unknown): string[] {
  const sessionIds = normalizeSortedUniqueTrimmedStringList(value);
  for (const sessionId of sessionIds) {
    if (sessionId.length > WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH) {
      throw new Error("Worker environment attached session id exceeds the admission limit");
    }
  }
  return sessionIds;
}
export function assertCredentialSessionBinding(
  attachedSessionIds: readonly string[],
  sessionId: string | null,
): void {
  if (sessionId !== (attachedSessionIds[0] ?? null)) {
    throw new Error("Worker credential session does not match the environment attachment");
  }
}
export function normalizeRpcSetVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("Worker credential RPC-set version must be a positive safe integer");
  }
  return value;
}
export function normalizeExpiry(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Worker credential expiry must be a non-negative safe integer");
  }
  return value;
}
export function normalizeWorkerSshEndpoint(value: WorkerSshEndpoint): WorkerSshEndpoint {
  const host = requireWorkerEnvironmentString(value.host, "SSH host");
  const user = requireWorkerEnvironmentString(value.user, "SSH user");
  const hostKey = normalizeOpenSshHostKey(value.hostKey);
  if (!Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65_535) {
    throw new Error("Worker environment SSH port must be an integer from 1 through 65535");
  }
  if (!isValidSecretRef(value.keyRef)) {
    throw new Error("Worker environment SSH key must be a canonical SecretRef");
  }
  if (value.fallbackPorts !== undefined && !Array.isArray(value.fallbackPorts)) {
    throw new Error("Worker environment SSH fallback ports must be an array");
  }
  const seen = new Set([value.port]);
  const fallbackPorts: number[] = [];
  for (const port of value.fallbackPorts ?? []) {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new Error(
        "Worker environment SSH fallback ports must be integers from 1 through 65535",
      );
    }
    if (!seen.has(port)) {
      seen.add(port);
      fallbackPorts.push(port);
    }
  }
  if (fallbackPorts.length > MAX_SSH_FALLBACK_PORTS) {
    throw new Error(
      `Worker environment SSH fallback ports cannot exceed ${MAX_SSH_FALLBACK_PORTS}`,
    );
  }
  return {
    host,
    port: value.port,
    ...(fallbackPorts.length > 0 ? { fallbackPorts } : {}),
    user,
    hostKey,
    keyRef: { ...value.keyRef },
  };
}
export function assertShape(
  state: WorkerEnvironmentState,
  leaseId: string | null,
  nodeDeviceId: string | null,
  sshEndpoint: WorkerSshEndpoint | null,
  desktop: WorkerDesktopEndpoint | null,
  bootstrapReceipt: WorkerEnvironmentBootstrapReceipt | null,
  attachedSessionIds: readonly string[],
): void {
  if (sshEndpoint && nodeDeviceId) {
    throw new Error("Worker environment cannot retain both SSH and node transports");
  }
  if (workerEnvironmentStateRequiresLease(state)) {
    if (!leaseId) {
      throw new Error(`Worker environment state ${state} requires a provider lease`);
    }
    if (state === "bootstrapping" && !sshEndpoint) {
      throw new Error("Worker environment bootstrap requires an SSH endpoint reference");
    }
    if (state === "ready" && !sshEndpoint && !nodeDeviceId) {
      throw new Error("Ready worker environment requires a transport binding");
    }
  } else if (leaseId || sshEndpoint || desktop) {
    throw new Error(`Worker environment state ${state} cannot retain a provider lease`);
  }
  if (state === "bootstrapping" && bootstrapReceipt) {
    throw new Error("Bootstrapping worker environment cannot retain a stale bootstrap receipt");
  }
  if (state === "attached" && attachedSessionIds.length !== 1) {
    throw new Error("Attached worker environment requires exactly one session id");
  }
  if (state !== "attached" && attachedSessionIds.length !== 0) {
    throw new Error("Only an attached worker environment may retain a session id");
  }
}
