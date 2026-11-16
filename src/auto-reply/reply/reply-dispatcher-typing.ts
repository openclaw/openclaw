import type { TypingCallbacks } from "../../channels/typing.js";
import { withReplyDispatchTyping } from "../../plugins/reply-dispatch-typing.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import type { ReplyDispatchRuntimeInfo, ReplyDispatcherOptions } from "./reply-dispatcher.types.js";
import { runVisibleDeliveryTypingStart } from "./typing-visible-delivery.js";
import type { TypingController } from "./typing.js";

export type ReplyDispatcherWithTypingOptions = Omit<ReplyDispatcherOptions, "onIdle"> & {
  typingCallbacks?: TypingCallbacks;
  typingStartPolicy?: GetReplyOptions["typingStartPolicy"];
  suppressTyping?: boolean;
  onReplyStart?: () => Promise<void> | void;
  onIdle?: () => Promise<void> | void;
  onSettled?: () => unknown;
  onFreshSettledDelivery?: () => unknown;
  /** Called when the typing controller is cleaned up (e.g., on NO_REPLY). */
  onCleanup?: () => void;
};

type ReplyDispatcherTypingLifecycle = {
  dispatcherOptions: ReplyDispatcherOptions;
  replyOptions: Pick<GetReplyOptions, "onReplyStart" | "onTypingController" | "onTypingCleanup">;
  markDispatchIdle: () => void;
  /** Signal that the model run is complete so the typing controller can stop. */
  markRunComplete: () => void;
};

export function createReplyDispatcherTypingLifecycle(
  options: ReplyDispatcherWithTypingOptions,
): ReplyDispatcherTypingLifecycle {
  const {
    typingCallbacks,
    typingStartPolicy,
    suppressTyping,
    onReplyStart,
    onIdle,
    onSettled,
    onFreshSettledDelivery: _onFreshSettledDelivery,
    onCleanup,
    ...dispatcherOptions
  } = options;
  const resolvedOnReplyStart = onReplyStart ?? typingCallbacks?.onReplyStart;
  const resolvedOnIdle = onIdle ?? typingCallbacks?.onIdle;
  const resolvedOnCleanup = onCleanup ?? typingCallbacks?.onCleanup;
  let typingController: TypingController | undefined;
  let startedVisibleDeliveryTyping = false;
  // The channel deliverer owns visible-send decisions; this hook lets it start
  // typing after hidden/suppressed payloads have already been filtered out.
  const startVisibleDeliveryTyping = async () => {
    if (
      typingStartPolicy !== "visible_delivery" ||
      suppressTyping === true ||
      startedVisibleDeliveryTyping
    ) {
      return;
    }
    const visibleDeliveryTypingController = typingController;
    startedVisibleDeliveryTyping = true;
    if (visibleDeliveryTypingController) {
      await runVisibleDeliveryTypingStart({
        start: () => visibleDeliveryTypingController.startTypingForVisibleDelivery(),
        onTimeout: () => visibleDeliveryTypingController.cleanup(),
      });
      return;
    }
    await runVisibleDeliveryTypingStart({
      start: () => resolvedOnReplyStart?.(),
      onTimeout: () => resolvedOnCleanup?.(),
      onLateCompletion: () => resolvedOnCleanup?.(),
    });
  };
  const withVisibleDeliveryTyping = (info: ReplyDispatchRuntimeInfo) =>
    typingStartPolicy === "visible_delivery" ? { ...info, startVisibleDeliveryTyping } : info;
  const deliverPrepared = dispatcherOptions.deliverPrepared;
  const configuredDispatcherOptions: ReplyDispatcherOptions = {
    ...dispatcherOptions,
    deliver: (payload, info) => dispatcherOptions.deliver(payload, withVisibleDeliveryTyping(info)),
    deliverPrepared: deliverPrepared
      ? (plan, info) => deliverPrepared(plan, withVisibleDeliveryTyping(info))
      : undefined,
    onIdle: async () => {
      typingController?.markDispatchIdle();
      const idle = resolvedOnIdle?.();
      if (idle) {
        await Promise.resolve(idle);
      }
      await onSettled?.();
    },
  };

  return {
    dispatcherOptions: configuredDispatcherOptions,
    replyOptions: withReplyDispatchTyping(
      {
        onReplyStart: resolvedOnReplyStart,
        onTypingCleanup: resolvedOnCleanup,
        onTypingController: (typing: TypingController) => {
          typingController = typing;
        },
      },
      startVisibleDeliveryTyping,
    ),
    markDispatchIdle: () => {
      typingController?.markDispatchIdle();
      resolvedOnIdle?.();
    },
    markRunComplete: () => {
      typingController?.markRunComplete();
    },
  };
}
