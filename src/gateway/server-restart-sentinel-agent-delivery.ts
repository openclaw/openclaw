import path from "node:path";
import { formatGeneratedMediaDeliveredForPrompt } from "../agents/internal-events.js";
import type { RuntimeContextFragment } from "../agents/internal-runtime-context.js";
import { reserveSubagentCompletionControllerSource } from "../agents/subagents/announce/subagent-announce-controller-source.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import {
  durableMessageBatchMayHaveReachedRecipient,
  sendDurableMessageBatchCore,
} from "../channels/message/runtime.js";
import type { CliDeps } from "../cli/deps.types.js";
import { createOutboundSendDeps } from "../cli/outbound-send-deps.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import type { SessionDeliveryGeneration } from "../config/sessions/session-delivery-generation.types.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { sessionMatchesExpectedTranscriptTurn } from "../config/sessions/session-transcript-turn-state.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolveStateDir } from "../config/state-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  inspectDeliveryQueueReceipt,
  type DeliveryQueueStateContext,
} from "../infra/delivery-queue-sqlite.js";
import type { DeliveryQueueCompletionRetention } from "../infra/delivery-queue-sqlite.types.js";
import { outboundDeliveryQueueName } from "../infra/outbound/delivery-queue-namespaces.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import {
  advanceSessionDeliveryAgentRun,
  deferSessionDelivery,
  markSessionDeliveryAttemptStarted,
  markSessionDeliverySettlement,
  mergeSessionDeliveryPreparedMediaBlocks,
} from "../infra/session-delivery-queue-storage.js";
import {
  SessionDeliveryDeadLetteredError,
  SessionDeliveryDeferredError,
  SessionDeliverySafeRetryError,
  type QueuedSessionDelivery,
  type SessionDeliveryRoute,
} from "../infra/session-delivery-queue.records.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getMediaDir } from "../media/store.js";
import { isSessionControllerWorkActive } from "../sessions/session-controller.lifecycle.js";
import {
  retireSessionControllerInput,
  type SessionControllerInput,
} from "../sessions/session-controller.mailbox.js";
import { readAssistantDisplayContent } from "../shared/assistant-display-content.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import {
  attachManagedOutgoingMediaToMessage,
  createManagedOutgoingMediaBlocks,
} from "./managed-image-attachments.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { dispatchGatewayLifecycleMethod as dispatchGatewayMethodInProcess } from "./server-recovery-runtime-context.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";

const log = createSubsystemLogger("gateway/restart-sentinel");
const AGENT_DELIVERY_OWNERSHIP_RETRY_MS = 1_000;
// Outbound receipts dedupe a host media send across crashes between the send
// and the session row's transition to its completion turn.
const GENERATED_MEDIA_DELIVERY_COMPLETION_RETENTION = {
  idPrefix: "generated-media-delivery:v1:",
  maxAgeMs: 24 * 60 * 60_000,
  maxEntries: 2_000,
} as const satisfies DeliveryQueueCompletionRetention;

type QueuedAgentTurnSessionDelivery = Extract<QueuedSessionDelivery, { kind: "agentTurn" }>;

async function deadLetterSessionDelivery(
  entry: QueuedAgentTurnSessionDelivery,
  reason: string,
  queueContext: OpenClawStateWorkerContext,
): Promise<never> {
  await markSessionDeliverySettlement(entry, "moved-to-failed", queueContext);
  log.warn("queued session delivery requires durable dead-letter settlement", {
    queueId: entry.id,
  });
  throw new SessionDeliveryDeadLetteredError(reason);
}

function resolveQueuedAgentRunId(entry: QueuedAgentTurnSessionDelivery) {
  const base = entry.idempotencyKey ?? entry.messageId;
  return entry.agentRunAttempt ? `${base}:attempt:${entry.agentRunAttempt}` : base;
}

