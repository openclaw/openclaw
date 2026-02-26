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

export function createLaneTextDeliverer(params: CreateLaneTextDelivererParams) {
  const getLanePreviewText = (lane: DraftLaneState) => lane.lastPartialText;

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
    if (!lane.stream) {
      return false;
    }
    const lanePreviewMessageId = lane.stream.messageId();
    const hadPreviewMessage =
      typeof previewMessageIdOverride === "number" || typeof lanePreviewMessageId === "number";
    if (stopBeforeEdit) {
      if (!hadPreviewMessage && context === "final") {
        // If debounce prevented the first preview, replace stale pending partial text
        // before final stop() flush sends the first visible preview.
        lane.stream.update(text);
      }
      await params.stopDraftLane(lane);
    }
    const previewMessageId =
      typeof previewMessageIdOverride === "number"
        ? previewMessageIdOverride
        : lane.stream.messageId();
    if (typeof previewMessageId !== "number") {
      return false;
    }
    const currentPreviewText = previewTextSnapshot ?? getLanePreviewText(lane);
    const shouldSkipRegressive =
      Boolean(currentPreviewText) &&
      currentPreviewText.startsWith(text) &&
      text.length < currentPreviewText.length &&
      (skipRegressive === "always" || hadPreviewMessage);
    if (shouldSkipRegressive) {
      params.markDelivered();
      return true;
    }
    try {
      await params.editPreview({
        laneName,
        messageId: previewMessageId,
        text,
        previewButtons,
        context,
      });
      if (updateLaneSnapshot) {
        lane.lastPartialText = text;
      }
      params.markDelivered();
      return true;
    } catch (err) {
      params.log(
        `telegram: ${laneName} preview ${context} edit failed; falling back to standard send (${String(err)})`,
      );
      return false;
    }
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
    try {
      await params.deletePreviewMessage(archivedPreview.messageId);
    } catch (err) {
      params.log(
        `telegram: archived answer preview cleanup failed (${archivedPreview.messageId}): ${String(err)}`,
      );
    }
    const delivered = await params.sendPayload(params.applyTextToPayload(payload, text));
    return delivered ? "sent" : "skipped";
  };

  return async ({
    laneName,
    text,
    payload,
    infoKind,
    previewButtons,
    allowPreviewUpdateForNonFinal = false,
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
      if (canEditViaPreview && !params.finalizedPreviewByLane[laneName]) {
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
