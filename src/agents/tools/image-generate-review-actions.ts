import { getRuntimeConfig } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { inspectDeliveryQueueReceipt } from "../../infra/delivery-queue-sqlite.js";
import { readLocalFileSafely } from "../../infra/fs-safe.js";
import { scheduleSessionDelivery } from "../../infra/session-delivery-queue-runtime.js";
import {
  loadPendingSessionDeliveries,
  loadPendingSessionDelivery,
  setSessionDeliveryMediaReview,
  sessionDeliveryRequesterMatchesConfiguredStore,
} from "../../infra/session-delivery-queue-storage.js";
import { SESSION_DELIVERY_QUEUE_NAME } from "../../infra/session-delivery-queue.records.js";
import { resolveGeneratedMediaMaxBytes } from "../../media/configured-max-bytes.js";
import { saveMediaBuffer } from "../../media/store.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  findMediaGenerationOperation,
  retainMediaGenerationProducedOutput,
  supersedeMediaGenerationOperation,
} from "../media-generation-activity.js";
import { resolveRequesterStoreKey } from "../subagents/announce/subagent-requester-store-key.js";
import { ToolInputError } from "./common.js";
import {
  mediaGenerationCompletionDeliveryKey,
  supersedeMediaGenerationCandidate,
} from "./media-generate-background-completion.js";
import { captureMediaGenerationAdmission } from "./media-generate-background-shared.js";
import type { MediaGenerateActionResult } from "./media-generate-tool-actions-shared.js";

const REVIEW_CANDIDATE_PAGE_SIZE = 8;

