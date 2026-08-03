/**
 * Session key resolution helpers.
 *
 * Normalizes display/internal/current-session aliases and resolves session-id inputs through Gateway.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_IDS,
  normalizeGatewayClientId,
} from "../../../packages/gateway-protocol/src/client-info.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { logWarn } from "../../logger.js";
import {
  listSpawnedSessionKeysWithResult,
  lookupFailedDenialSuffix,
  sessionVisibilityGatewayTesting,
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

type SpawnedVisibilityOutcome =
  | { kind: "visible" }
  | { kind: "not-owned" }
  | { kind: "lookup-failed"; retryable: boolean };

/**
 * Detects the expected "No session found" miss from the speculative
 * `sessions.resolve` probe in {@link isRequesterSpawnedSessionVisible}. A valid
 * target outside the requester's spawned set is a normal policy miss, not an
 * operational lookup failure, so it must not trigger the warn trail (review P2).
 */
function isExpectedSessionResolveMiss(error: unknown): boolean {
  if (!(error instanceof GatewayClientRequestError)) {
    return false;
  }
  if (error.gatewayCode !== "INVALID_REQUEST") {
    return false;
  }
  return Boolean(error.message?.includes("No session found"));
}

async function isRequesterSpawnedSessionVisible(params: {
  requesterSessionKey: string;
  targetSessionKey: string;
  limit?: number;
}): Promise<SpawnedVisibilityOutcome> {
  if (params.requesterSessionKey === params.targetSessionKey) {
    return { kind: "visible" };
  }
  try {
    // This is a speculative probe: a valid target outside the requester's
    // spawned set is an EXPECTED miss, not an operational failure. Pass
    // `allowMissing: true` so the gateway returns a successful no-match
    // response instead of throwing "No session found" — otherwise routine
    // sandbox policy denials get logged as lookup faults and bury the real
    // failures this PR is meant to diagnose (review P2). Only a genuine
    // transport/credential error throws here and is logged below.
    const resolved = await callGatewayResolveSession({
      key: params.targetSessionKey,
      spawnedBy: params.requesterSessionKey,
      allowMissing: true,
    });
    if (typeof resolved?.key === "string" && resolved.key.trim() === params.targetSessionKey) {
      return { kind: "visible" };
    }
  } catch (error) {
    // A valid target outside the requester's spawned set is an EXPECTED miss
    // on this speculative probe (the resolver deliberately falls back to
    // `sessions.list` below). On newer gateways `allowMissing: true` makes the
    // server return a successful no-match response so no error is thrown; on
    // older gateways that reject the additive field the retry surfaces the
    // normal "No session found" INVALID_REQUEST. Either way this is not an
    // operational lookup failure, so suppress the warn and fall back quietly —
    // logging it would bury the real failures this PR is meant to diagnose
    // (review P2). Only a genuine transport/credential error is logged.
    if (!isExpectedSessionResolveMiss(error)) {
      logWarn(
        `sessions-resolution: sessions.resolve threw for requester=${params.requesterSessionKey} target=${params.targetSessionKey}: ${formatErrorMessage(error)}`,
      );
    }
  }
  const result = await listSpawnedSessionKeysWithResult({
    requesterSessionKey: params.requesterSessionKey,
    limit: params.limit,
  });
  // A failed lookup fail-closes as a distinct outcome carrying retryability, so
  // a transient transport failure (retry) is distinguishable from a permanent
  // credential/configuration failure (do not retry); it must not collapse into
  // the generic sandboxed-session denial (review P1: classify before prescribing retry).
  if (!result.ok) {
    return { kind: "lookup-failed", retryable: result.retryable };
  }
  return result.keys.has(params.targetSessionKey) ? { kind: "visible" } : { kind: "not-owned" };
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
    }
  | { ok: false; status: "error" | "forbidden"; error: string };

type VisibleSessionReferenceResolution =
  | {
      ok: true;
      key: string;
      displayKey: string;
    }
  | {
      ok: false;
      status: "forbidden";
      error: string;
      displayKey: string;
    };

function resolutionActionPrefix(action: "history" | "send" | "status" | "list"): string {
  if (action === "history") {
    return "Session history";
  }
  if (action === "send") {
    return "Session send";
  }
  if (action === "status") {
    return "Session status";
  }
  return "Session list";
}

