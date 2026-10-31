import { resolveConfiguredAgentId } from "../../agents/agent-scope-config.js";
import { getRuntimeConfigSnapshotMetadata } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import type { SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createCronExecutionId } from "../../cron/run-id.js";
import { resolveCreatorSandbox } from "../../gateway/operator-role-policy.js";
import {
  readExecRequestOwners,
  withExecRequestOwners,
  type ExecRequestOwner,
} from "../../infra/exec-request-context.js";
import {
  resolveSystemEventQueueKey,
  withSystemEventOwner,
} from "../../infra/system-event-ownership.js";
import {
  claimSystemEventTurn,
  enqueueRequiredSystemEventEntry,
} from "../../infra/system-events.js";
import { channelRouteTargetsMatchExact } from "../../plugin-sdk/channel-route.js";
import { normalizeAccountId } from "../../routing/account-id.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { CRON_EXECUTION_SOURCE_TOOL } from "../../sessions/input-provenance.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { bindCommandOwnerAuthority } from "../command-owner-authority.js";
import type { MsgContext } from "../templating.js";
import type { SessionEventOptions, SessionEventTarget } from "./session-event-contract.js";
import {
  getSessionEventRuntimeConfig,
  readSessionEventTargetCommandOwner,
  readSessionEventTargetEnvironment,
  readSessionEventTargetOperatorAuthority,
  readSessionEventTargetOwnerContinuation,
  readSessionEventTargetRequesterOwner,
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
  if (
    options.expectedTarget &&
    ((options.expectedTarget.agentId && options.expectedTarget.agentId !== agentId) ||
      (options.expectedTarget.sessionKey && options.expectedTarget.sessionKey !== sessionKey))
  ) {
    throw new Error(
      "Session event destination was reset or replaced while its producer was running",
    );
  }
  return { cfg, configPublication, agentId, sessionKey, env, storePath, operatorAuthority };
}

/** Validate and claim producer input; execution consumes this occurrence custody. */
export function claimSessionEventOccurrenceInput(params: {
  text: string;
  options: SessionEventOptions;
  sessionKey: string;
  agentId: string;
  route?: DeliveryContext;
  execRequestOwners?: readonly ExecRequestOwner[];
  cancel: () => void;
}) {
  const { text, options, sessionKey, agentId, route, execRequestOwners, cancel } = params;
  if (options.preserveOccurrenceOnRejection && !options.occurrences?.length) {
    throw new Error("Preserving a rejected event requires its original queued occurrence");
  }
  if (
    options.occurrences &&
    options.occurrences.map((event) => event.text).join("\n") !== text.trim()
  ) {
    throw new Error("Session event occurrence text changed before admission");
  }
  const freshOccurrence = options.occurrences
    ? undefined
    : enqueueRequiredSystemEventEntry(
        text,
        withExecRequestOwners(
          withSystemEventOwner(
            {
              sessionKey,
              contextKey: options.contextKey,
              deliveryContext: route,
            },
            agentId,
          ),
          execRequestOwners,
        ),
        // Refuse matching keyed plugin and tool-handoff retries; unkeyed and host occurrences stay distinct.
        {
          allowDuplicate:
            (options.source !== "plugin" && options.source !== "tool_handoff") ||
            !options.contextKey?.trim(),
        },
      );
  const occurrences = options.occurrences
    ? [...options.occurrences]
    : freshOccurrence
      ? [freshOccurrence]
      : [];
  const occurrence = occurrences[0];
  if (!occurrence?.id || occurrences.some((event) => !event.id)) {
    throw new Error("Session event was not enqueued: an identical occurrence is already pending");
  }
  const occurrenceId = occurrence.id;
  const eventText = occurrences.map((event) => event.text).join("\n");
  const ownership = claimSystemEventTurn(
    resolveSystemEventQueueKey(sessionKey, agentId),
    occurrences,
    cancel,
    agentId,
  );
  if (!ownership) {
    throw new Error("Session event occurrence no longer available for admission");
  }
  return { occurrence, occurrences, occurrenceId, eventText, ownership };
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
    "source" | "sourceTurnId" | "sourceRunId" | "scheduledAutomation"
  >;
  readmissionAttempt?: number;
  occurrenceId: string;
  deliveryContext?: DeliveryContext;
  target: SessionEventTarget;
  assertCurrent: SessionSourceAssertion;
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
    MessageSid: params.readmissionAttempt
      ? `${occurrenceId}:readmission-${params.readmissionAttempt}`
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
    : options.source === "plugin" ||
        options.source === "tool_handoff" ||
        options.source === "restart" ||
        // A scheduler turn about a job (not its run) acts for the job's restored operator source.
        (!automation && (options.source === "cron" || options.source === "cron_failure_repair"))
      ? readSessionEventTargetOperatorAuthority(target)
      : undefined;
  const requesterOwnerCheck = readSessionEventTargetRequesterOwner(target)?.assertCurrent;
  if (
    operatorAuthority &&
    (automation?.controlUiAdmin ||
      (options.source === "restart"
        ? operatorAuthority.scopes.includes("operator.admin")
        : readSessionEventTargetOwnerContinuation(target)))
  ) {
    // A tool handoff resumes the yielded turn: it continues that turn's own owner decision
    // under the same live operator source, retaining internal provenance and the event
    // text's existing command authorization. Non-owner and system turns never gain it.
    bindCommandOwnerAuthority(ctx, {
      operatorAuthority,
      sourceAssertion: params.assertCurrent,
      isCurrent: () => {
        params.assertCurrent();
        return true;
      },
      // Work that outlives this occurrence keeps only the live operator source.
      successor: {
        operatorAuthority,
        sourceAssertion: operatorAuthority.assertCurrent,
        isCurrent: () => {
          operatorAuthority.assertCurrent();
          return true;
        },
      },
    });
  } else if (requesterOwnerCheck) {
    // Work the scheduler started for a job keeps its requester's owner tools only while
    // the requester is still an owner, rechecked before each owner-only effect.
    bindCommandOwnerAuthority(ctx, {
      sourceAssertion: params.assertCurrent,
      isCurrent: () => {
        params.assertCurrent();
        requesterOwnerCheck();
        return true;
      },
      successor: {
        isCurrent: () => {
          requesterOwnerCheck();
          return true;
        },
      },
    });
  } else {
    const commandOwner = readSessionEventTargetCommandOwner(target);
    if (commandOwner) {
      const { authority, requester } = commandOwner;
      // A continuation of the requester's own work keeps their owner tools only while
      // they are still an owner under the current config.
      bindCommandOwnerAuthority(ctx, {
        recoveryReference: authority.recoveryReference,
        sourceAssertion: params.assertCurrent,
        isCurrent: () => {
          params.assertCurrent();
          return authority.isCurrent(getSessionEventRuntimeConfig());
        },
        // Work that outlives this occurrence keeps only the requester's live owner check.
        successor: {
          recoveryReference: authority.recoveryReference,
          isCurrent: () => authority.isCurrent(getSessionEventRuntimeConfig()),
        },
      });
      // Owner-checked effects (for example Gateway maintenance) recheck this sender at
      // use. Project it only on the requester's own channel account, never across
      // channels where the same raw ID can name someone else.
      if (
        deliveryContext?.channel === requester.channel &&
        normalizeAccountId(deliveryContext.accountId) === normalizeAccountId(requester.accountId)
      ) {
        ctx.SenderId = requester.senderId;
        ctx.SenderE164 = requester.senderE164;
      }
    }
  }
  setChannelSourceTurnId(ctx, options.sourceTurnId);
  return ctx;
}
