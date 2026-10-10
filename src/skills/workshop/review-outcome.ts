import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { extractDeliveryInfo } from "../../config/sessions/delivery-info.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import type { SessionDeliveryGeneration } from "../../config/sessions/session-delivery-generation.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildOutboundSessionContext } from "../../infra/outbound/session-context.js";
import { resolveSystemEventQueueKey } from "../../infra/system-event-ownership.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import type { WorkshopChange } from "./changes.kernel.js";

const log = createSubsystemLogger("skills/workshop");

/**
 * A background Workshop run fails only when the model or runtime failed. Tool errors — a refused
 * write, a gated tool, a patch that did not match — are the model's to handle, not run failures.
 */
export function assertSkillReviewRunSucceeded(
  result: Pick<EmbeddedAgentRunResult, "meta" | "payloads">,
): void {
  const runtimeErrorPayload = result.payloads?.find(
    (payload) => payload.isError && !getReplyPayloadMetadata(payload)?.toolErrorWarning,
  );
  const message =
    result.meta.error?.message.trim() ||
    (result.meta.aborted ? "Skill review model run aborted." : undefined) ||
    runtimeErrorPayload?.text?.trim();
  if (message || runtimeErrorPayload) {
    throw new Error(message || "Skill review model run failed.");
  }
}

const ACTION_VERB: Record<WorkshopChange["action"], string> = {
  create: "created",
  patch: "updated",
  write_file: "updated",
  remove_file: "updated",
  archive: "archived",
  restore: "restored",
};

/** The notice keeps a creation or latest edit; undo keeps the version before the first edit. */
function formatWorkshopChangeNotice(changes: readonly WorkshopChange[]) {
  const bySkill = new Map<string, WorkshopChange>();
  const firstBySkill = new Map<string, WorkshopChange>();
  for (const change of changes.toSorted((a, b) => a.createdAtMs - b.createdAtMs)) {
    if (!firstBySkill.has(change.skillName)) {
      firstBySkill.set(change.skillName, change);
    }
    if (bySkill.get(change.skillName)?.action !== "create") {
      bySkill.set(change.skillName, change);
    }
  }
  const parts = [...bySkill.values()].map((change) => {
    const summary = change.summary.trim();
    return `${ACTION_VERB[change.action]} \`${change.skillName}\`${summary ? ` (${summary})` : ""}`;
  });
  const text = `💾 Learned: ${parts.join("; ")}. Say "undo" to revert this skill change.`;
  // No prior version means the review created the skill, so undo archives it.
  const reverts = [...firstBySkill.values()].map(({ skillName, versionId }) =>
    versionId
      ? `skill_workshop action=restore name=${skillName} version=${versionId}`
      : `skill_workshop action=archive name=${skillName} reason="undo"`,
  );
  return {
    text,
    undoContext: `A background skill review just changed your learned skills and told the user: ${text} If the user asks to undo or revert it, call ${reverts.join("; then ")}.`,
  };
}

/**
 * Posts the notice into the originating conversation: external channels get a durable send
 * mirrored into the session transcript; channel-less sessions (Control UI) get a transcript
 * entry. The next foreground turn also gets a system event naming the exact revert call,
 * because an assistant line the model did not write is weak evidence that "undo" means it.
 * A conversation reset or replaced since the review started gets none of it.
 */
export async function postWorkshopChangeNotice(params: {
  config: OpenClawConfig;
  /** The reviewed session generation; the notice belongs to it, not to a later reset. */
  generation: SessionDeliveryGeneration;
  runId: string;
  changes: readonly WorkshopChange[];
}): Promise<void> {
  if (params.changes.length === 0) {
    return;
  }
  const { generation } = params;
  const { agentId, sessionKey } = generation;
  const isReviewedGeneration = () => {
    const current = loadSessionEntryReadOnly({
      agentId,
      sessionKey,
      storePath: generation.storePath,
      hydrateSkillPromptRefs: false,
      readConsistency: "latest",
    });
    return (
      current?.sessionId === generation.sessionId &&
      (current.lifecycleRevision ?? null) === generation.lifecycleRevision
    );
  };
  if (!isReviewedGeneration()) {
    log.debug(`skill workshop notice skipped: session ${sessionKey} was reset`);
    return;
  }
  const { text, undoContext } = formatWorkshopChangeNotice(params.changes);
  enqueueSystemEvent(undoContext, {
    sessionKey: resolveSystemEventQueueKey(sessionKey, agentId),
  });
  const idempotencyKey = `skill-workshop-notice:${params.runId}`;
  try {
    const { deliveryContext: target, threadId } = extractDeliveryInfo(sessionKey, {
      cfg: params.config,
    });
    const channel = target?.channel ? normalizeMessageChannel(target.channel) : undefined;
    if (channel && isDeliverableMessageChannel(channel) && target?.to) {
      // Delivery and transcript runtimes stay lazy: most reviews change nothing.
      const { sendDurableMessageBatchCore } = await import("../../channels/message/runtime.js");
      const send = await sendDurableMessageBatchCore(
        {
          cfg: params.config,
          channel,
          to: target.to,
          accountId: target.accountId,
          // The session key's thread is canonical; stored context may name a stale thread.
          threadId: threadId ?? target.threadId,
          payloads: [{ text }],
          session: buildOutboundSessionContext({ cfg: params.config, sessionKey, agentId }),
          mirror: {
            sessionKey,
            agentId,
            idempotencyKey,
            expectedSessionId: generation.sessionId,
          },
          bestEffort: true,
        },
        undefined,
        undefined,
        generation,
      );
      if (send.status === "failed" || send.status === "partial_failed") {
        throw send.error;
      }
      return;
    }
    const { appendAssistantMessageToSessionTranscript } =
      await import("../../config/sessions/transcript.runtime.js");
    const appended = await appendAssistantMessageToSessionTranscript({
      agentId,
      sessionKey,
      storePath: generation.storePath,
      expectedSessionId: generation.sessionId,
      expectedLifecycleRevision: generation.lifecycleRevision,
      text,
      idempotencyKey,
      config: params.config,
    });
    if (!appended.ok) {
      throw new Error(appended.reason);
    }
  } catch (error) {
    if (!isReviewedGeneration()) {
      log.debug(`skill workshop notice skipped: session ${sessionKey} was reset`);
      return;
    }
    // The system event above still carries the change to the next turn.
    log.warn(`skill workshop notice delivery failed: ${String(error)}`);
  }
}
