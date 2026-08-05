/**
 * Core-private shared implementation for the spawned-session ownership lookup.
 *
 * This module is deliberately NOT part of the public plugin-sdk surface: it is
 * not listed in `scripts/lib/plugin-sdk-entrypoints.json`, so the three-state
 * result type and helper below are not published to plugins. The public
 * `openclaw/plugin-sdk/session-visibility` entrypoint keeps the legacy
 * Set-returning `listSpawnedSessionKeys` contract unchanged; the visibility
 * guard and the sandboxed session resolver import the discriminated variant
 * from here. See issue #114653.
 */
import { normalizeTrimmedStringList } from "../../packages/normalization-core/src/string-normalization.js";
import {
  GatewayCredentialsRequiredError,
  GatewayExplicitAuthRequiredError,
  GatewayLocalBackendSharedAuthUnavailableError,
  GatewayStoredDeviceAuthUnavailableError,
  isGatewayTransportError,
  callGateway as defaultCallGateway,
} from "../gateway/call.js";
import { GatewayClientRequestError } from "../gateway/client.js";
import { formatErrorMessage } from "../infra/errors.js";
import { logWarn } from "../logger.js";

type GatewayCaller = typeof defaultCallGateway;

/**
 * Classify a spawned-session ownership lookup failure for caller guidance.
 *
 * Only known temporary failures prescribe retry. Credential guidance is
 * reserved for the explicit pre-connect auth errors; all other failures remain
 * fail-closed with generic diagnostics instead of guessing at their cause.
 */
export type LookupFailureKind = "transient" | "credentials" | "unknown";

export function classifyLookupFailure(error: unknown): LookupFailureKind {
  if (isGatewayTransportError(error)) {
    return "transient";
  }
  if (error instanceof GatewayClientRequestError && error.retryable) {
    return "transient";
  }
  if (
    error instanceof GatewayCredentialsRequiredError ||
    error instanceof GatewayExplicitAuthRequiredError ||
    error instanceof GatewayStoredDeviceAuthUnavailableError ||
    error instanceof GatewayLocalBackendSharedAuthUnavailableError
  ) {
    return "credentials";
  }
  return "unknown";
}

/**
 * Shared denial suffix for a failed ownership lookup so direct and sandboxed
 * guards render the same cause-appropriate recovery guidance.
 */
export function lookupFailedDenialSuffix(kind: LookupFailureKind): string {
  if (kind === "transient") {
    return "spawned-session ownership lookup failed (transient); retry the operation.";
  }
  if (kind === "credentials") {
    return "spawned-session ownership lookup failed; check gateway configuration and credentials.";
  }
  return "spawned-session ownership lookup failed; check gateway logs for the reported error.";
}

let callGatewayForListSpawned: GatewayCaller = defaultCallGateway;

/** Test hook: must stay aligned with `sessions-resolution` `testing.setDepsForTest`. */
export const sessionVisibilityGatewayTesting = {
  setCallGatewayForListSpawned(overrides?: GatewayCaller) {
    callGatewayForListSpawned = overrides ?? defaultCallGateway;
  },
};

/**
 * Result of listing spawned-session keys. Distinguishes a successful (possibly
 * empty) lookup from a failed one so the visibility guard can tell a genuine
 * policy denial apart from a lookup failure. The failure kind preserves only
 * guidance supported by the caught error; unknown failures remain generic.
 */
export type SpawnedSessionKeysResult =
  | { ok: true; keys: Set<string> }
  | { ok: false; error: unknown; failureKind: LookupFailureKind };

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
    // Fail closed and stay observable: a failed ownership lookup must not
    // collapse into a genuine policy denial (issue #114653). Retry behavior is
    // intentionally not added here — retrying transient lookup failures is a
    // maintainer product decision (see the issue's maintainer-review labels),
    // so this path only classifies and logs the failure. Keep unknown causes
    // distinct from confirmed auth failures so recovery text never guesses.
    logWarn(
      `session-visibility: listSpawnedSessionKeys failed for requester=${params.requesterSessionKey}: ${formatErrorMessage(error)}`,
    );
    return { ok: false, error, failureKind: classifyLookupFailure(error) };
  }
}
