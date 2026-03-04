import type { ReplyPayload } from "../auto-reply/types.js";
import type { TelegramInlineButtons } from "./button-types.js";
import type { TelegramDraftStream } from "./draft-stream.js";

export type LaneName = "answer" | "reasoning";

export type DraftLaneState = {
  stream: TelegramDraftStream | undefined;
  lastPartialText: string;
  hasStreamedMessage: boolean;
};

export type ArchivedPreview = {
  messageId: number;
  textSnapshot: string;
  // Boundary-finalized previews should remain visible even if no matching
  // final edit arrives; superseded previews can be safely deleted.
  deleteIfUnused?: boolean;
};

export type LaneDeliveryResult = "preview-finalized" | "preview-updated" | "sent" | "skipped";

export type LaneDeliverySnapshot = {
  delivered: boolean;
  skippedNonSilent: number;
  failedNonSilent: number;
};

export type LaneDeliveryStateTracker = {
  markDelivered: () => void;
  markNonSilentSkip: () => void;
  markNonSilentFailure: () => void;
  snapshot: () => LaneDeliverySnapshot;
};

export function createLaneDeliveryStateTracker(): LaneDeliveryStateTracker {
  const state: LaneDeliverySnapshot = {
    delivered: false,
    skippedNonSilent: 0,
    failedNonSilent: 0,
  };
  return {
    markDelivered: () => {
      state.delivered = true;
    },
    markNonSilentSkip: () => {
      state.skippedNonSilent += 1;
    },
    markNonSilentFailure: () => {
      state.failedNonSilent += 1;
    },
    snapshot: () => ({ ...state }),
  };
}

type CreateLaneTextDelivererParams = {
  lanes: Record<LaneName, DraftLaneState>;
  archivedAnswerPreviews: ArchivedPreview[];
  finalizedPreviewByLane: Record<LaneName, boolean>;
  draftMaxChars: number;
  applyTextToPayload: (payload: ReplyPayload, text: string) => ReplyPayload;
  sendPayload: (payload: ReplyPayload) => Promise<boolean>;
  flushDraftLane: (lane: DraftLaneState) => Promise<void>;
  stopDraftLane: (lane: DraftLaneState) => Promise<void>;
  editPreview: (params: {
    laneName: LaneName;
    messageId: number;
    text: string;
    context: "final" | "update";
    previewButtons?: TelegramInlineButtons;
  }) => Promise<void>;
  deletePreviewMessage: (messageId: number) => Promise<void>;
  log: (message: string) => void;
  markDelivered: () => void;
};

type DeliverLaneTextParams = {
  laneName: LaneName;
  text: string;
  payload: ReplyPayload;
  infoKind: string;
  previewButtons?: TelegramInlineButtons;
  allowPreviewUpdateForNonFinal?: boolean;
  /** When true, ignore the finalizedPreviewByLane guard and allow re-editing
   *  a previously finalized preview. Used in partial (coalesced) streaming mode
   *  where multiple finals should edit the same message. */
  allowRefinalize?: boolean;
};

type TryUpdatePreviewParams = {
  lane: DraftLaneState;
  laneName: LaneName;
  text: string;
  previewButtons?: TelegramInlineButtons;
  stopBeforeEdit?: boolean;
  updateLaneSnapshot?: boolean;
  skipRegressive: "always" | "existingOnly";
  context: "final" | "update";
  previewMessageId?: number;
  previewTextSnapshot?: string;
};

type ConsumeArchivedAnswerPreviewParams = {
  lane: DraftLaneState;
  text: string;
  payload: ReplyPayload;
  previewButtons?: TelegramInlineButtons;
  canEditViaPreview: boolean;
};

type PreviewUpdateContext = "final" | "update";
type RegressiveSkipMode = "always" | "existingOnly";

type ResolvePreviewTargetParams = {
  lane: DraftLaneState;
  previewMessageIdOverride?: number;
  stopBeforeEdit: boolean;
  context: PreviewUpdateContext;
};

type PreviewTargetResolution = {
  hadPreviewMessage: boolean;
  previewMessageId: number | undefined;
  stopCreatesFirstPreview: boolean;
};

function shouldSkipRegressivePreviewUpdate(args: {
  currentPreviewText: string | undefined;
  text: string;
  skipRegressive: RegressiveSkipMode;
  hadPreviewMessage: boolean;
}): boolean {
  const currentPreviewText = args.currentPreviewText;
  if (currentPreviewText === undefined) {
    return false;
  }
  return (
    currentPreviewText.startsWith(args.text) &&
    args.text.length < currentPreviewText.length &&
    (args.skipRegressive === "always" || args.hadPreviewMessage)
  );
}

