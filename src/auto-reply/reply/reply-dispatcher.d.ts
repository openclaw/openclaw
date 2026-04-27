import type { TypingCallbacks } from "../../channels/typing.js";
import type { HumanDelayConfig } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { type SilentReplyConversationType } from "../../shared/silent-reply-policy.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { type NormalizeReplySkipReason } from "./normalize-reply.js";
import type { ReplyDispatchKind, ReplyDispatcher } from "./reply-dispatcher.types.js";
import type { ResponsePrefixContext } from "./response-prefix-template.js";
export type { ReplyDispatchKind, ReplyDispatcher } from "./reply-dispatcher.types.js";
type ReplyDispatchErrorHandler = (err: unknown, info: {
    kind: ReplyDispatchKind;
}) => void;
type ReplyDispatchSkipHandler = (payload: ReplyPayload, info: {
    kind: ReplyDispatchKind;
    reason: NormalizeReplySkipReason;
}) => void;
type ReplyDispatchDeliverer = (payload: ReplyPayload, info: {
    kind: ReplyDispatchKind;
}) => Promise<void>;
export type ReplyDispatchBeforeDeliver = (payload: ReplyPayload, info: {
    kind: ReplyDispatchKind;
}) => Promise<ReplyPayload | null> | ReplyPayload | null;
export type ReplyDispatcherOptions = {
    deliver: ReplyDispatchDeliverer;
    silentReplyContext?: {
        cfg?: OpenClawConfig;
        sessionKey?: string;
        surface?: string;
        conversationType?: SilentReplyConversationType;
    };
    responsePrefix?: string;
    transformReplyPayload?: (payload: ReplyPayload) => ReplyPayload | null;
    /** Static context for response prefix template interpolation. */
    responsePrefixContext?: ResponsePrefixContext;
    /** Dynamic context provider for response prefix template interpolation.
     * Called at normalization time, after model selection is complete. */
    responsePrefixContextProvider?: () => ResponsePrefixContext;
    onHeartbeatStrip?: () => void;
    onIdle?: () => void;
    onError?: ReplyDispatchErrorHandler;
    onSkip?: ReplyDispatchSkipHandler;
    /** Human-like delay between block replies for natural rhythm. */
    humanDelay?: HumanDelayConfig;
    beforeDeliver?: ReplyDispatchBeforeDeliver;
};
export type ReplyDispatcherWithTypingOptions = Omit<ReplyDispatcherOptions, "onIdle"> & {
    typingCallbacks?: TypingCallbacks;
    onReplyStart?: () => Promise<void> | void;
    onIdle?: () => void;
    /** Called when the typing controller is cleaned up (e.g., on NO_REPLY). */
    onCleanup?: () => void;
};
type ReplyDispatcherWithTypingResult = {
    dispatcher: ReplyDispatcher;
    replyOptions: Pick<GetReplyOptions, "onReplyStart" | "onTypingController" | "onTypingCleanup">;
    markDispatchIdle: () => void;
    /** Signal that the model run is complete so the typing controller can stop. */
    markRunComplete: () => void;
};
export declare function createReplyDispatcher(options: ReplyDispatcherOptions): ReplyDispatcher;
export declare function createReplyDispatcherWithTyping(options: ReplyDispatcherWithTypingOptions): ReplyDispatcherWithTypingResult;
