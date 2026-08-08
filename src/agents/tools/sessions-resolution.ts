/**
 * Session key resolution helpers.
 *
 * Normalizes display/internal/current-session aliases and resolves session-id inputs through Gateway.
 */
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_IDS,
  normalizeGatewayClientId,
} from "../../../packages/gateway-protocol/src/client-info.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import {
  logSessionOwnershipLookupFailure,
  lookupFailedDenialMessage,
  lookupFailedOperationMessage,
  sessionOwnershipLookupFailure,
  sessionVisibilityGatewayTesting,
  type SessionOwnershipLookupFailure,
} from "../../plugin-sdk/session-visibility-internal.js";
import { createSessionVisibilityChecker } from "../../plugin-sdk/session-visibility.js";
import {
  isAcpSessionKey,
  isIncognitoSessionKey,
  normalizeMainKey,
} from "../../routing/session-key.js";
import { looksLikeSessionId } from "../../sessions/session-id.js";

type GatewayCaller = typeof callGateway;

const defaultSessionsResolutionDeps = {
  callGateway,
};

const CURRENT_SESSION_CLIENT_ALIAS_IDS = new Set<string>([
  GATEWAY_CLIENT_IDS.TUI,
  GATEWAY_CLIENT_IDS.CLI,
  GATEWAY_CLIENT_IDS.WEBCHAT_UI,
  GATEWAY_CLIENT_IDS.CONTROL_UI,
  GATEWAY_CLIENT_IDS.MACOS_APP,
  GATEWAY_CLIENT_IDS.IOS_APP,
  GATEWAY_CLIENT_IDS.ANDROID_APP,
]);

let sessionsResolutionDeps: {
  callGateway: GatewayCaller;
} = defaultSessionsResolutionDeps;

export function resolveMainSessionAlias(cfg: OpenClawConfig) {
  const mainKey = normalizeMainKey(cfg.session?.mainKey);
  const scope = cfg.session?.scope ?? "per-sender";
  const alias = scope === "global" ? "global" : mainKey;
  return { mainKey, alias, scope };
}

export function resolveDisplaySessionKey(params: { key: string; alias: string; mainKey: string }) {
  if (params.key === params.alias) {
    return "main";
  }
  if (params.key === params.mainKey) {
    return "main";
  }
  return params.key;
}

export function resolveInternalSessionKey(params: {
  key: string;
  alias: string;
  mainKey: string;
  requesterInternalKey?: string;
}) {
  if (params.key === "current") {
    return params.requesterInternalKey ?? params.key;
  }
  if (params.key === "main") {
    return params.alias;
  }
  return params.key;
}

export function resolveCurrentSessionClientAlias(params: {
  key: string;
  requesterInternalKey?: string;
}): string | undefined {
  const requesterKey = normalizeOptionalString(params.requesterInternalKey);
  if (!requesterKey) {
    return undefined;
  }
  const clientId = normalizeGatewayClientId(params.key);
  if (!clientId || !CURRENT_SESSION_CLIENT_ALIAS_IDS.has(clientId)) {
    return undefined;
  }
  // UI/client labels can appear next to the real session key in status text.
  // Treat them as the current requester instead of probing them as sessionIds.
  return requesterKey;
}

export function isExpectedSessionLookupMiss(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("No session found") &&
    (!(error instanceof GatewayClientRequestError) || error.gatewayCode === "INVALID_REQUEST")
  );
}

export async function lookupRequesterSessionOwnership(params: {
  requesterSessionKey: string;
  targetSessionKey: string;
}): Promise<Result<boolean, SessionOwnershipLookupFailure>> {
  if (params.requesterSessionKey === params.targetSessionKey) {
    return ok(true);
  }
  try {
    const resolved = await callGatewayResolveSession({
      key: params.targetSessionKey,
      spawnedBy: params.requesterSessionKey,
      allowMissing: true,
    });
    const resolvedKey = normalizeOptionalString(resolved?.key);
    return ok(resolvedKey === params.targetSessionKey);
  } catch (error) {
    if (isExpectedSessionLookupMiss(error)) {
      return ok(false);
    }
    return err(sessionOwnershipLookupFailure(error));
  }
}

