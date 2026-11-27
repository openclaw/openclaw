import { isAgentRunRestartAbortReason } from "../agents/run-termination.js";
import type { PreparedAgentRunStart } from "../auto-reply/get-reply-options.types.js";
import type {
  DispatchReplyWithBufferedBlockDispatcher as CoreBufferedDispatcher,
  DispatchReplyWithDispatcher as CoreDispatcher,
} from "../auto-reply/reply/provider-dispatcher.types.js";
import {
  dispatchReplyWithBufferedBlockDispatcher as dispatchBuffered,
  dispatchReplyWithDispatcher as dispatch,
} from "../plugins/legacy-sdk-reply-dispatch.js";
import type { PublicReplyParams } from "./reply-options.js";
/**
 * Runtime SDK subpath for lazy reply dispatch and inbound-context helpers.
 */
export { resolveChunkMode } from "../auto-reply/chunk.js";
export { generateConversationLabel } from "../auto-reply/reply/conversation-label-generator.js";
export { finalizeInboundContextForSdk as finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
export type { CommandTurnContext } from "../auto-reply/command-turn-context.js";

export type DispatchReplyWithBufferedBlockDispatcher = (
  params: PublicReplyParams<Parameters<CoreBufferedDispatcher>[0]>,
) => ReturnType<CoreBufferedDispatcher>;
export type DispatchReplyWithDispatcher = (
  params: PublicReplyParams<Parameters<CoreDispatcher>[0]>,
) => ReturnType<CoreDispatcher>;
export type { ReplyPayload } from "./reply-payload.js";

/** Whether Gateway restart recovery owns this interrupted reply. */
export async function hasReplyRestartResume(
  error: unknown,
  target: PreparedAgentRunStart["transcriptStart"] | undefined,
  runId: string | undefined,
): Promise<boolean> {
  if (!target || !isAgentRunRestartAbortReason(error)) {
    return false;
  }
  try {
    const { hasSessionRestartResume } =
      await import("../config/sessions/session-restart-recovery.js");
    return await hasSessionRestartResume(target, runId);
  } catch {
    // An unreadable marker cannot establish recovery custody.
    return false;
  }
}

/** Dispatches a reply with buffered block support through its exact host's lazy runtime. */
export const dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcher =
  dispatchBuffered;

/** Dispatches a reply through its exact host's lazy provider runtime. */
export const dispatchReplyWithDispatcher: DispatchReplyWithDispatcher = dispatch;
