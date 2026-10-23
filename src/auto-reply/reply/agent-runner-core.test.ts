import { expect, it, onTestFinished } from "vitest";
import { resolveReplyCompletion } from "../../agents/reply-completion.js";
import { createRestartRecoveryClaimChangedError } from "../../infra/agent-lifecycle-error.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { resolveFallbackTransition } from "../fallback-state.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import {
  buildSilentFallbackFailurePayload,
  handleReplyAgentRunError,
  resolveReplyRunDeliveryContext,
} from "./agent-runner-core.js";

function runError(
  error: unknown,
  overrides: Partial<Parameters<typeof handleReplyAgentRunError>[1]> = {},
  restart = false,
) {
  const replyOperation = createReplyOperation({
    sessionKey: "agent:main:core-error",
    sessionId: "core-error",
    resetTriggered: false,
  });
  if (restart) {
    replyOperation.abortForRestart();
  }
  onTestFinished(() => replyOperation.complete());
  return handleReplyAgentRunError(error, {
    resolveVisibleReplyDelivery: async () => false,

    replyExpectation: "required",
    isRestartRecoveryArmed: async () => false,
    replyOperation,
    resolvedVerboseLevel: "off",
    returnWithQueuedFollowupDrain: (value) => value,
    sessionCtx: {},
    ...overrides,
  });
}

it.each([{ armed: false }, { armed: true }, { claimChanged: true }])(
  "resolves restart recovery before choosing guidance: %j",
  async ({ armed, claimChanged }) => {
    const reply = await runError(
      claimChanged ? createRestartRecoveryClaimChangedError() : new Error("restart"),
      { isRestartRecoveryArmed: async () => armed ?? false },
      !claimChanged,
    );
    const expected = claimChanged
      ? "⚠️ This conversation changed before your message could start. Check the latest messages, then try again if needed."
      : armed
        ? undefined
        : "⚠️ Gateway is restarting. Please wait a few seconds and try again.";
    expect(reply?.text).toBe(expected);
    if (claimChanged) {
      expect(reply?.isError).toBe(true);
    }
  },
);

it.each([false, true])(
  "keeps setup failures retryable only before durable acceptance (%s)",
  async (accepted) => {
    const failure = new Error("ENOSPC: turn preparation failed");
    const reply = runError(failure, { userTurnAccepted: accepted });
    if (accepted) {
      await expect(reply).resolves.toMatchObject({
        isError: true,
        text: expect.not.stringContaining(SILENT_REPLY_TOKEN),
      });
    } else {
      await expect(reply).rejects.toBe(failure);
    }
  },
);

it.each([
  { name: "string message topic", messageThreadId: "99", threadId: "99" },
  { name: "session identity fallback", threadId: "12345:99" },
])("preserves the $name", ({ messageThreadId, threadId }) => {
  const sessionKey = "agent:main:telegram:direct:12345:thread:12345:99";
  expect(
    resolveReplyRunDeliveryContext({
      cfg: {},
      sessionCtx: {
        Provider: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:12345",
        AccountId: "work",
        MessageThreadId: messageThreadId,
        SessionKey: sessionKey,
      },
      sessionKey,
    }),
  ).toEqual({
    channel: "telegram",
    to: "telegram:12345",
    accountId: "work",
    threadId,
  });
});
const transition = resolveFallbackTransition({
  selectedProvider: "openai",
  selectedModel: "primary-model",
  activeProvider: "anthropic",
  activeModel: "fallback-model",
  attempts: [],
});
function fallbackPayload(fallbackFailureKnown: boolean) {
  return buildSilentFallbackFailurePayload({
    fallbackTransition: transition,
    fallbackFailureKnown,
    fallbackAttempts: [],
    cfg: fallbackFailureKnown ? { agents: { defaults: { silentReply: { group: "allow" } } } } : {},
    completion: resolveReplyCompletion("required", "empty"),
  });
}

it("surfaces both model identities when a required fallback reply is missing", () => {
  const payload = fallbackPayload(true);

  expect(payload?.isError).toBe(true);
  expect(payload?.text).toContain(transition.selectedModelRef);
  expect(payload?.text).toContain(transition.activeModelRef);
  expect(getReplyPayloadMetadata(payload ?? {})?.deliverDespiteSourceReplySuppression).toBe(true);
});

it("requires an active failed fallback", () => {
  expect(fallbackPayload(false)).toBeUndefined();
});