function looksLikeSessionKey(value: string): boolean {
  const raw = normalizeOptionalString(value) ?? "";
  if (!raw) {
    return false;
  }
  // These are canonical key shapes that should never be treated as sessionIds.
  if (raw === "main" || raw === "global" || raw === "unknown" || raw === "current") {
    return true;
  }
  if (isAcpSessionKey(raw)) {
    return true;
  }
  if (raw.startsWith("agent:")) {
    return true;
  }
  if (raw.startsWith("cron:") || raw.startsWith("hook:")) {
    return true;
  }
  if (raw.startsWith("node-") || raw.startsWith("node:")) {
    return true;
  }
  if (raw.includes(":group:") || raw.includes(":channel:")) {
    return true;
  }
  return false;
}

export function shouldResolveSessionIdInput(value: string): boolean {
  // Treat anything that doesn't look like a well-formed key as a sessionId candidate.
  return looksLikeSessionId(value) || !looksLikeSessionKey(value);
}

type SessionReferenceResolution =
  | {
      ok: true;
      key: string;
      displayKey: string;
      resolvedViaSessionId: boolean;
      requesterOwned?: boolean;
    }
  | { ok: false; status: "error" | "forbidden"; error: string; notFound?: boolean };

type SessionReferenceAction = "history" | "send" | "status" | "list" | "search";

type VisibleSessionReferenceResolution =
  | {
      ok: true;
      key: string;
      displayKey: string;
      requesterOwned: boolean;
    }
  | {
      ok: false;
      status: "forbidden";
      error: string;
      displayKey: string;
    };

function buildResolvedSessionReference(params: {
  key: string;
  alias: string;
  mainKey: string;
  resolvedViaSessionId: boolean;
  requesterOwned: boolean;
}): Extract<SessionReferenceResolution, { ok: true }> {
  return {
    ok: true,
    key: params.key,
    displayKey: resolveDisplaySessionKey({
      key: params.key,
      alias: params.alias,
      mainKey: params.mainKey,
    }),
    resolvedViaSessionId: params.resolvedViaSessionId,
    requesterOwned: params.requesterOwned,
  };
}

function buildSessionIdResolveParams(params: {
  sessionId: string;
  requesterInternalKey?: string;
  restrictToSpawned: boolean;
  allowMissing?: boolean;
}) {
  return {
    sessionId: params.sessionId,
    spawnedBy: params.restrictToSpawned ? params.requesterInternalKey : undefined,
    includeGlobal: !params.restrictToSpawned,
    includeUnknown: !params.restrictToSpawned,
    ...(params.allowMissing ? { allowMissing: true } : {}),
  };
}

async function callGatewayResolveSession(
  params: Record<string, unknown> & { allowMissing?: boolean },
) {
  try {
    return await sessionsResolutionDeps.callGateway({
      method: "sessions.resolve",
      params,
    });
  } catch (error) {
    const olderGatewayRejectedProbe =
      params.allowMissing === true &&
      error instanceof GatewayClientRequestError &&
      error.gatewayCode === "INVALID_REQUEST" &&
      error.message.includes("invalid sessions.resolve params") &&
      error.message.includes("unexpected property 'allowMissing'");
    if (!olderGatewayRejectedProbe) {
      throw error;
    }
    // Protocol v4 gateways predating allowMissing reject the additive field.
    // Retry without it for mixed-version correctness; remove at the next protocol break.
    const legacyParams: Record<string, unknown> = { ...params };
    delete legacyParams.allowMissing;
    return await sessionsResolutionDeps.callGateway({
      method: "sessions.resolve",
      params: legacyParams,
    });
  }
}

type ResolvedReference = Extract<SessionReferenceResolution, { ok: true }>;
type ReferenceLookupResult = Result<ResolvedReference | null, SessionOwnershipLookupFailure>;

async function lookupSessionId(params: {
  sessionId: string;
  requesterInternalKey?: string;
  restrictToSpawned: boolean;
  allowMissing?: boolean;
}): Promise<Result<string | null, SessionOwnershipLookupFailure>> {
  try {
    const result = await callGatewayResolveSession(buildSessionIdResolveParams(params));
    return ok(normalizeOptionalString(result?.key) ?? null);
  } catch (error) {
    if (isExpectedSessionLookupMiss(error)) {
      return ok(null);
    }
    return err(sessionOwnershipLookupFailure(error));
  }
}

