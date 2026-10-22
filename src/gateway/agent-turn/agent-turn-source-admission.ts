import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { resolveAgentIdFromSessionKey } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isSubagentCoordinationInputProvenance } from "../../sessions/input-provenance.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  retargetSessionControllerSource,
  type SessionControllerInput,
} from "../../sessions/session-controller.mailbox.js";
import { AGENT_SESSION_RESET_COMMAND_RE } from "../agent-command-policy.js";
import { registerChatAbortController } from "../chat-abort.js";
import { authorizeGatewaySessionCreation } from "../operator-role-policy.js";
import { authorizeResolvedSessionMutationAsync } from "../session-sharing.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "../session-utils-store-worker.js";
import type { AgentRequestPreflight } from "./agent-request-preflight.js";
import type { AgentTurnIo, AgentTurnPrincipal } from "./types.js";

/** Authorize a principal to create or mutate the canonical session an agent turn targets. */
export async function authorizeAgentTurnSession({
  cfg,
  principal,
  agentId,
  sessionKey,
}: {
  cfg: OpenClawConfig;
  principal: AgentTurnPrincipal | null;
  agentId: string;
  sessionKey: string;
}) {
  return (
    authorizeGatewaySessionCreation({ cfg, client: principal, agentId }) ??
    (await authorizeResolvedSessionMutationAsync({ cfg, client: principal, sessionKey, agentId }))
  );
}

type AgentTurnRunAbortSource = {
  preflight: AgentRequestPreflight;
  io: AgentTurnIo;
  sourceWork: Promise<void>;
  lifecycleGeneration: string;
  ownerConnId?: string;
  ownerDeviceId?: string;
  assertAdmissionCurrent?: () => void;
  isSourcePreparationComplete: () => boolean;
  onCancelled: (target: { agentId?: string; sessionKey: string; stopReason: string }) => void;
  controllerInput?: SessionControllerInput;
};

/** Register the turn's abortable source on its physical session target and announce its owner. */
export function registerAgentTurnRunAbort(
  source: AgentTurnRunAbortSource & {
    onRegistered: (registration: ReturnType<typeof registerChatAbortController>) => void;
  },
  target: Parameters<typeof captureSessionTarget>[0] & {
    agentId: string;
    cfg: OpenClawConfig;
    sessionId?: string;
  },
) {
  const { request, runId, suppressVisibleSessionEffects, inputProvenance } = source.preflight;
  const sourceTarget = captureSessionTarget({
    storeScope: target.storeScope,
    physicalStorePath: target.physicalStorePath,
    sessionKey: target.sessionKey,
    aliases: target.aliases,
    agentId: target.agentId,
    incarnation: target.incarnation,
  });
  if (source.controllerInput && !source.controllerInput.target) {
    retargetSessionControllerSource(source.controllerInput, sourceTarget);
  }
  const registration = registerChatAbortController({
    sourceWork: source.sourceWork,
    runId,
    sessionKey: target.sessionKey,
    sessionId: target.sessionId ?? "",
    target: sourceTarget,
    authority: {
      assertCurrent: () => {
        if (!source.isSourcePreparationComplete()) {
          source.assertAdmissionCurrent?.();
        }
      },
    },
    agentId: target.agentId,
    timeoutMs: resolveAgentTimeoutMs({ cfg: target.cfg, overrideSeconds: request.timeout }),
    ownerConnId: source.ownerConnId,
    ownerDeviceId: source.ownerDeviceId,
    kind: "agent",
    lifecycleGeneration: source.lifecycleGeneration,
    controlUiVisible:
      !suppressVisibleSessionEffects && !isSubagentCoordinationInputProvenance(inputProvenance),
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    onCancel: (stopReason) =>
      source.onCancelled({ agentId: target.agentId, sessionKey: target.sessionKey, stopReason }),
    sourceInput: source.controllerInput,
  });
  source.onRegistered(registration);
  if (registration.entry) {
    source.io.emitStartOwner?.(runId, registration.entry);
  }
}

/** Bind preparation custody to the authorized physical target before attachment work yields. */
export async function registerAgentTurnSourceAdmission({
  sessionKey,
  agentId: targetAgentId,
  principal,
  assertRequestCurrent,
  ...source
}: AgentTurnRunAbortSource & {
  sessionKey?: string;
  agentId?: string;
  principal: AgentTurnPrincipal | null;
  assertRequestCurrent: () => void;
  onRegistered: (registration: ReturnType<typeof registerChatAbortController>) => void;
}) {
  // Reset mutation selects the successor incarnation before its turn is reserved.
  if (!sessionKey || AGENT_SESSION_RESET_COMMAND_RE.test(source.preflight.request.message ?? "")) {
    return undefined;
  }
  const loaded = await loadGatewaySessionEntryReadOnlyInWorker({
    cfg: source.preflight.cfg,
    key: sessionKey,
    agentId: targetAgentId,
    excludeInternalEffects: true,
    assertActive: assertRequestCurrent,
  });
  const sourceAgentId = resolveAgentIdFromSessionKey(loaded.canonicalKey, targetAgentId);
  const authorizationError = await authorizeAgentTurnSession({
    cfg: loaded.cfg,
    principal,
    sessionKey: loaded.canonicalKey,
    agentId: sourceAgentId,
  });
  if (authorizationError) {
    source.io.emitAcceptance([false, undefined, authorizationError]);
    return false;
  }
  assertRequestCurrent();
  registerAgentTurnRunAbort(source, {
    cfg: source.preflight.cfg,
    storeScope: loaded.storePath,
    physicalStorePath: loaded.readSource?.path,
    sessionKey: loaded.canonicalKey,
    aliases: [sessionKey],
    agentId: sourceAgentId,
    sessionId: loaded.entry?.sessionId,
    incarnation: loaded.entry?.sessionId,
  });
  return undefined;
}
