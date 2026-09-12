import type { SessionEntry } from "../../config/sessions/types.js";
import { copyReplyPayloadMetadata, markCommandReplyForDelivery } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import {
  bindModelNoticePublication,
  type ModelNoticeTranscript,
} from "./model-notice-publication.js";
import { normalizeReplyPayload } from "./normalize-reply.js";

type ModelPolicyNoticeParams = {
  payloads: ReplyPayload[];
  pinnedModel: string;
  primaryModel: string;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  storePath?: string;
  transcript?: ModelNoticeTranscript;
};

function findModelNoticePayload(payloads: ReplyPayload[]) {
  const candidates = payloads.flatMap((original, index) => {
    if (original.isReasoning || original.isCommentary || original.isFallbackNotice) {
      return [];
    }
    const normalized = normalizeReplyPayload(original, { applyChannelTransforms: false });
    return normalized ? [{ original, normalized, index }] : [];
  });
  return candidates.find(({ original }) => !original.isError) ?? candidates[0];
}

/** A turn-local correction uses the same final publication boundary as policy notices. */
export function attachMissingConfiguredPrimaryNotice(params: {
  payloads: ReplyPayload[];
  missingPrimary?: string;
  primaryModel: string;
  transcript?: ModelNoticeTranscript;
}): ReplyPayload[] {
  if (!params.missingPrimary) {
    return params.payloads;
  }
  const candidate = findModelNoticePayload(params.payloads);
  if (!candidate) {
    return params.payloads;
  }
  const { original, normalized, index } = candidate;
  const notice = original.isError
    ? `Configured primary ${params.missingPrimary} is not in the model catalog, and the default could not answer. Update your primary model in settings.`
    : `Configured primary ${params.missingPrimary} is not in the model catalog. This reply used the default (${params.primaryModel}). Update your primary model in settings.`;
  const payload = copyReplyPayloadMetadata(original, {
    ...normalized,
    text: normalized.text ? `${notice}\n\n${normalized.text}` : notice,
  });
  bindModelNoticePublication({ original, payload, notice, transcript: params.transcript });
  return params.payloads.map((existing, payloadIndex) =>
    payloadIndex === index ? payload : existing,
  );
}

/** The notice preserves the input payload count, including silent payloads. */
export function attachModelPolicyNotice(
  params: ModelPolicyNoticeParams & { payloads: [ReplyPayload, ...ReplyPayload[]] },
): [ReplyPayload, ...ReplyPayload[]];
export function attachModelPolicyNotice(params: ModelPolicyNoticeParams): ReplyPayload[];
export function attachModelPolicyNotice(params: ModelPolicyNoticeParams): ReplyPayload[] {
  const { sessionEntry, pinnedModel, primaryModel, sessionKey, storePath } = params;
  const sessionId = sessionEntry?.sessionId;
  const candidate = findModelNoticePayload(params.payloads);
  if (!candidate) {
    return params.payloads;
  }
  const { original, normalized, index } = candidate;
  if (
    !original.isError &&
    sessionId &&
    sessionEntry.modelPolicyNotice?.sessionId === sessionId &&
    sessionEntry.modelPolicyNotice.pinnedModel === pinnedModel
  ) {
    return params.payloads;
  }
  const notice = original.isError
    ? `Pinned model ${pinnedModel} is not in your allow list, and the configured default could not answer. Use /model to change it.`
    : `Pinned model ${pinnedModel} is not in your allow list. This reply used the default (${primaryModel}). Use /model to change it.`;
  const payload = copyReplyPayloadMetadata(original, {
    ...normalized,
    text: normalized.text ? `${notice}\n\n${normalized.text}` : notice,
  });
  bindModelNoticePublication({
    original,
    payload,
    notice,
    transcript: params.transcript,
    recordReceipt: async (canCommit) => {
      if (original.isError || !sessionEntry || !sessionId || !sessionKey) {
        return;
      }
      const receipt = { sessionId, pinnedModel };
      const { patchSessionEntryCore } = await import("../../config/sessions/session-accessor.js");
      const updated = await patchSessionEntryCore(
        { storePath, sessionKey, agentId: params.transcript?.scope.agentId },
        (current) =>
          canCommit(current) && current.sessionId === sessionId
            ? { modelPolicyNotice: receipt }
            : null,
        { preserveActivity: true, skipMaintenance: true },
      );
      if (!updated) {
        return;
      }
      if (canCommit(sessionEntry)) {
        sessionEntry.modelPolicyNotice = receipt;
      }
    },
  });
  return params.payloads.map((existing, payloadIndex) =>
    payloadIndex === index ? payload : existing,
  );
}

export function attachModelPolicyCommandNotice(params: {
  reply: ReplyPayload | ReplyPayload[] | undefined;
  pinnedModel?: string;
  usesPrimary?: boolean;
  provider: string;
  model: string;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  storePath?: string;
}): ReplyPayload | ReplyPayload[] | undefined {
  const reply = markCommandReplyForDelivery(params.reply);
  const { sessionEntry, pinnedModel } = params;
  if (!reply || !params.usesPrimary || !pinnedModel) {
    return reply;
  }
  if (
    sessionEntry?.modelOverride &&
    `${sessionEntry.providerOverride ?? params.provider}/${sessionEntry.modelOverride}` !==
      pinnedModel
  ) {
    return reply;
  }
  const payloads = attachModelPolicyNotice({
    ...params,
    payloads: Array.isArray(reply) ? reply : [reply],
    pinnedModel,
    primaryModel: `${params.provider}/${params.model}`,
  });
  return Array.isArray(reply) ? payloads : payloads[0];
}

export function attachModelPolicyFailureNotice(
  reply: ReplyPayload,
  run: {
    blockedModelOverrideRef?: string;
    blockedModelOverrideUsesPrimary?: boolean;
    provider: string;
    model: string;
  },
): ReplyPayload {
  if (!reply.isError || !run.blockedModelOverrideUsesPrimary || !run.blockedModelOverrideRef) {
    return reply;
  }
  return attachModelPolicyNotice({
    payloads: [reply],
    pinnedModel: run.blockedModelOverrideRef,
    primaryModel: `${run.provider}/${run.model}`,
  })[0];
}
