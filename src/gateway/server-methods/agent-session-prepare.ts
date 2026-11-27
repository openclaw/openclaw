import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import {
  resolveAgentMainSessionKey,
  resolveChannelResetConfig,
  resolveSessionResetPolicy,
  resolveSessionResetType,
} from "../../config/sessions.js";
import { resolveMaintenanceConfigFromInput } from "../../config/sessions/store-maintenance.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { CRON_RUN_ENDED_ERROR, isEndedCronRun } from "../../infra/agent-run-registry.automation.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.read.js";
import {
  respondDeletedAgentSession,
  resolveAgentSessionWorkStartBlock,
} from "../agent-turn/agent-handler-helpers.js";
import {
  takeInProcessFreshChildSession,
  type FreshChildSession,
} from "../in-process-session-run.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "../session-utils-store-worker.js";
import type { AgentRunRequest } from "./agent-request-types.js";
import { respondError } from "./response.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type PrepareAgentSessionParams = {
  cfg: OpenClawConfig;
  requestedSessionKey: string;
  requestedSessionId?: string;
  expectedExistingSessionId?: string;
  agentId?: string;
  recipientChannel?: string;
  request: AgentRunRequest;
  effectiveBootstrapContextRunKind?: "default" | "cron";
  preAttachmentSession?: { canonicalKey: string; sessionId?: string };
  respond: GatewayRequestHandlerOptions["respond"];
  assertCurrent?: () => void;
};

export async function prepareAgentSession(params: PrepareAgentSessionParams) {
  params.assertCurrent?.();
  const requestedSessionAgent = resolveRequestedSessionAgentId(
    params.cfg,
    params.requestedSessionKey,
    params.agentId,
  );
  if (!requestedSessionAgent.ok) {
    params.respond(false, undefined, requestedSessionAgent.error);
    return undefined;
  }
  const requestedAgentId = requestedSessionAgent.agentId;
  const freshChild = takeInProcessFreshChildSession(params.request);
  if (freshChild) {
    return prepareAdmittedAgentSession(
      params,
      {
        cfg: params.cfg,
        storePath: freshChild.storePath,
        entry: freshChild.entry,
        canonicalKey: params.requestedSessionKey,
        storeKeys: [params.requestedSessionKey],
        legacyKey: undefined,
      },
      freshChild.agentId,
      freshChild,
    );
  }
  const selected = await loadGatewaySessionEntryReadOnlyInWorker({
    cfg: params.cfg,
    key: params.requestedSessionKey,
    agentId: requestedAgentId,
    excludeInternalEffects: true,
    assertActive: params.assertCurrent,
  });
  return prepareAdmittedAgentSession(params, selected, requestedAgentId);
}

async function prepareAdmittedAgentSession(
  params: PrepareAgentSessionParams,
  selected: Pick<
    Awaited<ReturnType<typeof loadGatewaySessionEntryReadOnlyInWorker>>,
    "cfg" | "storePath" | "readSource" | "entry" | "canonicalKey" | "legacyKey" | "storeKeys"
  >,
  requestedAgentId: string,
  freshChild?: FreshChildSession,
) {
  const { cfg, storePath, entry, canonicalKey, legacyKey, storeKeys } = selected;
  const canonicalSessionAgentId = parseAgentSessionKey(canonicalKey)?.agentId ?? requestedAgentId;
  if (params.expectedExistingSessionId && entry?.sessionId !== params.expectedExistingSessionId) {
    respondError(
      params.respond,
      ErrorCodes.UNAVAILABLE,
      `Session "${canonicalKey}" changed before expected work could start.`,
    );
    return undefined;
  }

  const effectiveBootstrapContextRunKind = params.effectiveBootstrapContextRunKind;

  const sessionExistedBeforeAttachmentSetup =
    params.preAttachmentSession?.canonicalKey === canonicalKey
      ? params.preAttachmentSession
      : undefined;
  if (
    sessionExistedBeforeAttachmentSetup &&
    (!entry || entry.sessionId !== sessionExistedBeforeAttachmentSetup.sessionId)
  ) {
    respondError(
      params.respond,
      ErrorCodes.INVALID_REQUEST,
      `Session "${canonicalKey}" ${entry ? "changed" : "was deleted"} while starting work. Retry.`,
    );
    return undefined;
  }
  const deleted = respondDeletedAgentSession({
    cfg,
    canonicalKey,
    entry,
    acpMetadataSessionKey: legacyKey,
    respond: params.respond,
    assertCurrent: params.assertCurrent,
  });
  if (deleted instanceof Promise ? await deleted : deleted) {
    return undefined;
  }
  const workStartBlock = resolveAgentSessionWorkStartBlock(canonicalKey, entry);
  if (workStartBlock) {
    respondError(params.respond, ErrorCodes.INVALID_REQUEST, workStartBlock.message, {
      retryable: workStartBlock.retryable,
    });
    return undefined;
  }
  // The cron executor resumes its own yields in place; nothing else starts a turn on its run.
  if (isEndedCronRun(canonicalKey)) {
    respondError(params.respond, ErrorCodes.INVALID_REQUEST, CRON_RUN_ENDED_ERROR);
    return undefined;
  }

  const now = Date.now();
  const resetPolicy = resolveSessionResetPolicy({
    sessionCfg: cfg.session,
    resetType: resolveSessionResetType({ sessionKey: canonicalKey }),
    resetOverride: resolveChannelResetConfig({
      sessionCfg: cfg.session,
      channel: sessionDeliveryChannel(entry) ?? params.recipientChannel,
    }),
  });
  const isSystemGatewayRun = effectiveBootstrapContextRunKind === "cron";
  const visibleRequest = !isSystemGatewayRun && !params.request.internalEvents?.length;
  const mainSessionKey = resolveAgentMainSessionKey({ cfg, agentId: canonicalSessionAgentId });
  params.assertCurrent?.();
  return {
    cfg,
    storePath,
    physicalStorePath: selected.readSource?.path,
    entry,
    canonicalKey,
    storeKeys,
    maintenanceConfig: resolveMaintenanceConfigFromInput(cfg.session?.maintenance),
    canonicalSessionAgentId,
    resetPolicy,
    now,
    visibleRequest,
    mainSessionKey,
    isSystemGatewayRun,
    touchInteraction: visibleRequest,
    sessionPersistedBeforeGatewayAdmission: entry !== undefined,
    effectiveBootstrapContextRunKind,
    freshChild: freshChild !== undefined,
  };
}