function buildResolvedSessionReference(params: {
  key: string;
  alias: string;
  mainKey: string;
  resolvedViaSessionId: boolean;
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

async function callGatewayResolveSessionId(params: {
  sessionId: string;
  requesterInternalKey?: string;
  restrictToSpawned: boolean;
  allowMissing?: boolean;
}): Promise<string> {
  const result = await callGatewayResolveSession(buildSessionIdResolveParams(params));
  const key = normalizeOptionalString(result?.key) ?? "";
  if (!key) {
    throw new Error(
      `Session not found: ${params.sessionId} (use the full sessionKey from sessions_list)`,
    );
  }
  return key;
}

async function resolveSessionKeyFromSessionId(params: {
  sessionId: string;
  alias: string;
  mainKey: string;
  requesterInternalKey?: string;
  restrictToSpawned: boolean;
  allowMissing?: boolean;
}): Promise<SessionReferenceResolution> {
  try {
    // Resolve via gateway so we respect store routing and visibility rules.
    const key = await callGatewayResolveSessionId(params);
    return buildResolvedSessionReference({
      key,
      alias: params.alias,
      mainKey: params.mainKey,
      resolvedViaSessionId: true,
    });
  } catch (err) {
    if (params.restrictToSpawned) {
      return {
        ok: false,
        status: "forbidden",
        error: `Session not visible from this sandboxed agent session: ${params.sessionId}`,
      };
    }
    const message = formatErrorMessage(err);
    return {
      ok: false,
      status: "error",
      error:
        message ||
        `Session not found: ${params.sessionId} (use the full sessionKey from sessions_list)`,
    };
  }
}

async function resolveSessionKeyFromKey(params: {
  key: string;
  alias: string;
  mainKey: string;
  requesterInternalKey?: string;
  restrictToSpawned: boolean;
  allowMissing?: boolean;
}): Promise<SessionReferenceResolution | null> {
  try {
    // Try key-based resolution first so non-standard keys keep working.
    const result = await callGatewayResolveSession({
      key: params.key,
      spawnedBy: params.restrictToSpawned ? params.requesterInternalKey : undefined,
      ...(params.allowMissing ? { allowMissing: true } : {}),
    });
    const key = normalizeOptionalString(result?.key) ?? "";
    if (!key) {
      return null;
    }
    return buildResolvedSessionReference({
      key,
      alias: params.alias,
      mainKey: params.mainKey,
      resolvedViaSessionId: false,
    });
  } catch {
    return null;
  }
}

async function tryResolveSessionKeyFromSessionId(params: {
  sessionId: string;
  alias: string;
  mainKey: string;
  requesterInternalKey?: string;
  restrictToSpawned: boolean;
  allowMissing?: boolean;
}): Promise<Extract<SessionReferenceResolution, { ok: true }> | null> {
  try {
    const key = await callGatewayResolveSessionId(params);
    return buildResolvedSessionReference({
      key,
      alias: params.alias,
      mainKey: params.mainKey,
      resolvedViaSessionId: true,
    });
  } catch {
    return null;
  }
}

async function resolveSessionReferenceByKeyOrSessionId(params: {
  raw: string;
  alias: string;
  mainKey: string;
  requesterInternalKey?: string;
  restrictToSpawned: boolean;
  allowUnresolvedSessionId: boolean;
  allowMissing?: boolean;
  skipKeyLookup?: boolean;
  forceSessionIdLookup?: boolean;
}): Promise<SessionReferenceResolution | null> {
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
    if (resolvedByKey) {
      return resolvedByKey;
    }
  }
  if (!(params.forceSessionIdLookup || shouldResolveSessionIdInput(params.raw))) {
    return null;
  }
  if (params.allowUnresolvedSessionId) {
    return await tryResolveSessionKeyFromSessionId({
      sessionId: params.raw,
      alias: params.alias,
      mainKey: params.mainKey,
      requesterInternalKey: params.requesterInternalKey,
      restrictToSpawned: params.restrictToSpawned,
      allowMissing: params.allowMissing,
    });
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
  sessionKey: string;
  alias: string;
  mainKey: string;
  requesterInternalKey?: string;
  restrictToSpawned: boolean;
}): Promise<SessionReferenceResolution> {
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
      allowUnresolvedSessionId: true,
      allowMissing: true,
      skipKeyLookup: params.restrictToSpawned,
      forceSessionIdLookup: true,
    });
    if (resolvedCurrent) {
      return resolvedCurrent;
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
      allowUnresolvedSessionId: false,
    });
    if (resolvedByGateway) {
      return resolvedByGateway;
    }
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
  return { ok: true, key: resolvedKey, displayKey, resolvedViaSessionId: false };
}

export async function resolveVisibleSessionReference(params: {
  action: "history" | "send" | "status" | "list";
  resolvedSession: Extract<SessionReferenceResolution, { ok: true }>;
  requesterSessionKey: string;
  restrictToSpawned: boolean;
  visibilitySessionKey: string;
}): Promise<VisibleSessionReferenceResolution> {
  const resolvedKey = params.resolvedSession.key;
  const displayKey = params.resolvedSession.displayKey;
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
    !params.resolvedSession.resolvedViaSessionId &&
    params.requesterSessionKey !== resolvedKey;
  const scopedAccess =
    params.action === "list"
      ? undefined
      : createSessionVisibilityChecker.resolveScopedAccess({
          action: params.action,
          requesterSessionKey: params.requesterSessionKey,
          targetSessionKey: resolvedKey,
        });
  if (Boolean(scopedAccess) || !shouldVerifySpawnedVisibility) {
    return { ok: true, key: resolvedKey, displayKey };
  }
  const spawnedOutcome = await isRequesterSpawnedSessionVisible({
    requesterSessionKey: params.requesterSessionKey,
    targetSessionKey: resolvedKey,
  });
  if (spawnedOutcome.kind === "lookup-failed") {
    return {
      ok: false,
      status: "forbidden",
      error: `${resolutionActionPrefix(params.action)} denied because ${lookupFailedDenialSuffix(spawnedOutcome.retryable)}`,
      displayKey,
    };
  }
  if (spawnedOutcome.kind === "not-owned") {
    return {
      ok: false,
      status: "forbidden",
      error: `Session not visible from this sandboxed agent session: ${params.visibilitySessionKey}`,
      displayKey,
    };
  }
  return { ok: true, key: resolvedKey, displayKey };
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