/** Send generated media to an external route exactly once, settled by the outbound receipt. */
async function sendQueuedGeneratedMedia(params: {
  entry: QueuedAgentTurnSessionDelivery;
  route: SessionDeliveryRoute;
  mediaUrls: string[];
  agentId: string;
  canonicalKey: string;
  cfg: OpenClawConfig;
  deps: CliDeps;
  sessionGeneration: SessionDeliveryGeneration;
  queueContext: OpenClawStateWorkerContext;
}): Promise<void> {
  const { entry, route, cfg, sessionGeneration } = params;
  const deliveryIntentId = `${GENERATED_MEDIA_DELIVERY_COMPLETION_RETENTION.idPrefix}${entry.id}`;
  const deliveryQueueContext: DeliveryQueueStateContext = {
    stateDir: resolveStateDir(params.queueContext.environment),
    workerContext: params.queueContext,
  };
  const inspectReceipt = () =>
    inspectDeliveryQueueReceipt(
      outboundDeliveryQueueName({ sessionGeneration }),
      deliveryIntentId,
      false,
      deliveryQueueContext,
    );
  const deferToOutboundOwner = async (): Promise<never> => {
    await deferSessionDelivery(entry.id, AGENT_DELIVERY_OWNERSHIP_RETRY_MS, params.queueContext);
    throw new SessionDeliveryDeferredError(
      "queued generated-media send is still owned by outbound delivery recovery",
    );
  };
  const deadLetterAmbiguous = async (facts: Record<string, unknown>): Promise<never> => {
    log.warn("queued generated-media send has ambiguous attachment side effects", {
      queueId: entry.id,
      ...facts,
    });
    return await deadLetterSessionDelivery(
      entry,
      "queued generated-media delivery dead-lettered after ambiguous side effects",
      params.queueContext,
    );
  };
  if (entry.deliveryStartedAt !== undefined) {
    // A started send settles only from its outbound receipt. An expired,
    // failed or missing receipt cannot prove the media is absent, so never resend.
    const receipt = await inspectReceipt();
    if (receipt.status === "completed") {
      return;
    }
    if (receipt.status === "pending") {
      return await deferToOutboundOwner();
    }
    return await deadLetterAmbiguous({ receipt: receipt.status ?? "missing" });
  }
  await markSessionDeliveryAttemptStarted(entry, params.queueContext);
  const result = await sendDurableMessageBatchCore(
    {
      cfg,
      channel: route.channel,
      to: route.to,
      accountId: route.accountId,
      replyToId: route.replyToId,
      threadId: route.threadId,
      payloads: [{ mediaUrls: params.mediaUrls }],
      session: buildOutboundSessionContext({
        cfg,
        agentId: params.agentId,
        sessionKey: params.canonicalKey,
        conversationType: route.chatType,
      }),
      durability: "required",
      deliveryIntentId,
      reusePendingDeliveryIntent: true,
      completionRetention: GENERATED_MEDIA_DELIVERY_COMPLETION_RETENTION,
      deps: createOutboundSendDeps(params.deps),
    },
    undefined,
    deliveryQueueContext,
    // Outbound custody re-checks the requester before every platform send,
    // including a recovery replay after the requester was reset or replaced.
    sessionGeneration,
  );
  params.queueContext.admission.assertCurrent();
  if (result.status === "sent") {
    return;
  }
  // A replayed intent sends nothing new; its durable receipt owns the outcome.
  const receipt = await inspectReceipt();
  if (receipt.status === "completed") {
    return;
  }
  if (receipt.status === "pending") {
    return await deferToOutboundOwner();
  }
  // A terminally failed intent may have sent before failing; a fresh intent
  // attempt would bypass the outbound owner and could duplicate the media.
  if (receipt.status === "failed" || durableMessageBatchMayHaveReachedRecipient(result)) {
    return await deadLetterAmbiguous({ status: result.status, receipt: receipt.status });
  }
  // Proven unsent: the queue releases this attempt's fence before the retry.
  throw new SessionDeliverySafeRetryError("queued generated-media send did not reach the chat", {
    cause: result.status === "failed" ? result.error : undefined,
  });
}

