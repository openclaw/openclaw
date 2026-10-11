import {
  ErrorCodes,
  errorShape,
  validateWakeParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { isSubagentSessionKey, normalizeAgentId } from "../../routing/session-key.js";
import {
  AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
  isAgentHarnessSessionKey,
  resolveAgentHarnessSessionStoreEntryError,
} from "../../sessions/agent-harness-session-key.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { authorizeGatewaySessionCreation } from "../operator-role-policy.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
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
}) => {
  if (!assertValidParams(params, validateWakeParams, "wake", respond)) {
    return;
  }
  // Caller-supplied sessionKey / agentId thread through to `cron.wake` so
  // multi-session deployments wake the originating conversation lane
  // instead of the heartbeat / main default. Empty strings are dropped
  // (schema permits omission; presence with empty payload should not
  // override the default).
  const p = params;
  const sessionKey = p.sessionKey?.trim() || undefined;
  const agentId = p.agentId?.trim() || undefined;
  const callerScope = readCronCallerScope(client);
  const requestedOwner = sessionKey
    ? resolveRequestedSessionAgentId(
        context.getRuntimeConfig(),
        sessionKey,
        agentId ?? callerScope?.agentId,
      )
    : undefined;
  if (requestedOwner && !requestedOwner.ok) {
    respond(false, undefined, requestedOwner.error);
    return;
  }
  const resolvedAgentId = requestedOwner?.agentId ?? callerScope?.agentId ?? agentId;
  if (sessionKey && isAgentHarnessSessionKey(sessionKey)) {
    const loaded = loadGatewaySessionEntryReadOnly(
      sessionKey,
      resolvedAgentId ? { agentId: resolvedAgentId } : {},
    );
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
  const wakeConfig = context.getRuntimeConfig();
  if (respondRefusedCronAgent(resolvedAgentId, respond)) {
    return;
  }
  // Resolving a default wake agent can fail; role-free requests must retain their existing path.
  if (wakeConfig.gateway?.roles) {
    const knownWakeAgentId = resolvedAgentId ?? context.cron.getDefaultAgentId();
    const wakeAgent = knownWakeAgentId
      ? { ok: true as const, agentId: knownWakeAgentId }
      : resolveRequestedSessionAgentId(wakeConfig, sessionKey ?? "main");
    if (!wakeAgent.ok) {
      respond(false, undefined, wakeAgent.error);
      return;
    }
    const wakeAccessError = authorizeGatewaySessionCreation({
      cfg: wakeConfig,
      client,
      agentId: wakeAgent.agentId,
    });
    if (wakeAccessError) {
      respond(false, undefined, wakeAccessError);
      return;
    }
  }
  // Gateway becomes request-ready before scheduled services start; load the
  // wake owner first so an early operator event cannot disappear on cold start.
  await context.cron.prepareWake?.();
  const result = await context.cron.wake({
    mode: p.mode,
    text: p.text,
    commitGuard: () => {
      sessionMutationCommitGuard?.();
      assertActiveAgentRuntimeAuthority(client, context);
    },
    ...(sessionKey ? { sessionKey } : {}),
    ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}),
  });
  respond(true, result, undefined);
};