async function resolveSessionKeyFromSessionId(params: {
  sessionId: string;
  alias: string;
  mainKey: string;
  requesterInternalKey?: string;
  restrictToSpawned: boolean;
  allowMissing?: boolean;
}): Promise<ReferenceLookupResult> {
  // Resolve via gateway so store routing and spawnedBy policy are authoritative.
  const result = await lookupSessionId(params);
  if (!result.ok) {
    return result;
  }
  if (!result.value) {
    return ok(null);
  }
  return ok(
    buildResolvedSessionReference({
      key: result.value,
      alias: params.alias,
      mainKey: params.mainKey,
      resolvedViaSessionId: true,
      requesterOwned: params.restrictToSpawned,
    }),
  );
}

async function resolveSessionKeyFromKey(params: {
  key: string;
  alias: string;
  mainKey: string;
  requesterInternalKey?: string;
  restrictToSpawned: boolean;
  allowMissing?: boolean;
}): Promise<ReferenceLookupResult> {
  try {
    // Try key-based resolution first so non-standard keys keep working.
    const result = await callGatewayResolveSession({
      key: params.key,
      spawnedBy: params.restrictToSpawned ? params.requesterInternalKey : undefined,
      ...(params.allowMissing ? { allowMissing: true } : {}),
    });
    const key = normalizeOptionalString(result?.key) ?? "";
    if (!key) {
      return ok(null);
    }
    return ok(
      buildResolvedSessionReference({
        key,
        alias: params.alias,
        mainKey: params.mainKey,
        resolvedViaSessionId: false,
        requesterOwned: params.restrictToSpawned,
      }),
    );
  } catch (error) {
    if (isExpectedSessionLookupMiss(error)) {
      return ok(null);
    }
    return err(sessionOwnershipLookupFailure(error));
  }
}

async function resolveSessionReferenceByKeyOrSessionId(params: {
  raw: string;
  alias: string;
  mainKey: string;
  requesterInternalKey?: string;
  restrictToSpawned: boolean;
  allowMissing?: boolean;
  skipKeyLookup?: boolean;
  forceSessionIdLookup?: boolean;
}): Promise<ReferenceLookupResult> {
  if (!params.skipKeyLookup) {
    // Prefer key resolution to avoid misclassifying custom keys as sessionIds.
    const resolvedByKey = await resolveSessionKeyFromKey({
      key: params.raw,
      alias: params.alias,
      mainKey: params.mainKey,
      requesterInternalKey: params.requesterInternalKey,
      restrictToSpawned: params.restrictToSpawned,
      allowMissing: params.allowMissing,
    });
    if (!resolvedByKey.ok || resolvedByKey.value) {
      return resolvedByKey;
    }
  }
  if (!(params.forceSessionIdLookup || shouldResolveSessionIdInput(params.raw))) {
    return ok(null);
  }
  return await resolveSessionKeyFromSessionId({
    sessionId: params.raw,
    alias: params.alias,
    mainKey: params.mainKey,
    requesterInternalKey: params.requesterInternalKey,
    restrictToSpawned: params.restrictToSpawned,
    allowMissing: params.allowMissing,
  });
}

export async function resolveSessionReference(params: {
  action: SessionReferenceAction;
  sessionKey: string;
  alias: string;
  mainKey: string;
  requesterInternalKey?: string;
  restrictToSpawned: boolean;
}): Promise<SessionReferenceResolution> {
  const failedLookup = (failure: SessionOwnershipLookupFailure): SessionReferenceResolution => {
    logSessionOwnershipLookupFailure({
      requesterSessionKey: params.requesterInternalKey ?? "unknown",
      failure,
    });
    return {
      ok: false,
      status: params.restrictToSpawned ? "forbidden" : "error",
      error: params.restrictToSpawned
        ? lookupFailedDenialMessage(params.action, failure.kind)
        : lookupFailedOperationMessage(params.action, failure.kind),
    };
  };
  const rawInput =
    resolveCurrentSessionClientAlias({
      key: params.sessionKey,
      requesterInternalKey: params.requesterInternalKey,
    }) ?? params.sessionKey.trim();
  if (rawInput === "current") {
    const resolvedCurrent = await resolveSessionReferenceByKeyOrSessionId({
      raw: rawInput,
      alias: params.alias,
      mainKey: params.mainKey,
      requesterInternalKey: params.requesterInternalKey,
      restrictToSpawned: params.restrictToSpawned,
      allowMissing: true,
      skipKeyLookup: params.restrictToSpawned,
      forceSessionIdLookup: true,
    });
    if (!resolvedCurrent.ok) {
      return failedLookup(resolvedCurrent.error);
    }
    if (resolvedCurrent.value) {
      return resolvedCurrent.value;
    }
  }
  const raw =
    rawInput === "current" && params.requesterInternalKey ? params.requesterInternalKey : rawInput;
  if (shouldResolveSessionIdInput(raw)) {
    const resolvedByGateway = await resolveSessionReferenceByKeyOrSessionId({
      raw,
      alias: params.alias,
      mainKey: params.mainKey,
      requesterInternalKey: params.requesterInternalKey,
      restrictToSpawned: params.restrictToSpawned,
    });
    if (!resolvedByGateway.ok) {
      return failedLookup(resolvedByGateway.error);
    }
    if (resolvedByGateway.value) {
      return resolvedByGateway.value;
    }
    return {
      ok: false,
      status: params.restrictToSpawned ? "forbidden" : "error",
      notFound: true,
      error: params.restrictToSpawned
        ? `Session not visible from this sandboxed agent session: ${raw}`
        : `Session not found: ${raw} (use the full sessionKey from sessions_list)`,
    };
  }

  const resolvedKey = resolveInternalSessionKey({
    key: raw,
    alias: params.alias,
    mainKey: params.mainKey,
    requesterInternalKey: params.requesterInternalKey,
  });
  const displayKey = resolveDisplaySessionKey({
    key: resolvedKey,
    alias: params.alias,
    mainKey: params.mainKey,
  });
  return {
    ok: true,
    key: resolvedKey,
    displayKey,
    resolvedViaSessionId: false,
    requesterOwned: resolvedKey === params.requesterInternalKey,
  };
}