/** Persist generated media into an internal-route transcript as one idempotent host message. */
async function persistQueuedGeneratedMedia(params: {
  entry: QueuedAgentTurnSessionDelivery;
  mediaUrls: string[];
  canonicalKey: string;
  agentId: string;
  storePath: string;
  sessionEntry?: SessionEntry;
  queueContext: OpenClawStateWorkerContext;
}): Promise<void> {
  const { entry } = params;
  const sessionId = params.sessionEntry?.sessionId?.trim();
  if (!sessionId) {
    throw new Error("queued internal generated-media delivery has no owning session");
  }
  const stateDir = params.queueContext.environment.OPENCLAW_STATE_DIR;
  const preparedMediaBlocks = { ...entry.preparedMediaBlocks };
  const content: Array<Record<string, unknown>> = [];
  for (const mediaUrl of params.mediaUrls) {
    let blocks = preparedMediaBlocks[mediaUrl];
    if (!blocks) {
      const attachment = entry.expectedMediaAttachments?.[mediaUrl];
      blocks = await createManagedOutgoingMediaBlocks({
        sessionKey: params.canonicalKey,
        agentId: params.agentId,
        items: [
          {
            url: mediaUrl,
            ...(attachment?.name ? { filename: attachment.name } : {}),
            ...(attachment?.mimeType ? { mimeType: attachment.mimeType } : {}),
            trustedLocal: true,
            ...(attachment?.durationMs !== undefined ? { durationMs: attachment.durationMs } : {}),
            ...(attachment?.width !== undefined ? { width: attachment.width } : {}),
            ...(attachment?.height !== undefined ? { height: attachment.height } : {}),
          },
        ],
        stateDir,
        localRoots: [getMediaDir()],
      });
      if (
        !blocks.some(
          (block) =>
            block.type === "image" ||
            block.type === "audio" ||
            block.type === "video" ||
            block.type === "attachment",
        )
      ) {
        throw new Error("queued internal generated media could not be prepared");
      }
      // Retries reuse the first prepared blocks so the transcript write stays idempotent.
      blocks = await mergeSessionDeliveryPreparedMediaBlocks(
        entry.id,
        mediaUrl,
        blocks,
        params.queueContext,
      );
      params.queueContext.admission.assertCurrent();
      preparedMediaBlocks[mediaUrl] = blocks;
    }
    content.push(...blocks);
  }
  const binding = entry.requesterBinding;
  params.queueContext.admission.assertCurrent();
  const appended = await appendAssistantMessageToSessionTranscript({
    agentId: params.agentId,
    sessionKey: params.canonicalKey,
    storePath: params.storePath,
    expectedSessionId: sessionId,
    expectedLifecycleRevision: binding
      ? binding.lifecycleRevision
      : (params.sessionEntry?.cronRunContinuation?.lifecycleRevision ??
        params.sessionEntry?.lifecycleRevision ??
        null),
    content: [],
    displayContent: content,
    // Distinct from the retired agent-turn key so a legacy partial delivery
    // cannot collide; stable across retries of this attempt's host stage.
    idempotencyKey: `${resolveQueuedAgentRunId(entry)}:generated-media-host-transcript`,
    updateMode: "inline",
    onMessageCommitted: (receipt, acceptCompletion) => {
      acceptCompletion(async () => {
        if (
          !(await attachManagedOutgoingMediaToMessage({
            messageId: receipt.messageId,
            blocks: readAssistantDisplayContent(receipt.message),
            stateDir,
          }))
        ) {
          throw new Error("queued internal generated-media artifact attachment failed");
        }
      });
    },
  });
  if (!appended.ok) {
    if (appended.code === "session-rebound") {
      await deadLetterSessionDelivery(
        entry,
        "queued internal generated-media delivery lost its owning session",
        params.queueContext,
      );
    }
    throw new Error(
      `queued internal generated-media transcript persistence failed: ${appended.reason}`,
    );
  }
  params.queueContext.admission.assertCurrent();
}

/**
 * Delivers a durable generated-media completion: the host sends the media to the
 * original route, then wakes the owning session with one ordinary completion turn.
 */
