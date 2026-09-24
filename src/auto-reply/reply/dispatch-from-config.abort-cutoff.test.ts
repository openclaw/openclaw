// Stopped queued input must not become a missing-reply warning at finalization.
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { TemplateContext } from "../templating.js";
import { buildNoVisibleReplyFallbackText } from "./dispatch-from-config.payloads.js";
import { createDispatcher, emptyConfig } from "./dispatch-from-config.shared.test-harness.js";
import {
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  setNoAbort,
} from "./dispatch-from-config.test-harness.js";
import { clearInlineDirectives } from "./get-reply-directives-utils.js";
import { handleInlineActions } from "./get-reply-inline-actions.js";
import { buildTestCtx } from "./test-ctx.js";
import type { TypingController } from "./typing.js";

beforeAll(globalBeforeAll0);
beforeEach(() => {
  describe0BeforeEach0();
  setNoAbort();
});

it.each([
  { name: "older message ID", message: { MessageSid: "41" }, cancelled: true },
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
  const sessionStore = { [sessionKey]: sessionEntry };
  const typing: TypingController = {
    onReplyStart: async () => {},
    startTypingLoop: async () => {},
    startTypingOnText: async () => {},
    refreshTypingTtl: () => {},
    isActive: () => false,
    markRunComplete: () => {},
    markDispatchIdle: () => {},
    cleanup: vi.fn(),
  };
  const dispatcher = createDispatcher();
  const continueTurn = vi.fn(async () => undefined);
  const ctx = buildTestCtx({
    Provider: "discord",
    Surface: "discord",
    ChatType: "direct",
    SessionKey: sessionKey,
    Body: "queued input",
    CommandBody: "queued input",
    ...message,
  });
  // Exercise the production inline owner with dispatch's actual options/state,
  // then let the real finalizer decide whether a fallback is owed.
  const result = await dispatchReplyFromConfig({
    ctx,
    cfg: emptyConfig,
    dispatcher,
    replyResolver: async (inbound, opts) => {
      const inline = await handleInlineActions({
        ctx: inbound,
        sessionCtx: inbound as TemplateContext,
        cfg: emptyConfig,
        agentId: "main",
        sessionKey,
        sessionEntry,
        sessionStore,
        workspaceDir: "/unused",
        isGroup: false,
        opts,
        typing,
        allowTextCommands: false,
        inlineStatusRequested: false,
        command: {
          surface: "discord",
          channel: "discord",
          channelId: "discord",
          ownerList: [],
          senderIsOwner: false,
          isAuthorizedSender: false,
          abortKey: sessionKey,
          rawBodyNormalized: "queued input",
          commandBodyNormalized: "queued input",
        },
        directives: clearInlineDirectives("queued input"),
        cleanedBody: "queued input",
        elevatedEnabled: false,
        elevatedAllowed: false,
        elevatedFailures: [],
        defaultActivation: () => "always",
        resolveModelLevels: async () => ({
          resolvedThinkLevel: undefined,
          resolvedReasoningLevel: "off",
        }),
        resolvedVerboseLevel: undefined,
        resolvedElevatedLevel: "off",
        resolveDefaultThinkingLevel: async () => "off",
        provider: "openai",
        model: "test-model",
        contextTokens: 0,
        abortedLastRun: true,
        sessionScope: "per-sender",
      });
      return inline.kind === "reply" ? inline.reply : continueTurn();
    },
  });

  if (cancelled) {
    expect(continueTurn).not.toHaveBeenCalled();
    expect(typing.cleanup).toHaveBeenCalledOnce();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(result.deliberateSilentTerminalReply).toBe(true);
    expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
    expect(sessionEntry.abortCutoffMessageSid).toBe("42");
  } else {
    expect(continueTurn).toHaveBeenCalledOnce();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledExactlyOnceWith({
      text: buildNoVisibleReplyFallbackText(),
    });
    expect(result.noVisibleReplyFallbackDelivered).toBe(true);
    expect(result.deliberateSilentTerminalReply).toBeUndefined();
    expect(sessionEntry.abortCutoffMessageSid).toBeUndefined();
    expect(sessionEntry.abortCutoffTimestamp).toBeUndefined();
  }
});