export async function resolveVisibleSessionReference(params: {
  action: SessionReferenceAction;
  resolvedSession: Extract<SessionReferenceResolution, { ok: true }>;
  requesterSessionKey: string;
  restrictToSpawned: boolean;
  visibilitySessionKey: string;
}): Promise<VisibleSessionReferenceResolution> {
  const resolvedKey = params.resolvedSession.key;
  const displayKey = params.resolvedSession.displayKey;
  const requesterOwnedByResolution =
    params.resolvedSession.requesterOwned ??
    (params.restrictToSpawned && params.resolvedSession.resolvedViaSessionId);
  // Cross-session tools persist their results into the caller transcript; an
  // incognito target must remain unreachable even from an incognito requester.
  if (isIncognitoSessionKey(resolvedKey)) {
    return {
      ok: false,
      status: "forbidden",
      error: `Session not visible from session tools: ${params.visibilitySessionKey}`,
      displayKey,
    };
  }
  const shouldVerifySpawnedVisibility =
    params.restrictToSpawned &&
    !requesterOwnedByResolution &&
    params.requesterSessionKey !== resolvedKey;
  const policyAction = params.action === "search" ? "history" : params.action;
  const scopedAccess =
    policyAction === "list"
      ? undefined
      : createSessionVisibilityChecker.resolveScopedAccess({
          action: policyAction,
          requesterSessionKey: params.requesterSessionKey,
          targetSessionKey: resolvedKey,
        });
  if (Boolean(scopedAccess) || !shouldVerifySpawnedVisibility) {
    return {
      ok: true,
      key: resolvedKey,
      displayKey,
      requesterOwned: requesterOwnedByResolution || params.requesterSessionKey === resolvedKey,
    };
  }
  const ownership = await lookupRequesterSessionOwnership({
    requesterSessionKey: params.requesterSessionKey,
    targetSessionKey: resolvedKey,
  });
  if (!ownership.ok) {
    logSessionOwnershipLookupFailure({
      requesterSessionKey: params.requesterSessionKey,
      failure: ownership.error,
    });
    return {
      ok: false,
      status: "forbidden",
      error: lookupFailedDenialMessage(params.action, ownership.error.kind),
      displayKey,
    };
  }
  if (!ownership.value) {
    return {
      ok: false,
      status: "forbidden",
      error: `Session not visible from this sandboxed agent session: ${params.visibilitySessionKey}`,
      displayKey,
    };
  }
  return { ok: true, key: resolvedKey, displayKey, requesterOwned: true };
}

const testing = {
  setDepsForTest(overrides?: Partial<{ callGateway: GatewayCaller }>) {
    sessionsResolutionDeps = overrides
      ? {
          ...defaultSessionsResolutionDeps,
          ...overrides,
        }
      : defaultSessionsResolutionDeps;
    sessionVisibilityGatewayTesting.setCallGatewayForListSpawned(
      overrides?.callGateway ?? defaultSessionsResolutionDeps.callGateway,
    );
  },
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.sessionsResolutionTestApi")] = {
    testing,
  };
}
