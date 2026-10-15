import type { TypingCallbacks } from "../../channels/typing.js";
import type { TypingController } from "./typing.js";

/** Bind an explicitly opted-in channel audience and its transport failure owner. */
export function bindReplyTypingChannelCallbacks(
  typing: TypingController,
  callbacks: TypingCallbacks | undefined,
): void {
  typing.setBackgroundWorkPause?.(
    callbacks?.onBackgroundWorkPause,
    callbacks?.backgroundWorkAudienceKey,
  );
  callbacks?.setBackgroundWorkFailureHandler?.(typing.cleanup);
}