/** Decisions stay scoped to one original task, never the newest job in a conversation. */
export async function createImageGenerateReviewActionResult(params: {
  action: "review" | "deliver" | "supersede";
  taskId?: string;
  cursor?: string;
  sessionKey?: string;
  requesterRunSessionKey?: string;
  agentId?: string;
}): Promise<MediaGenerateActionResult> {
  const assertCurrent = captureMediaGenerationAdmission();
  assertCurrent();
  const { sessionKey, taskId, action } = params;
  if (!sessionKey) {
    throw new ToolInputError("Image review requires the original chat session.");
  }
  if (action !== "review" && !taskId) {
    throw new ToolInputError("taskId is required for an exact-task delivery decision.");
  }
  const cfg = getRuntimeConfig();
  const context = captureOpenClawStateWorkerContext();
  const agentId = params.agentId ?? resolveAgentIdFromSessionKey(sessionKey);
  const requesterKey = resolveRequesterStoreKey(
    cfg,
    params.requesterRunSessionKey ?? sessionKey,
    agentId,
  );
  const currentRequester = await readSessionEntryReadOnlyInWorker(
    {
      agentId,
      sessionKey: requesterKey,
      storePath: resolveSessionStorePathCore(cfg.session?.store, {
        agentId,
        env: context.environment,
      }),
      env: context.environment,
      hydrateSkillPromptRefs: false,
    },
    assertCurrent,
  );
  assertCurrent();
  const operation = taskId ? findMediaGenerationOperation(taskId) : undefined;
  const ownsTask =
    operation &&
    operation.taskKind === "image_generation" &&
    operation.requesterSessionKey === sessionKey &&
    operation.requesterSessionId === currentRequester?.sessionId &&
    operation.requesterStorePath !== undefined &&
    sessionDeliveryRequesterMatchesConfiguredStore(
      { agentId, storePath: operation.requesterStorePath },
      context.environment,
      cfg,
    ) &&
    operation.requesterLifecycleRevision === (currentRequester?.lifecycleRevision ?? null) &&
    (operation.requesterAgentId ?? resolveAgentIdFromSessionKey(sessionKey)) === agentId;
  if (currentRequester?.incognito) {
    throw new ToolInputError("Image review requires a durable chat session.");
  }
  const ownsRunningTask = ownsTask && operation?.endedAt === undefined;
  if (action === "supersede" && ownsTask && taskId) {
    supersedeMediaGenerationOperation(taskId);
  }
  const queueId = taskId
    ? sha256Hex(mediaGenerationCompletionDeliveryKey("image_generate", taskId))
    : undefined;
  let entries = queueId
    ? [await loadPendingSessionDelivery(queueId, context)]
    : await loadPendingSessionDeliveries(context);
  assertCurrent();
  const observeSettlement = async () => {
    if (!queueId) {
      return false;
    }
    const receipt = await inspectDeliveryQueueReceipt(SESSION_DELIVERY_QUEUE_NAME, queueId, false, {
      stateDir: context.environment.OPENCLAW_STATE_DIR,
      workerContext: context,
    });
    assertCurrent();
    return receipt.status === "completed" || receipt.status === "failed";
  };
  let settledDelivery = false;
  if (action === "supersede" && operation && ownsRunningTask && queueId && !entries[0]) {
    settledDelivery = await observeSettlement();
    if (!settledDelivery) {
      const retaining = retainMediaGenerationProducedOutput(operation);
      if (retaining) {
        await retaining;
        entries = [await loadPendingSessionDelivery(queueId, context)];
        assertCurrent();
        if (!entries[0]) {
          settledDelivery = await observeSettlement();
        }
      }
    }
  }
  const candidates = entries.filter(
    (entry) =>
      entry != null &&
      entry.kind !== "systemEvent" &&
      entry.sessionKey === requesterKey &&
      entry.requesterBinding?.agentId === agentId &&
      sessionDeliveryRequesterMatchesConfiguredStore(
        entry.requesterBinding,
        context.environment,
        cfg,
      ) &&
      currentRequester !== undefined &&
      entry.requesterBinding.sessionId === currentRequester.sessionId &&
      entry.requesterBinding.lifecycleRevision === (currentRequester.lifecycleRevision ?? null) &&
      (taskId
        ? entry.kind !== "mediaCandidate" || entry.taskId === taskId
        : entry.kind === "mediaCandidate"),
  );
  const candidate = candidates[0];
  if (action === "review") {
    // Task IDs are stable cursors even after a preceding candidate is approved.
    const remaining = candidates
      .filter((entry) => entry?.kind === "mediaCandidate")
      .filter((entry) => taskId || !params.cursor || entry.taskId.localeCompare(params.cursor) > 0)
      .toSorted((left, right) => left.taskId.localeCompare(right.taskId));
    const page = taskId ? remaining : remaining.slice(0, REVIEW_CANDIDATE_PAGE_SIZE);
    const nextCursor =
      !taskId && remaining.length > page.length ? (page.at(-1)?.taskId ?? null) : null;
    const held = [];
    for (const entry of page) {
      const inspectionFiles: string[] = [];
      if (taskId) {
        // Reuse the generated-media owner instead of granting workspace-only
        // readers access to the queue spool. These private copies keep its normal TTL.
        const maxBytes = resolveGeneratedMediaMaxBytes(cfg, "image");
        for (const url of entry.expectedMediaUrls ?? []) {
          const { buffer } = await readLocalFileSafely({ filePath: url, maxBytes });
          assertCurrent();
          const attachment = entry.expectedMediaAttachments?.[url];
          const saved = await saveMediaBuffer(
            buffer,
            attachment?.mimeType,
            "tool-image-review",
            maxBytes,
            attachment?.name,
          );
          inspectionFiles.push(saved.path);
        }
      }
      held.push({
        taskId: entry.taskId,
        disposition: entry.disposition,
        ...(taskId
          ? {
              files: entry.expectedMediaUrls ?? [],
              inspectionFiles,
              inspectionContext: entry.inspectionContext,
            }
          : { imageCount: entry.expectedMediaUrls?.length ?? 0 }),
      });
    }
    assertCurrent();
    return {
      content: [
        {
          type: "text",
          text: held.length
            ? "Saved image candidates (not delivery confirmation). For private inspection, add taskId for inspectionFiles and inspectionContext; continue a listing with cursor=nextCursor:\n" +
              JSON.stringify({ candidates: held, nextCursor })
            : "No held image candidates found for this session.",
        },
      ],
      details: { action, candidates: held, nextCursor, media: { outbound: false } },
    };
  }
  if (!candidate || !taskId) {
    const status =
      action === "supersede" && ownsRunningTask
        ? settledDelivery
          ? "delivery_started"
          : "superseded"
        : "not_found";
    return {
      content: [
        {
          type: "text",
          text:
            status === "superseded"
              ? "Only that task was superseded. Accepted generation continues; its paid output will be saved without automatic delivery."
              : status === "delivery_started"
                ? "Delivery for this task already started or settled. It cannot be suppressed retroactively; reconcile its existing receipt rather than resending."
                : "No pending candidate found. It may already have been sent; do not resend or regenerate based on this result alone.",
        },
      ],
      details: { action, taskId, status },
    };
  }
  const status =
    action === "deliver"
      ? await setSessionDeliveryMediaReview(candidate, taskId, "approved", context)
      : await supersedeMediaGenerationCandidate(candidate, taskId, context);
  assertCurrent();
  if (status === "approved") {
    await scheduleSessionDelivery(candidate.id, context);
  }
  return {
    content: [
      {
        type: "text",
        text:
          status === "approved"
            ? "The exact candidate is approved for delivery by its existing queue. Delivery is pending, not confirmed. Do not send the files again."
            : status === "superseded"
              ? "Only that task was superseded; its saved output is retained without automatic delivery."
              : status === "delivery_started"
                ? "Delivery already started or may have completed. It cannot be retracted; reconcile its existing receipt instead of resending."
                : "This task is not a held review candidate.",
      },
    ],
    details: { action, taskId, status },
  };
}