export async function deliverQueuedGeneratedMediaCompletion(params: {
  canonicalKey: string;
  agentId: string;
  storePath: string;
  entry: QueuedSessionDelivery;
  deps: CliDeps;
  runtimeContextFragments?: RuntimeContextFragment[];
  sessionEntry?: SessionEntry;
  queueContext: OpenClawStateWorkerContext;
  resolveGatewayContext?: GatewayContextResolver;
}): Promise<boolean> {
  if (params.entry.kind !== "agentTurn") {
    return false;
  }
  const entry = params.entry;
  const binding = entry.requesterBinding;
  const route = entry.route;
  if (!route || entry.inputProvenance?.kind !== "inter_session" || !entry.sourceReplyDeliveryMode) {
    if (binding) {
      return deadLetterSessionDelivery(
        entry,
        "bound media completion has no delivery route",
        params.queueContext,
      );
    }
    return false;
  }

  // Only produced media records attachments. With them already sent, losing
  // the follow-up turn is not a media delivery failure, so the row settles
  // instead of reporting undelivered media for blocked retention.
  const mediaUrls = entry.expectedMediaUrls ?? [];
  const mediaDelivered =
    mediaUrls.length === 0 && Object.keys(entry.expectedMediaAttachments ?? {}).length > 0;
  const abandonCompletion = async (reason: string): Promise<true> => {
    if (!mediaDelivered) {
      return await deadLetterSessionDelivery(entry, reason, params.queueContext);
    }
    log.warn("generated media was delivered; its completion turn was skipped", {
      queueId: entry.id,
      reason,
    });
    return true;
  };

  params.queueContext.admission.assertCurrent();
  const resolveConfig = () =>
    params.resolveGatewayContext?.()?.getRuntimeConfig() ?? getRuntimeConfig();
  const assertRequesterAdmissionCurrent = () => {
    params.queueContext.admission.assertCurrent();
    if (!binding) {
      return;
    }
    const context = params.resolveGatewayContext?.();
    if (params.resolveGatewayContext && !context) {
      throw new SessionDeliveryDeferredError("media completion Gateway owner is unavailable");
    }
    const cfg = context?.getRuntimeConfig() ?? getRuntimeConfig();
    const configuredStorePath = resolveSessionStorePathCore(cfg.session?.store, {
      agentId: binding.agentId,
      env: params.queueContext.environment,
    });
    if (
      entry.sessionKey !== binding.sessionKey ||
      params.canonicalKey !== binding.sessionKey ||
      params.agentId !== binding.agentId ||
      path.resolve(params.storePath) !== path.resolve(binding.storePath) ||
      path.resolve(configuredStorePath) !== path.resolve(binding.storePath)
    ) {
      throw new SessionDeliveryDeadLetteredError("media completion requester store changed");
    }
  };
  const readRequester = async (): Promise<SessionEntry | undefined> => {
    if (!binding) {
      return (
        await loadGatewaySessionEntryReadOnlyInWorker({
          cfg: resolveConfig(),
          key: entry.sessionKey,
          env: params.queueContext.environment,
          assertActive: params.queueContext.admission.assertCurrent,
          excludeInternalEffects: true,
        })
      ).entry;
    }
    return await withSessionEntryReadOnlyInWorker(
      { ...binding, env: params.queueContext.environment, hydrateSkillPromptRefs: false },
      assertRequesterAdmissionCurrent,
      async (read) => {
        if (!read.ok) {
          throw read.error;
        }
        if (
          !sessionMatchesExpectedTranscriptTurn(read.value ? { entry: read.value } : undefined, {
            expectedSessionId: binding.sessionId,
            expectedLifecycleRevision: binding.lifecycleRevision,
          })
        ) {
          throw new SessionDeliveryDeadLetteredError("media completion requester session changed");
        }
        return read.value;
      },
    );
  };
  let sessionEntry: SessionEntry | undefined;
  try {
    sessionEntry = binding ? await readRequester() : params.sessionEntry;
  } catch (error) {
    if (error instanceof SessionDeliveryDeadLetteredError) {
      return await abandonCompletion(error.message);
    }
    throw error;
  }
  // A started attempt may already have produced effects: an interrupted
  // completion turn, or an agent turn persisted by an older release. A started
  // external media send instead settles from its outbound receipt below.
  const externalMediaStage = mediaUrls.length > 0 && route.channel !== INTERNAL_MESSAGE_CHANNEL;
  if (entry.deliveryStartedAt !== undefined && !externalMediaStage) {
    return await abandonCompletion(
      "queued generated-media completion dead-lettered after an interrupted unproven attempt",
    );
  }
  const assertRequesterIdle = () => {
    if (
      isSessionControllerWorkActive(
        params.storePath,
        [params.canonicalKey, sessionEntry?.sessionId],
        params.agentId,
      )
    ) {
      throw new SessionDeliveryDeferredError(
        "queued generated-media completion is waiting for its requester to finish",
      );
    }
  };
  try {
    // The originating turn can still own terminal persistence after its model
    // has stopped; the media and its completion turn follow it.
    assertRequesterIdle();
  } catch (error) {
    await deferSessionDelivery(entry.id, AGENT_DELIVERY_OWNERSHIP_RETRY_MS, params.queueContext);
    throw error;
  }

  if (mediaUrls.length > 0) {
    if (route.channel === INTERNAL_MESSAGE_CHANNEL) {
      await persistQueuedGeneratedMedia({
        ...params,
        entry,
        mediaUrls,
        sessionEntry,
      });
    } else {
      assertRequesterAdmissionCurrent();
      const sessionId = sessionEntry?.sessionId?.trim();
      const sessionGeneration: SessionDeliveryGeneration | undefined =
        binding ??
        (sessionId
          ? {
              agentId: params.agentId,
              storePath: params.storePath,
              sessionKey: params.canonicalKey,
              sessionId,
              lifecycleRevision: sessionEntry?.lifecycleRevision ?? null,
            }
          : undefined);
      if (!sessionGeneration) {
        return await deadLetterSessionDelivery(
          entry,
          "queued generated-media delivery has no owning session",
          params.queueContext,
        );
      }
      await sendQueuedGeneratedMedia({
        ...params,
        entry,
        route,
        mediaUrls,
        cfg: resolveConfig(),
        sessionGeneration,
      });
    }
    await advanceSessionDeliveryAgentRun(
      entry.id,
      {
        expectedMediaUrls: [],
        message: `${formatGeneratedMediaDeliveredForPrompt(mediaUrls)}\n\n${entry.message}`,
      },
      params.queueContext,
    );
    // The completion turn runs from the advanced row on the next drain, so its
    // fence and settlement never write this attempt's stale entry.
    await deferSessionDelivery(entry.id, AGENT_DELIVERY_OWNERSHIP_RETRY_MS, params.queueContext);
    throw new SessionDeliveryDeferredError(
      "queued generated media was delivered; its completion turn follows",
    );
  }

  // The completion turn is an ordinary requester turn: normal tools, normal
  // reply policy. The host already owns the media, so the model may react to it.
  const queuedRunId = resolveQueuedAgentRunId(entry);
  const cronLifecycleRevision = sessionEntry?.cronRunContinuation?.lifecycleRevision?.trim();
  const cronSessionId = cronLifecycleRevision ? sessionEntry?.sessionId?.trim() : undefined;
  // Fence before gateway admission. Recovery clears it only for an explicit
  // pre-acceptance safe retry; an accepted turn may already have effects.
  await markSessionDeliveryAttemptStarted(entry, {
    ...params.queueContext,
    admission: {
      ...params.queueContext.admission,
      assertCurrent: () => {
        params.queueContext.admission.assertCurrent();
        assertRequesterIdle();
      },
    },
  });
  const completionOwner =
    entry.owner?.kind === "subagent_completion" ? subagentRuns.get(entry.owner.runId) : undefined;
  let controllerInput: SessionControllerInput | undefined;
  let accepted = false;
  try {
    assertRequesterAdmissionCurrent();
    controllerInput = completionOwner
      ? await reserveSubagentCompletionControllerSource(completionOwner, queuedRunId)
      : undefined;
    assertRequesterAdmissionCurrent();
    await dispatchGatewayMethodInProcess(
      "agent",
      {
        sessionKey: params.canonicalKey,
        ...(binding
          ? {
              agentId: binding.agentId,
              expectedExistingSessionId: binding.sessionId,
              expectedExistingSessionLifecycleRevision: binding.lifecycleRevision,
            }
          : {}),
        message: entry.message,
        deliver: route.channel !== INTERNAL_MESSAGE_CHANNEL,
        bestEffortDeliver: false,
        channel: route.channel,
        accountId: route.accountId,
        to: route.to,
        threadId: route.threadId,
        ...(cronSessionId ? { sessionId: cronSessionId } : {}),
        inputProvenance: entry.inputProvenance,
        sourceReplyDeliveryMode: entry.sourceReplyDeliveryMode,
        idempotencyKey: queuedRunId,
      },
      {
        controllerInput,
        ...(cronSessionId ? { allowSyntheticCronRunContinuation: true } : {}),
        expectFinal: true,
        ...(binding ? { assertAdmissionCurrent: assertRequesterAdmissionCurrent } : {}),
        forceSyntheticClient: true,
        runtimeContextFragments: params.runtimeContextFragments,
        ...(params.resolveGatewayContext
          ? { resolveGatewayContext: params.resolveGatewayContext }
          : {}),
        onAccepted: () => {
          accepted = true;
        },
      },
    );
  } catch (error) {
    if (error instanceof SessionDeliveryDeadLetteredError) {
      return await abandonCompletion(error.message);
    }
    if (!accepted) {
      throw new SessionDeliverySafeRetryError(
        "queued generated-media completion turn failed before gateway acceptance",
        { cause: error },
      );
    }
    throw error;
  } finally {
    if (controllerInput && !controllerInput.custody.rpcAdopted) {
      retireSessionControllerInput(controllerInput);
    }
  }
  return true;
}
