import { describe, expect, it } from "vitest";
import { resolveReplyCompletion } from "../../agents/reply-completion.js";
import { createRestartRecoveryClaimChangedError } from "../../infra/agent-lifecycle-error.js";
import { resolveFallbackTransition } from "../fallback-state.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { TemplateContext } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import {
  buildSilentFallbackFailurePayload,
  handleReplyAgentRunError,
  resolveReplyRunDeliveryContext,
} from "./agent-runner-core.js";
import { createReplyOperation } from "./reply-run-registry.js";

it.each([false, true])(
  "awaits restart recovery before choosing the error reply (%s)",
  async (armed) => {
    const replyOperation = createReplyOperation({
      sessionKey: `agent:main:restart-read-${armed}`,
      sessionId: `restart-read-${armed}`,
      turnKind: "visible",
      resetTriggered: false,
    });
    replyOperation.abortForRestart();
    try {
      const reply = await handleReplyAgentRunError(new Error("restart"), {
        resolveVisibleReplyDelivery: async () => false,
        isHeartbeat: false,
        replyExpectation: "required",
        isRestartRecoveryArmed: async () => armed,
        replyOperation,
        resolvedVerboseLevel: "off",
        returnWithQueuedFollowupDrain: (value) => value,
        sessionCtx: {},
      });
      expect(reply?.text).toBe(
        armed
          ? SILENT_REPLY_TOKEN
          : "⚠️ Gateway is restarting. Please wait a few seconds and try again.",
      );
    } finally {
      replyOperation.complete();
    }
  },
);

it("renders restart recovery ownership changes as session guidance", async () => {
  const replyOperation = createReplyOperation({
    sessionKey: "agent:main:restart-claim-changed",
    sessionId: "restart-claim-changed",
    turnKind: "visible",
    resetTriggered: false,
  });
  try {
    const reply = await handleReplyAgentRunError(createRestartRecoveryClaimChangedError(), {
      resolveVisibleReplyDelivery: async () => false,
      isHeartbeat: false,
      replyExpectation: "required",
      isRestartRecoveryArmed: async () => false,
      replyOperation,
      resolvedVerboseLevel: "off",
      returnWithQueuedFollowupDrain: (value) => value,
      sessionCtx: {},
    });

    expect(reply?.text).toBe(
      "⚠️ This conversation changed before your message could start. Check the latest messages, then try again if needed.",
    );
    expect(reply?.text).not.toContain("restart recovery claim");
  } finally {
    replyOperation.complete();
  }
});

describe("resolveReplyRunDeliveryContext", () => {
  it.each([
    { name: "string message topic", messageThreadId: "99", threadId: "99" },
    { name: "session identity fallback", threadId: "12345:99" },
  ])("preserves the $name", ({ messageThreadId, threadId }) => {
    expect(
      resolveReplyRunDeliveryContext({
        cfg: {},
        sessionCtx: {
          Provider: "telegram",
          OriginatingChannel: "telegram",
          OriginatingTo: "telegram:12345",
          AccountId: "work",
          MessageThreadId: messageThreadId,
          SessionKey: "agent:main:telegram:direct:12345:thread:12345:99",
        } as TemplateContext,
        sessionKey: "agent:main:telegram:direct:12345:thread:12345:99",
      }),
    ).toEqual({
      channel: "telegram",
      to: "telegram:12345",
      accountId: "work",
      threadId,
    });
  });
});

describe("buildSilentFallbackFailurePayload", () => {
  const selected = { provider: "openai", model: "primary-model" };
  const other = { provider: "anthropic", model: "fallback-model" };
  const transition = resolveFallbackTransition({
    selectedProvider: selected.provider,
    selectedModel: selected.model,
    activeProvider: other.provider,
    activeModel: other.model,
    attempts: [],
  });
  const base = {
    fallbackTransition: transition,
    fallbackFailureKnown: true,
    fallbackAttempts: [],
    cfg: {},
    completion: resolveReplyCompletion("required", "empty"),
  };

  it("surfaces both model identities when a required fallback reply is missing", () => {
    const payload = buildSilentFallbackFailurePayload({
      ...base,
      cfg: { agents: { defaults: { silentReply: { group: "allow" } } } },
    });

    expect(payload?.isError).toBe(true);
    expect(payload?.text).toContain(transition.selectedModelRef);
    expect(payload?.text).toContain(transition.activeModelRef);
    expect(getReplyPayloadMetadata(payload ?? {})?.deliverDespiteSourceReplySuppression).toBe(true);
  });

  it.each([{ fallbackFailureKnown: false }])(
    "requires an active failed fallback: %j",
    (fallback) => {
      expect(buildSilentFallbackFailurePayload({ ...base, ...fallback })).toBeUndefined();
    },
  );
});
