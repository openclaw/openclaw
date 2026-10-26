import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { MISSING_REPLY_NOTICE_TEXT } from "../../agents/reply-completion.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { createDispatcher, emptyConfig } from "./dispatch-from-config.shared.test-harness.js";
import * as dispatch from "./dispatch-from-config.test-support.js";
import { createHandleInlineActionsInput } from "./get-reply-inline-actions.input.test-support.js";
import { handleInlineActions } from "./get-reply-inline-actions.js";
import { buildTestCtx } from "./test-ctx.js";
import { createMockTypingController } from "./test-helpers.js";

beforeAll(dispatch.globalBeforeAll0);
beforeEach(() => {
  dispatch.describe0BeforeEach0();
  dispatch.setNoAbort();
});

it.each([
  { name: "cutoff message ID", message: { MessageSid: "42" }, cancelled: true },
  { name: "older timestamp", message: { Timestamp: 999 }, cancelled: true },
  { name: "newer message ID", message: { MessageSid: "43" }, cancelled: false },
  { name: "newer timestamp", message: { Timestamp: 1001 }, cancelled: false },
])("settles $name without waiving a newer missing reply", async ({ message, cancelled }) => {
  const sessionKey = "agent:main:discord:direct:abort-cutoff";
  const sessionEntry: SessionEntry = {
    sessionId: "cutoff-session",
    updatedAt: 0,
    abortCutoffMessageSid: "42",
    abortCutoffTimestamp: 1000,
    abortedLastRun: true,
  };
  const typing = createMockTypingController();
  const dispatcher = createDispatcher();
  const continueTurn = vi.fn(async () => undefined);
  const ctx = buildTestCtx({
    Provider: "discord",
    Surface: "discord",
    SessionKey: sessionKey,
    Body: "queued input",
    CommandBody: "queued input",
    ...message,
  });
  // Exercise the production inline owner with dispatch's actual options/state,
  // then let the real finalizer decide whether a fallback is owed.
  const result = await dispatch.dispatchReplyFromConfig({
    ctx,
    cfg: emptyConfig,
    dispatcher,
    replyResolver: async (inbound, opts) => {
      const inline = await handleInlineActions(
        createHandleInlineActionsInput({
          ctx: inbound,
          typing,
          cleanedBody: "queued input",
          command: {
            surface: "discord",
            channel: "discord",
            channelId: "discord",
            abortKey: sessionKey,
            from: undefined,
            to: undefined,
          },
          overrides: {
            cfg: emptyConfig,
            sessionKey,
            sessionEntry,
            sessionStore: { [sessionKey]: sessionEntry },
            workspaceDir: "/unused",
            opts,
            model: "test-model",
            abortedLastRun: true,
          },
        }),
      );
      return inline.kind === "reply" ? inline.reply : continueTurn();
    },
  });

  expect(continueTurn).toHaveBeenCalledTimes(cancelled ? 0 : 1);
  expect(result.deliberateSilentTerminalReply).toBe(cancelled ? true : undefined);
  expect(result.noVisibleReplyFallbackDelivered).toBe(cancelled ? undefined : true);
  if (cancelled) {
    expect(typing.cleanup).toHaveBeenCalledOnce();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(sessionEntry.abortCutoffMessageSid).toBe("42");
  } else {
    expect(dispatcher.sendFinalReply).toHaveBeenCalledExactlyOnceWith({
      text: MISSING_REPLY_NOTICE_TEXT,
      isError: true,
      isStatusNotice: true,
    });
    expect(sessionEntry.abortCutoffMessageSid).toBeUndefined();
    expect(sessionEntry.abortCutoffTimestamp).toBeUndefined();
  }
});
