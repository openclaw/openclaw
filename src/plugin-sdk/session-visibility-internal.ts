/** Core-private spawned-session ownership lookup; not a published plugin SDK subpath. */
import { normalizeTrimmedStringList } from "../../packages/normalization-core/src/string-normalization.js";
import {
  GatewayCredentialsRequiredError,
  GatewayExplicitAuthRequiredError,
  isGatewayTransportError,
  callGateway as defaultCallGateway,
} from "../gateway/call.js";
import { GatewayClientRequestError } from "../gateway/client.js";
import { GatewaySecretRefUnavailableError } from "../gateway/credentials.js";
import { formatErrorMessage } from "../infra/errors.js";
import { logWarn } from "../logger.js";

type GatewayCaller = typeof defaultCallGateway;

export type LookupFailureKind = "transient" | "credentials" | "unknown";

export function classifyLookupFailure(error: unknown): LookupFailureKind {
  if (error instanceof GatewayClientRequestError && error.retryable) {
    return "transient";
  }
  if (
    isGatewayTransportError(error) &&
    (error.kind === "timeout" || error.code === 1006 || error.code === 1013)
  ) {
    return "transient";
  }
  if (
    error instanceof GatewayCredentialsRequiredError ||
    error instanceof GatewayExplicitAuthRequiredError ||
    error instanceof GatewaySecretRefUnavailableError
  ) {
    return "credentials";
  }
  return "unknown";
}

export function lookupFailedDenialSuffix(kind: LookupFailureKind): string {
  if (kind === "transient") {
    return "spawned-session ownership lookup failed (transient); retry the operation.";
  }
  if (kind === "credentials") {
    return "spawned-session ownership lookup failed; ask the operator to check gateway configuration and credentials.";
  }
  return "spawned-session ownership lookup failed; ask the operator to inspect OpenClaw logs.";
}

export function lookupFailedDenialMessage(
  action: "history" | "send" | "status" | "list",
  kind: LookupFailureKind,
): string {
  const label = action === "list" ? "Session list" : `Session ${action}`;
  return `${label} denied because ${lookupFailedDenialSuffix(kind)}`;
}

let callGatewayForListSpawned: GatewayCaller = defaultCallGateway;

/** Test hook: must stay aligned with `sessions-resolution` `testing.setDepsForTest`. */
export const sessionVisibilityGatewayTesting = {
  setCallGatewayForListSpawned(overrides?: GatewayCaller) {
    callGatewayForListSpawned = overrides ?? defaultCallGateway;
  },
};

export type SpawnedSessionKeysResult =
  | { ok: true; keys: Set<string> }
  | { ok: false; failureKind: LookupFailureKind };

/** List sessions spawned by the requester through the gateway session list method. */
export async function listSpawnedSessionKeysWithResult(params: {
  requesterSessionKey: string;
  limit?: number;
}): Promise<SpawnedSessionKeysResult> {
  const limit =
    typeof params.limit === "number" && Number.isFinite(params.limit)
      ? Math.max(1, Math.floor(params.limit))
      : undefined;
  try {
    const list = await callGatewayForListSpawned<{ sessions: Array<{ key?: unknown }> }>({
      method: "sessions.list",
      params: {
        includeGlobal: false,
        includeUnknown: false,
        ...(limit !== undefined ? { limit } : {}),
        spawnedBy: params.requesterSessionKey,
      },
    });
    const sessions = Array.isArray(list?.sessions) ? list.sessions : [];
    const keys = normalizeTrimmedStringList(sessions.map((entry) => entry?.key));
    return { ok: true, keys: new Set(keys) };
  } catch (error) {
    logWarn(
      `session-visibility: listSpawnedSessionKeys failed for requester=${params.requesterSessionKey}: ${formatErrorMessage(error)}`,
    );
    return { ok: false, failureKind: classifyLookupFailure(error) };
  }
}
