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
import { isGatewayTransportError, callGateway as defaultCallGateway } from "../gateway/call.js";
import { GatewayClientRequestError } from "../gateway/client.js";
import { formatErrorMessage } from "../infra/errors.js";
import { logWarn } from "../logger.js";

type GatewayCaller = typeof defaultCallGateway;

/**
 * Classify whether a spawned-session ownership lookup failure is worth retrying.
 *
 * Only known temporary failures are retryable: transport-level closes/timeouts,
 * and request-level errors the gateway itself marked `retryable`. Credential,
 * auth, and configuration failures surface before a socket is opened and will
 * not recover through retry, so they are non-retryable. Unknown errors are
 * treated as non-retryable so callers are not told to retry a failure that may
 * be permanent (review P1: classify before prescribing retry). See issue #114653.
 */
export function classifyLookupRetryable(error: unknown): boolean {
  if (isGatewayTransportError(error)) {
    return true;
  }
  if (error instanceof GatewayClientRequestError) {
    return (error as { retryable?: unknown }).retryable === true;
  }
  return false;
}

/**
 * Shared denial suffix for a failed ownership lookup, parameterized by
 * retryability so the direct guard and the sandboxed resolver render the same
 * distinct text. See issue #114653.
 */
export function lookupFailedDenialSuffix(retryable: boolean): string {
  return retryable
    ? "spawned-session ownership lookup failed (transient); retry the operation."
    : "spawned-session ownership lookup failed; check gateway configuration and credentials.";
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
 * policy denial apart from a lookup failure. The `retryable` flag on a failed
 * lookup carries the classification from {@link classifyLookupRetryable} so the
 * denial text can tell transient transport failures (retry) apart from
 * permanent credential/configuration failures (do not retry). See issue #114653.
 */
export type SpawnedSessionKeysResult =
  | { ok: true; keys: Set<string> }
  | { ok: false; error: unknown; retryable: boolean };

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
    // so this PR only classifies and logs the failure. The retryable flag
    // distinguishes temporary transport failures from permanent credential /
    // configuration failures so callers are not told to retry a non-retryable
    // access failure (review P1).
    logWarn(
      `session-visibility: listSpawnedSessionKeys failed for requester=${params.requesterSessionKey}: ${formatErrorMessage(error)}`,
    );
    return { ok: false, error, retryable: classifyLookupRetryable(error) };
  }
}
