import { describe, expect, it } from "vitest";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import {
  buildEmptyInteractiveReplyPayload,
  buildExternalRunFailureReply,
  resolveExternalRunFailureTextForConversation,
} from "./agent-runner-failure-reply.js";

const EMPTY_INTERACTIVE_REPLY_TEXT =
  "I finished the turn, but it did not produce a visible reply. Please try again, or start a new session if this keeps happening.";

describe("buildEmptyInteractiveReplyPayload", () => {
  const baseParams = {
    isInteractive: true,
    isMessageToolOnly: false,
    hasPendingContinuation: false,
    hasExplicitSilentReply: false,
    hasCommittedDelivery: false,
    sessionCtx: {
      Provider: "discord",
      Surface: "discord",
      ChatType: "group",
    },
  } as const;

  it("preserves the default silent policy in group conversations", () => {
    const payload = buildEmptyInteractiveReplyPayload(baseParams);

    expect(payload?.text).toBe(SILENT_REPLY_TOKEN);
    expect(payload?.isError).toBeUndefined();
  });

  it("surfaces the fallback when group silence is explicitly disallowed", () => {
    expect(
      buildEmptyInteractiveReplyPayload({
        ...baseParams,
        cfg: { agents: { defaults: { silentReply: { group: "disallow" } } } },
      }),
    ).toMatchObject({ text: EMPTY_INTERACTIVE_REPLY_TEXT, isError: true });
  });
});

describe("auth profile cooldown failures", () => {
  const cooldownMessage =
    'Auth profile "openai:user@example.com" is temporarily unavailable for openai/gpt-5.6-sol.';

  it("maps plain auth-cooldown errors to non-generic provider copy without the profile id", () => {
    const reply = buildExternalRunFailureReply(
      { message: cooldownMessage, error: new Error(cooldownMessage) },
      { includeAuthProfileId: false, includeDetails: false, isHeartbeat: false },
    );
    expect(reply.isGenericRunnerFailure).toBe(false);
    expect(reply.text).toContain("openai");
    expect(reply.text).not.toContain("user@example.com");
  });

  it("stays visible in group conversations instead of resolving to a silent reply", () => {
    const reply = buildExternalRunFailureReply(
      { message: cooldownMessage, error: new Error(cooldownMessage) },
      { includeAuthProfileId: false, includeDetails: false, isHeartbeat: false },
    );
    const resolved = resolveExternalRunFailureTextForConversation({
      text: reply.text,
      sessionCtx: {
        SessionKey: "agent:main:telegram:group:-100123:topic:1",
        Surface: "telegram",
        Provider: "telegram",
        ChatType: "group",
      },
      isGenericRunnerFailure: reply.isGenericRunnerFailure,
    });
    expect(resolved).not.toBe(SILENT_REPLY_TOKEN);
    expect(resolved).toContain("openai");
  });

  it("also matches provider-only cooldown messages from route auth", () => {
    const routeMessage =
      'Auth profile "openai:user@example.com" is temporarily unavailable for openai.';
    const reply = buildExternalRunFailureReply(
      { message: routeMessage, error: new Error(routeMessage) },
      { includeAuthProfileId: false, includeDetails: false, isHeartbeat: false },
    );
    expect(reply.isGenericRunnerFailure).toBe(false);
    expect(reply.text).toContain("openai");
  });
});
