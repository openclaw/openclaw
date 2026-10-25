import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import { resolveConfiguredAgentId } from "../../agents/agent-scope-config.js";
import { getRuntimeConfigSnapshotMetadata } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createCronExecutionId } from "../../cron/run-id.js";
import { resolveCreatorSandbox } from "../../gateway/operator-role-policy.js";
import { readExecRequestOwners } from "../../infra/exec-request-context.js";
import { channelRouteTargetsMatchExact } from "../../plugin-sdk/channel-route.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { CRON_EXECUTION_SOURCE_TOOL } from "../../sessions/input-provenance.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { bindCommandOwnerAuthority } from "../command-owner-authority.js";
import type { MsgContext } from "../templating.js";
import type { SessionEventOptions, SessionEventTarget } from "./session-event-contract.js";
import {
  getSessionEventRuntimeConfig,
  readSessionEventTargetEnvironment,
  readSessionEventTargetOperatorAuthority,
  resolveSessionEventKey,
} from "./session-event-target.js";
import { setChannelSourceTurnId } from "./source-turn-id.js";

/** Prepare immutable producer context before the receipt acquires occurrence custody. */
export function prepareSessionEventInput(text: string, options: SessionEventOptions) {
  const operatorAuthority = options.expectedTarget
    ? readSessionEventTargetOperatorAuthority(options.expectedTarget)
    : undefined;
  operatorAuthority?.assertCurrent();
  const cfg = getSessionEventRuntimeConfig();
  const configPublication = getRuntimeConfigSnapshotMetadata();
  const agentId = normalizeAgentId(options.agentId);
  resolveConfiguredAgentId(cfg, agentId);
  const sessionKey = resolveSessionEventKey(agentId, options.sessionKey);
  if (!text.trim()) {
    throw new Error("Session event text must not be empty");
  }
  const env = options.expectedTarget
    ? readSessionEventTargetEnvironment(options.expectedTarget)
    : undefined;
  // Keep the captured destination across config remapping; live policy still gates effects.
  const storePath =
    options.expectedTarget?.storePath ??
    resolveSessionStorePathCore(cfg.session?.store, { agentId, env });
  return { cfg, configPublication, agentId, sessionKey, env, storePath, operatorAuthority };
}

export function resolveSessionEventExecRequestOwners(
  options: Pick<SessionEventOptions, "occurrences">,
) {
  return options.occurrences
    ? [
        ...new Set(
          options.occurrences.flatMap(
            (occurrence) =>
              readExecRequestOwners(occurrence) ?? readExecRequestOwners(options) ?? [],
          ),
        ),
      ]
    : readExecRequestOwners(options);
}

export function buildSessionEventContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  text: string;
  options: Pick<
    SessionEventOptions,
    "source" | "sourceTurnId" | "sourceRunId" | "readmissionAttempt" | "scheduledAutomation"
  >;
  occurrenceId: string;
  deliveryContext?: DeliveryContext;
  target: SessionEventTarget;
  assertCurrent: () => void;
}): MsgContext {
  const { agentId, sessionKey, text, options, occurrenceId, deliveryContext, target } = params;
  const automation = options.scheduledAutomation;
  const ctx: MsgContext = {
    AgentId: agentId,
    SessionKey: sessionKey,
    Body: text,
    BodyForAgent: text,
    InternalTurnSource: "event",
    BodyForCommands: "",
    CommandBody: "",
    RawBody: "",
    CommandAuthorized: false,
    InputProvenance: {
      kind: "internal_system",
      sourceTool: automation ? CRON_EXECUTION_SOURCE_TOOL : options.source,
      ...(automation && automation.job.state.runningAtMs !== undefined
        ? {
            jobId: automation.job.id,
            runId: createCronExecutionId(automation.job.id, automation.job.state.runningAtMs),
            sourceSessionKey: sessionKey,
          }
        : options.sourceRunId
          ? { runId: options.sourceRunId }
          : {}),
    },
    ChatType: channelRouteTargetsMatchExact({
      left: deliveryContext,
      right: target.deliveryContext,
    })
      ? target.chatType
      : undefined,
    Surface: deliveryContext?.channel ?? INTERNAL_MESSAGE_CHANNEL,
    Provider: deliveryContext?.channel ?? INTERNAL_MESSAGE_CHANNEL,
    OriginatingChannel: deliveryContext?.channel,
    OriginatingTo: deliveryContext?.to,
    AccountId: deliveryContext?.accountId,
    MessageThreadId: deliveryContext?.threadId,
    // Inbound dedupe retains an adopted attempt's id; a policy re-admission is a new dispatch.
    MessageSid: options.readmissionAttempt
      ? `${occurrenceId}:readmission-${options.readmissionAttempt}`
      : occurrenceId,
  };
  if (automation && !target.sessionId) {
    // The ordinary session writer owns creation; preserve the job's captured facts.
    ctx.SessionCreation = {
      via: "cron",
      actor: automation.job.createdActor ?? { type: "system" },
      sandbox: resolveCreatorSandbox(params.cfg, { actor: automation.job.createdActor }),
      skillLibrarySelections: automation.job.skillLibrarySelections,
    };
  }
  const operatorAuthority = automation?.controlUiAdmin
    ? automation.operatorAuthority
    : options.source === "plugin"
      ? readSessionEventTargetOperatorAuthority(target)
      : undefined;
  if (
    operatorAuthority &&
    (automation?.controlUiAdmin || operatorAuthority.profileId === GATEWAY_OWNER_PROFILE_ID)
  ) {
    // Plugin handoffs continue their captured owner capability while retaining
    // internal provenance and the event text's existing command authorization.
    bindCommandOwnerAuthority(ctx, {
      operatorAuthority,
      isCurrent: () => {
        params.assertCurrent();
        return true;
      },
    });
  }
  setChannelSourceTurnId(ctx, options.sourceTurnId);
  return ctx;
}
