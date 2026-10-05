import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { getCliSessionBinding } from "../../agents/cli-session.js";
import { AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION } from "../../agents/internal-event-contract.js";
import type { AgentInternalEvent } from "../../agents/internal-events.js";
import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import { isCliProvider } from "../../agents/model-selection.js";
import {
  resolveSessionWorkStartError,
  type InternalSessionEntry,
  type SessionEntry,
} from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import {
  AGENT_HARNESS_MODEL_RUN_FORBIDDEN_MESSAGE,
  resolveAgentHarnessSessionContextError,
  resolveAgentHarnessSessionIdMismatchError,
} from "../../sessions/agent-harness-session-key.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import { setSafeTimeout } from "../../utils/timer-delay.js";
import type { GatewayRequestHandlerOptions } from "../server-methods/types.js";
import { loadSessionEntry, resolveDeletedAgentIdFromSessionKey } from "../session-utils.js";

export const CRON_CONTINUATION_RELEASE_RECOVERY_DELAYS_MS = [250, 1_000, 4_000, 15_000] as const;

export function canPrepareAgentSessionWorktree(
  sessionKey: string | undefined,
  entry: InternalSessionEntry | undefined,
): boolean {
  return (
    Boolean(sessionKey && isSubagentSessionKey(sessionKey) && entry?.pendingWorktree) &&
    entry?.pendingProjectGitUrl === undefined
  );
}

export function resolveAgentSessionWorkStartError(
  sessionKey: string,
  entry: SessionEntry | undefined,
): string | undefined {
  return resolveSessionWorkStartError(
    sessionKey,
    entry,
    canPrepareAgentSessionWorktree(sessionKey, entry) ? { allowPendingWorkspace: true } : undefined,
  );
}

export type RestoredCronContinuation = Pick<
  NonNullable<SessionEntry["cronRunContinuation"]>,
  | "lifecycleRevision"
  | "toolsAllow"
  | "toolsAllowIsDefault"
  | "scheduledToolPolicy"
  | "scheduledToolCallerOrigin"
  | "toolsAllowExecTarget"
  | "cliSessionBindingFacts"
> & {
  sessionId: string;
  provider: string;
  model: string;
  thinking?: string;
};

export function respondDeletedAgentSession(params: {
  cfg: OpenClawConfig;
  canonicalKey: string;
  entry?: SessionEntry | null;
  acpMetadataSessionKey?: string;
  respond: GatewayRequestHandlerOptions["respond"];
}): boolean {
  const deletedAgentId = resolveDeletedAgentIdFromSessionKey(
    params.cfg,
    params.canonicalKey,
    params.entry,
    { acpMetadataSessionKey: params.acpMetadataSessionKey ?? params.canonicalKey },
  );
  if (deletedAgentId === null) {
    return false;
  }
  params.respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `Agent "${deletedAgentId}" no longer exists in configuration`,
    ),
  );
  return true;
}

export function respondUnavailableAgentSessionForKey(params: {
  sessionKey: string;
  requestedSessionId?: string;
  isRawModelRun: boolean;
  agentId?: string;
  respond: GatewayRequestHandlerOptions["respond"];
}): boolean {
  const { cfg, entry, canonicalKey, legacyKey } = loadSessionEntry(params.sessionKey, {
    ...(params.agentId ? { agentId: params.agentId } : {}),
    clone: false,
    projection: "list",
  });
  if (
    respondDeletedAgentSession({
      cfg,
      canonicalKey,
      entry,
      acpMetadataSessionKey: legacyKey,
      respond: params.respond,
    })
  ) {
    return true;
  }
  const sessionError =
    resolveAgentHarnessSessionContextError(canonicalKey, entry) ||
    resolveAgentHarnessSessionIdMismatchError(entry, params.requestedSessionId) ||
    (params.isRawModelRun && entry?.modelSelectionLocked === true
      ? AGENT_HARNESS_MODEL_RUN_FORBIDDEN_MESSAGE
      : undefined) ||
    resolveAgentSessionWorkStartError(canonicalKey, entry);
  if (!sessionError) {
    return false;
  }
  params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, sessionError));
  return true;
}

export function cronContinuationHasReusableRuntime(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry;
  agentId: string;
  provider: string;
  model: string;
}): boolean {
  const executionProvider =
    resolveCliRuntimeExecutionProvider({
      provider: params.provider,
      cfg: params.cfg,
      agentId: params.agentId,
      modelId: params.model,
    }) ?? params.provider;
  return (
    !isCliProvider(executionProvider, params.cfg) ||
    Boolean(getCliSessionBinding(params.entry, executionProvider)?.sessionId)
  );
}

export function withoutCronRunContinuation(entry: SessionEntry): SessionEntry {
  const { cronRunContinuation: _cronRunContinuation, ...baseEntry } = entry;
  return baseEntry;
}

export function shouldSuppressAgentPromptPersistence(params: {
  inputProvenance?: InputProvenance;
  internalEvents?: AgentInternalEvent[];
}): boolean {
  return (
    params.inputProvenance?.kind === "inter_session" &&
    params.inputProvenance.sourceTool === "subagent_announce" &&
    params.internalEvents?.some(
      (event) =>
        event.type === AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION && event.source === "subagent",
    ) === true
  );
}

export function yieldAfterAgentAcceptedAck(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 10);
  });
}

export function waitForCronContinuationReleaseRecovery(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setSafeTimeout(resolve, delayMs);
    timer.unref?.();
  });
}
