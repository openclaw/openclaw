import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { tryResolveLegacyCompatibilityAgentId } from "../../config/legacy.default-agent-owner.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../../config/sessions/session-store-owner.js";
import {
  logSessionOwnershipLookupFailure,
  lookupFailedDenialMessage,
  lookupFailedOperationMessage,
  sessionOwnershipLookupFailure,
} from "../../plugin-sdk/session-visibility-internal.js";
import {
  classifySessionKeyShape,
  isUnscopedSessionKeySentinel,
  normalizeAgentId,
  normalizeAgentIdStrict,
} from "../../routing/session-key.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { readToolStringParam } from "./common.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import {
  createSessionVisibilityRowChecker,
  isExpectedSessionLookupMiss,
  resolveDisplaySessionKey,
  resolveSessionReference,
  resolveVisibleSessionReference,
  type resolveSessionToolContext,
} from "./sessions-helpers.js";
import {
  isConfiguredAgentMainSessionKey,
  resolveConfiguredAgentMainSessionKey,
  sessionsSendFailure,
} from "./sessions-send-tool.delivery.js";

/** Resolve key/label once and bind the physical owner before access, approval, or delivery. */
export async function prepareSessionsSendTarget(input: {
  toolContext: ReturnType<typeof resolveSessionToolContext>;
  toolParams: Record<string, unknown>;
  requesterAgentId: string;
  callGateway: AgentToolGatewayRequestCaller;
}) {
  const {
    cfg,
    mainKey,
    alias,
    effectiveRequesterKey,
    mainSessionKey,
    restrictToSpawned,
    sessionVisibility,
    a2aPolicy,
  } = input.toolContext;
  const { requesterAgentId, callGateway: gatewayCall, toolParams: params } = input;
  const fail = (...args: Parameters<typeof sessionsSendFailure>) => ({
    ok: false as const,
    result: sessionsSendFailure(...args),
  });
  const sessionKeyParam = readToolStringParam(params, "sessionKey");
  const labelParam = readToolStringParam(params, "label");
  const labelAgentIdInput = readToolStringParam(params, "agentId");
  const normalizedLabelAgentId =
    labelAgentIdInput === undefined ? null : normalizeAgentIdStrict(labelAgentIdInput);
  if (normalizedLabelAgentId && !normalizedLabelAgentId.ok) {
    return fail(
      "error",
      `Agent "${labelAgentIdInput}" not found. Run openclaw agents list to see configured agents.`,
    );
  }
  const explicitTargetAgentId = normalizedLabelAgentId?.value;

  let sessionKey = sessionKeyParam;
  let resolvedTargetAgentId: string | undefined;
  let resolvedLabelKey: string | undefined;
  if (!sessionKey && !labelParam && explicitTargetAgentId) {
    const agentMainKey = resolveConfiguredAgentMainSessionKey({
      cfg,
      agentId: explicitTargetAgentId,
      mainKey,
    });
    if (!agentMainKey) {
      return fail(
        "error",
        `Agent "${labelAgentIdInput}" not found. Run openclaw agents list to see configured agents.`,
      );
    }
    sessionKey = agentMainKey;
  }
  if (!sessionKey && labelParam) {
    const requestedAgentId = explicitTargetAgentId ?? requesterAgentId;

    if (restrictToSpawned && requestedAgentId && requestedAgentId !== requesterAgentId) {
      return fail("forbidden", "Sandboxed sessions_send label lookup is limited to this agent");
    }

    // A label is discovery, not an exact scoped grant. Unknown foreign labels
    // cannot use a child/key grant to bypass the agent-wide lookup ceiling.
    if (requestedAgentId !== requesterAgentId) {
      if (
        sessionVisibility !== "all" ||
        !a2aPolicy.enabled ||
        !a2aPolicy.isAllowed(requesterAgentId, requestedAgentId)
      ) {
        return fail(
          "forbidden",
          "Cross-agent label lookup is not permitted by the current session visibility and agent-to-agent policy. Use an already-authorized exact session key for owned tasks or scoped grants.",
        );
      }
    } else if (sessionVisibility === "self") {
      return fail(
        "forbidden",
        "Label discovery is unavailable with self visibility; use the calling session's exact key.",
      );
    }
    const lookupOwnChildren =
      restrictToSpawned ||
      (sessionVisibility === "tree" && effectiveRequesterKey !== mainSessionKey);
    const resolveParams: Record<string, unknown> = {
      label: labelParam,
      ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
      ...(lookupOwnChildren ? { spawnedBy: effectiveRequesterKey } : {}),
    };
    let resolvedKey;
    try {
      const resolved = await gatewayCall<{ agentId?: string; key: string }>({
        method: "sessions.resolve",
        params: resolveParams,
        timeoutMs: 10_000,
      });
      resolvedKey = normalizeOptionalString(resolved?.key) ?? "";
      resolvedTargetAgentId = normalizeOptionalString(resolved?.agentId);
    } catch (err) {
      if (isExpectedSessionLookupMiss(err)) {
        resolvedKey = "";
      } else {
        const failure = sessionOwnershipLookupFailure(err);
        logSessionOwnershipLookupFailure({
          requesterSessionKey: effectiveRequesterKey,
          failure,
        });
        return fail(
          restrictToSpawned ? "forbidden" : "error",
          restrictToSpawned
            ? lookupFailedDenialMessage("send", failure.kind)
            : lookupFailedOperationMessage("send", failure.kind),
        );
      }
    }

    if (!resolvedKey) {
      if (restrictToSpawned) {
        return fail("forbidden", "Session not visible from this sandboxed agent session.");
      }
      return fail("error", `No session found with label: ${labelParam}`);
    }
    sessionKey = resolvedKey;
    resolvedLabelKey = resolvedKey;
  }

  if (!sessionKey) {
    return fail("error", "Either sessionKey or label is required");
  }
  const allowMissingKey = isConfiguredAgentMainSessionKey({
    cfg,
    sessionKey,
    mainKey,
  });
  const resolvedSession = resolvedLabelKey
    ? {
        ok: true as const,
        ...(resolvedTargetAgentId ? { agentId: resolvedTargetAgentId } : {}),
        key: resolvedLabelKey,
        displayKey: resolveDisplaySessionKey({ key: resolvedLabelKey, alias, mainKey }),
        resolvedViaSessionId: false,
        requesterOwned: restrictToSpawned,
      }
    : await resolveSessionReference({
        action: "send",
        sessionKey,
        keyAgentId: requesterAgentId,
        alias,
        mainKey,
        requesterInternalKey: effectiveRequesterKey,
        restrictToSpawned,
        callGateway: gatewayCall,
      });
  if (!resolvedSession.ok) {
    return fail(resolvedSession.status, resolvedSession.error);
  }
  const resolutionAccess = createSessionVisibilityRowChecker({
    action: "send",
    defaultAgentId:
      resolvedSession.agentId ??
      resolveSessionAgentId({ config: cfg, sessionKey: resolvedSession.key }),
    requesterAgentId,
    requesterSessionKey: effectiveRequesterKey,
    mainSessionKey,
    visibility: sessionVisibility,
    a2aPolicy,
  }).check({ key: resolvedSession.key });
  const visibleSession = await resolveVisibleSessionReference({
    action: "send",
    resolvedSession,
    requesterSessionKey: effectiveRequesterKey,
    requesterAgentId,
    restrictToSpawned,
    visibilitySessionKey: sessionKey,
    allowMissingKey,
    concealResolutionError: resolutionAccess.allowed ? undefined : resolutionAccess.error,
    callGateway: gatewayCall,
  });
  // A label is user-supplied discovery text, not permission to reveal its resolved key.
  const unresolvedDisplayKey = resolvedLabelKey ? undefined : sessionKey;
  if (!visibleSession.ok) {
    return fail(
      visibleSession.status,
      resolvedLabelKey
        ? "The session selected by this label is not available for communication."
        : visibleSession.error,
      unresolvedDisplayKey,
    );
  }
  const resolvedKey = visibleSession.key;
  const displayKey = visibleSession.displayKey;
  const resolvedKeyAgentId = parseAgentSessionKey(resolvedKey)?.agentId;
  const isLiteralLegacyKeyInput =
    !labelParam && sessionKeyParam !== undefined && !resolvedSession.resolvedViaSessionId;
  const isLiteralUnscopedTarget =
    isLiteralLegacyKeyInput && classifySessionKeyShape(resolvedKey) === "legacy_or_alias";
  const persistedTargetOwner = isLiteralUnscopedTarget
    ? resolvePersistedSessionStoreOwnerForKey(cfg, resolvedKey)
    : { kind: "none" as const };
  const compatibilityTargetAgentId =
    isLiteralUnscopedTarget && persistedTargetOwner.kind === "none"
      ? tryResolveLegacyCompatibilityAgentId(cfg)
      : undefined;
  const isLiteralUnscopedMainTarget =
    isLiteralUnscopedTarget &&
    (isUnscopedSessionKeySentinel(sessionKeyParam.trim()) ||
      sessionKeyParam.trim().toLowerCase() === mainKey);
  if (persistedTargetOwner.kind === "retired") {
    return fail(
      "forbidden",
      "Session ownership could not be verified because its fixed-store owner retired.",
      unresolvedDisplayKey,
    );
  }
  const resolvedTargetOwner =
    visibleSession.agentId ??
    resolvedTargetAgentId ??
    (labelParam ? explicitTargetAgentId : undefined);
  if (
    persistedTargetOwner.kind === "configured" &&
    resolvedTargetOwner &&
    normalizeAgentId(resolvedTargetOwner) !== persistedTargetOwner.agentId
  ) {
    return fail(
      "forbidden",
      `Session belongs to agent "${persistedTargetOwner.agentId}", not "${normalizeAgentId(resolvedTargetOwner)}".`,
      unresolvedDisplayKey,
    );
  }
  const targetAgentId =
    (persistedTargetOwner.kind === "configured" ? persistedTargetOwner.agentId : undefined) ??
    resolvedTargetOwner ??
    resolvedKeyAgentId ??
    (isLiteralUnscopedMainTarget ? requesterAgentId : undefined) ??
    compatibilityTargetAgentId;
  if (!targetAgentId) {
    return fail(
      "forbidden",
      "Session ownership could not be verified. Upgrade the gateway or use an agent-prefixed session key.",
      unresolvedDisplayKey,
    );
  }
  const mayUseRequesterForLiteralSentinel =
    isLiteralUnscopedMainTarget && normalizeAgentId(targetAgentId) === requesterAgentId;

  return {
    ok: true as const,
    visibleSession,
    resolvedKey,
    displayKey,
    unresolvedDisplayKey,
    targetAgentId,
    mayUseRequesterForLiteralSentinel,
  };
}
