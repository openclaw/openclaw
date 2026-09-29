/**
 * Runtime SDK subpath for interactive replies and message presentation helpers.
 */
import { reduceLegacyInteractiveReply } from "../interactive/payload.js";

export {
  adaptMessagePresentationForChannel,
  applyPresentationActionLimits,
  presentationPageSize,
} from "../channels/plugins/outbound/presentation-limits.js";

/** @deprecated Use MessagePresentation helpers for new rendering paths. */
export const reduceInteractiveReply = reduceLegacyInteractiveReply;
export type {
  InteractiveButtonStyle,
  InteractiveReply,
  InteractiveReplyBlock,
  InteractiveReplyButton,
  InteractiveReplyOption,
  LegacyInteractiveReply,
  LegacyInteractiveReplyBlock,
  LegacyInteractiveReplyButton,
  LegacyInteractiveReplyOption,
  LegacyInteractiveReplySelectBlock,
  LegacyInteractiveReplyTextBlock,
  MessagePresentation,
  MessagePresentationAction,
  MessagePresentationBlock,
  MessagePresentationButton,
  MessagePresentationButtonStyle,
  MessagePresentationButtonsBlock,
  MessagePresentationChartBlock,
  MessagePresentationChartSegment,
  MessagePresentationChartSeries,
  MessagePresentationContextBlock,
  MessagePresentationDividerBlock,
  MessagePresentationInteractiveBlock,
  MessagePresentationOption,
  MessagePresentationSelectBlock,
  MessagePresentationTableBlock,
  MessagePresentationTableCell,
  MessagePresentationTextBlock,
  MessagePresentationTone,
  ModelPickerAction,
  ReplyPayloadDelivery,
  ReplyPayloadDeliveryPin,
} from "../interactive/payload.js";
export type { ModelPickerCapabilityProfile } from "../model-picker/capabilities.js";
export {
  hasInteractiveReplyBlocks,
  hasLegacyInteractiveReplyBlocks,
  hasMessagePresentationBlocks,
  hasReplyChannelData,
  hasReplyContent,
  interactiveReplyToPresentation,
  legacyInteractiveReplyToPresentation,
  isMessagePresentationInteractiveBlock,
  normalizeMessagePresentation,
  normalizeInteractiveReply,
  normalizeLegacyInteractiveReply,
  presentationToInteractiveControlsReply,
  presentationToInteractiveReply,
  renderMessagePresentationChartFallbackText,
  renderMessagePresentationFallbackText,
  renderMessagePresentationTableFallbackText,
  resolveMessagePresentationActionValue,
  resolveMessagePresentationButtonAction,
  resolveMessagePresentationControlValue,
  resolveMessagePresentationOptionAction,
  resolveInteractiveTextFallback,
  reduceLegacyInteractiveReply,
  resolveLegacyInteractiveTextFallback,
} from "../interactive/payload.js";
export { renderPresentationForDelivery } from "../channels/plugins/outbound/presentation-delivery.js";
