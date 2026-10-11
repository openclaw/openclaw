import {
  ErrorCodes,
  errorShape,
  validateWakeParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionRoutingContract } from "../../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { isSubagentSessionKey, normalizeAgentId } from "../../routing/session-key.js";
import {
  AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
  isAgentHarnessSessionKey,
  resolveAgentHarnessSessionStoreEntryError,
} from "../../sessions/agent-harness-session-key.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import {
  authorizeCurrentOperatorRoleScopes,
  authorizeGatewaySessionCreation,
} from "../operator-role-policy.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "../session-utils-store-worker.js";
import { assertActiveAgentRuntimeAuthority } from "./agent-runtime-authority.js";
import { readCronCallerScope } from "./cron-caller-scope.js";
import { respondRefusedCronAgent } from "./cron-job-access.js";
import type { GatewayRequestHandler } from "./types.js";
import { assertValidParams } from "./validation.js";

export const cronWakeHandler: GatewayRequestHandler = async ({
  params,
  respond,
  context,
  client,
  sessionMutationCommitGuard,
  hasCurrentClientAuthority,
}) => {
  if (!assertValidParams(params, validateWakeParams, "wake", respond)) {
    return;
  }
  // Caller-supplied sessionKey / agentId thread through to `cron.wake` so
  // multi-session deployments wake the originating conversation lane
  // instead of the system-agent default. Empty strings are dropped
  // (schema permits omission; presence with empty payload should not
  // override the default).
  const p = params;
  const sessionKey = p.sessionKey?.trim() || undefined;
  const agentId = p.agentId?.trim() || undefined;
  const callerScope = readCronCallerScope(client);
  const cfg = context.getRuntimeConfig();
  const requestedOwner = sessionKey
    ? resolveRequestedSessionAgentId(cfg, sessionKey, agentId ?? callerScope?.agentId)
    : undefined;
  if (requestedOwner && !requestedOwner.ok) {
    respond(false, undefined, requestedOwner.error);
    return;
  }
  const resolvedAgentId = requestedOwner?.agentId ?? callerScope?.agentId ?? agentId;
  if (sessionKey && isAgentHarnessSessionKey(sessionKey)) {
    const loaded = await loadGatewaySessionEntryReadOnlyInWorker({
      cfg,
      key: sessionKey,
      ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}),
      assertActive: sessionMutationCommitGuard,
    });
    const harnessSessionError = loaded.entry
      ? resolveAgentHarnessSessionStoreEntryError(loaded.canonicalKey, loaded.entry)
      : AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE;
    if (harnessSessionError) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, harnessSessionError));
      return;
    }
  }
  if (sessionKey && isSubagentSessionKey(sessionKey)) {
    // Wake requests resume user-visible sessions only; subagent sessions are
    // internal task execution targets and should not receive operator wakes.
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "wake sessionKey cannot target a subagent session"),
    );
    return;
  }
  // The resolver normalizes agent ids. Reject conflicting raw spellings too,
  // so an explicitly named target is never silently rewritten.
  const sessionKeyAgentId = sessionKey
    ? parseAgentSessionKey(sessionKey)?.agentId?.trim().toLowerCase()
    : undefined;
  if (callerScope && agentId && normalizeAgentId(agentId) !== callerScope.agentId) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "wake agentId outside caller scope"),
    );
    return;
  }
  if (agentId && sessionKeyAgentId && agentId.toLowerCase() !== sessionKeyAgentId) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "wake agentId contradicts the agent that owns sessionKey; pass a single canonical wake target",
      ),
    );
    return;
  }
  if (respondRefusedCronAgent(resolvedAgentId, respond)) {
    return;
  }
  const routingContract = resolveSessionRoutingContract(cfg);
  const storeOwner = resolvedAgentId ?? context.cron.getDefaultAgentId();
  const storePath = storeOwner
    ? resolveSessionStorePathCore(cfg.session?.store, { agentId: storeOwner })
    : undefined;
  const authorizeWake = () => {
    const currentConfig = context.getRuntimeConfig();
    const scopeError = authorizeCurrentOperatorRoleScopes(client, currentConfig);
    if (scopeError) {
      return scopeError;
    }
    if (!currentConfig.gateway?.roles) {
      return undefined;
    }
    const knownWakeAgentId = resolvedAgentId ?? context.cron.getDefaultAgentId();
    const wakeAgent = knownWakeAgentId
      ? { ok: true as const, agentId: knownWakeAgentId }
      : resolveRequestedSessionAgentId(currentConfig, sessionKey ?? "main");
    return wakeAgent.ok
      ? authorizeGatewaySessionCreation({ cfg: currentConfig, client, agentId: wakeAgent.agentId })
      : wakeAgent.error;
  };
  const wakeAccessError = authorizeWake();
  if (wakeAccessError) {
    respond(false, undefined, wakeAccessError);
    return;
  }
  // Gateway becomes request-ready before scheduled services start; load the
  // wake owner first so an early operator event cannot disappear on cold start.
  const commitGuard = () => {
    sessionMutationCommitGuard?.();
    if (hasCurrentClientAuthority?.() === false) {
      throw new Error("Gateway caller authority is no longer active");
    }
    assertActiveAgentRuntimeAuthority(client, context);
    const currentConfig = context.getRuntimeConfig();
    const currentOwner = resolvedAgentId
      ? resolveRequestedSessionAgentId(currentConfig, sessionKey, resolvedAgentId)
      : undefined;
    if (
      resolveSessionRoutingContract(currentConfig) !== routingContract ||
      currentOwner?.ok === false ||
      (storeOwner &&
        resolveSessionStorePathCore(currentConfig.session?.store, { agentId: storeOwner }) !==
          storePath)
    ) {
      throw new Error("Wake configuration changed during preparation; retry the request");
    }
    const accessError = authorizeWake();
    if (accessError) {
      throw new Error(accessError.message);
    }
  };
  await context.cron.prepareWake?.();
  commitGuard();
  const result = await context.cron.wake({
    mode: p.mode,
    text: p.text,
    createIfMissing: true,
    ...(sessionKey ? { sessionKey } : {}),
    ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}),
    commitGuard,
  });
  respond(true, result, undefined);
};