function resolvePreviewTarget(params: ResolvePreviewTargetParams): PreviewTargetResolution {
  const lanePreviewMessageId = params.lane.stream?.messageId();
  const previewMessageId =
    typeof params.previewMessageIdOverride === "number"
      ? params.previewMessageIdOverride
      : lanePreviewMessageId;
  const hadPreviewMessage =
    typeof params.previewMessageIdOverride === "number" || typeof lanePreviewMessageId === "number";
  return {
    hadPreviewMessage,
    previewMessageId: typeof previewMessageId === "number" ? previewMessageId : undefined,
    stopCreatesFirstPreview:
      params.stopBeforeEdit && !hadPreviewMessage && params.context === "final",
  };
}

export function createLaneTextDeliverer(params: CreateLaneTextDelivererParams) {
  const getLanePreviewText = (lane: DraftLaneState) => lane.lastPartialText;
  const isDraftPreviewLane = (lane: DraftLaneState) => lane.stream?.previewMode?.() === "draft";

  const tryEditPreviewMessage = async (args: {
    laneName: LaneName;
    messageId: number;
    text: string;
    context: "final" | "update";
    previewButtons?: TelegramInlineButtons;
    updateLaneSnapshot: boolean;
    lane: DraftLaneState;
    treatEditFailureAsDelivered: boolean;
  }): Promise<boolean> => {
    try {
      await params.editPreview({
        laneName: args.laneName,
        messageId: args.messageId,
        text: args.text,
        previewButtons: args.previewButtons,
        context: args.context,
      });
      if (args.updateLaneSnapshot) {
        args.lane.lastPartialText = args.text;
      }
      params.markDelivered();
      return true;
    } catch (err) {
      if (args.treatEditFailureAsDelivered) {
        params.log(
          `telegram: ${args.laneName} preview ${args.context} edit failed after stop-created flush; treating as delivered (${String(err)})`,
        );
        params.markDelivered();
        return true;
      }
      params.log(
        `telegram: ${args.laneName} preview ${args.context} edit failed; falling back to standard send (${String(err)})`,
      );
      return false;
    }
  };

  const tryUpdatePreviewForLane = async ({
    lane,
    laneName,
    text,
    previewButtons,
    stopBeforeEdit = false,
    updateLaneSnapshot = false,
    skipRegressive,
    context,
    previewMessageId: previewMessageIdOverride,
    previewTextSnapshot,
  }: TryUpdatePreviewParams): Promise<boolean> => {
    const editPreview = (messageId: number, treatEditFailureAsDelivered: boolean) =>
      tryEditPreviewMessage({
        laneName,
        messageId,
        text,
        context,
        previewButtons,
        updateLaneSnapshot,
        lane,
        treatEditFailureAsDelivered,
      });
    const finalizePreview = (
      previewMessageId: number,
      treatEditFailureAsDelivered: boolean,
      hadPreviewMessage: boolean,
    ): boolean | Promise<boolean> => {
      const currentPreviewText = previewTextSnapshot ?? getLanePreviewText(lane);
      const shouldSkipRegressive = shouldSkipRegressivePreviewUpdate({
        currentPreviewText,
        text,
        skipRegressive,
        hadPreviewMessage,
      });
      if (shouldSkipRegressive) {
        params.markDelivered();
        return true;
      }
      return editPreview(previewMessageId, treatEditFailureAsDelivered);
    };
    if (!lane.stream) {
      return false;
    }
    const previewTargetBeforeStop = resolvePreviewTarget({
      lane,
      previewMessageIdOverride,
      stopBeforeEdit,
      context,
    });
    if (previewTargetBeforeStop.stopCreatesFirstPreview) {
      // Final stop() can create the first visible preview message.
      // Prime pending text so the stop flush sends the final text snapshot.
      lane.stream.update(text);
      await params.stopDraftLane(lane);
      const previewTargetAfterStop = resolvePreviewTarget({
        lane,
        stopBeforeEdit: false,
        context,
      });
      if (typeof previewTargetAfterStop.previewMessageId !== "number") {
        return false;
      }
      return finalizePreview(previewTargetAfterStop.previewMessageId, true, false);
    }
    if (stopBeforeEdit) {
      await params.stopDraftLane(lane);
    }
    const previewTargetAfterStop = resolvePreviewTarget({
      lane,
      previewMessageIdOverride,
      stopBeforeEdit: false,
      context,
    });
    if (typeof previewTargetAfterStop.previewMessageId !== "number") {
      return false;
    }
    return finalizePreview(
      previewTargetAfterStop.previewMessageId,
      false,
      previewTargetAfterStop.hadPreviewMessage,
    );
  };

  const consumeArchivedAnswerPreviewForFinal = async ({
    lane,
    text,
    payload,
    previewButtons,
    canEditViaPreview,
  }: ConsumeArchivedAnswerPreviewParams): Promise<LaneDeliveryResult | undefined> => {
    const archivedPreview = params.archivedAnswerPreviews.shift();
    if (!archivedPreview) {
      return undefined;
    }
    if (canEditViaPreview) {
      const finalized = await tryUpdatePreviewForLane({
        lane,
        laneName: "answer",
        text,
        previewButtons,
        stopBeforeEdit: false,
        skipRegressive: "existingOnly",
        context: "final",
        previewMessageId: archivedPreview.messageId,
        previewTextSnapshot: archivedPreview.textSnapshot,
      });
      if (finalized) {
        return "preview-finalized";
      }
    }
    // Send the replacement message first, then clean up the old preview.
    // This avoids the visual "disappear then reappear" flash.
    const delivered = await params.sendPayload(params.applyTextToPayload(payload, text));
    // Once this archived preview is consumed by a fallback final send, delete it
    // regardless of deleteIfUnused. That flag only applies to unconsumed boundaries.
    if (delivered || archivedPreview.deleteIfUnused !== false) {
      try {
        await params.deletePreviewMessage(archivedPreview.messageId);
      } catch (err) {
        params.log(
          `telegram: archived answer preview cleanup failed (${archivedPreview.messageId}): ${String(err)}`,
        );
      }
    }
    return delivered ? "sent" : "skipped";
  };

  return async ({
    laneName,
    text,
    payload,
    infoKind,
    previewButtons,
    allowPreviewUpdateForNonFinal = false,
    allowRefinalize = false,
  }: DeliverLaneTextParams): Promise<LaneDeliveryResult> => {
    const lane = params.lanes[laneName];
    const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
    const canEditViaPreview =
      !hasMedia && text.length > 0 && text.length <= params.draftMaxChars && !payload.isError;

    if (infoKind === "final") {
      if (laneName === "answer") {
        const archivedResult = await consumeArchivedAnswerPreviewForFinal({
          lane,
          text,
          payload,
          previewButtons,
          canEditViaPreview,
        });
        if (archivedResult) {
          return archivedResult;
        }
      }
      if (canEditViaPreview && (allowRefinalize || !params.finalizedPreviewByLane[laneName])) {
        await params.flushDraftLane(lane);
        if (laneName === "answer") {
          const archivedResultAfterFlush = await consumeArchivedAnswerPreviewForFinal({
            lane,
            text,
            payload,
            previewButtons,
            canEditViaPreview,
          });
          if (archivedResultAfterFlush) {
            return archivedResultAfterFlush;
          }
        }
        const finalized = await tryUpdatePreviewForLane({
          lane,
          laneName,
          text,
          previewButtons,
          stopBeforeEdit: true,
          skipRegressive: "existingOnly",
          context: "final",
        });
        if (finalized) {
          params.finalizedPreviewByLane[laneName] = true;
          return "preview-finalized";
        }
      } else if (!hasMedia && !payload.isError && text.length > params.draftMaxChars) {
        params.log(
          `telegram: preview final too long for edit (${text.length} > ${params.draftMaxChars}); falling back to standard send`,
        );
      }
      await params.stopDraftLane(lane);
      const delivered = await params.sendPayload(params.applyTextToPayload(payload, text));
      return delivered ? "sent" : "skipped";
    }

    if (allowPreviewUpdateForNonFinal && canEditViaPreview) {
      if (isDraftPreviewLane(lane)) {
        // DM draft flow has no message_id to edit; updates are sent via sendMessageDraft.
        // Only mark as updated when the draft flush actually emits an update.
        const previewRevisionBeforeFlush = lane.stream?.previewRevision?.() ?? 0;
        lane.stream?.update(text);
        await params.flushDraftLane(lane);
        const previewUpdated = (lane.stream?.previewRevision?.() ?? 0) > previewRevisionBeforeFlush;
        if (!previewUpdated) {
          params.log(
            `telegram: ${laneName} draft preview update not emitted; falling back to standard send`,
          );
          const delivered = await params.sendPayload(params.applyTextToPayload(payload, text));
          return delivered ? "sent" : "skipped";
        }
        lane.lastPartialText = text;
        params.markDelivered();
        return "preview-updated";
      }
      const updated = await tryUpdatePreviewForLane({
        lane,
        laneName,
        text,
        previewButtons,
        stopBeforeEdit: false,
        updateLaneSnapshot: true,
        skipRegressive: "always",
        context: "update",
      });
      if (updated) {
        return "preview-updated";
      }
    }

    const delivered = await params.sendPayload(params.applyTextToPayload(payload, text));
    return delivered ? "sent" : "skipped";
  };
}
