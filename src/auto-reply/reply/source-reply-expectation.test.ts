import { describe, expect, it } from "vitest";
import { resolveReplyCompletion } from "../../agents/reply-completion.js";
import { resolveInboundMentionDecision } from "../../channels/mention-gating.js";
import type { MsgContext } from "../templating.js";
import { resolveSourceReplyExpectation } from "./source-reply-delivery-mode.js";

const cfg = { surfaces: { slack: { silentReply: { group: "allow" as const } } } };

function participantContext(
  kind: "bot_thread_participant" | "reply_to_bot" = "bot_thread_participant",
): MsgContext {
  const admission = resolveInboundMentionDecision({
    facts: {
      canDetectMention: true,
      wasMentioned: false,
      hasAnyMention: false,
      implicitMentionKinds: [kind],
    },
    policy: {
      isGroup: true,
      requireMention: true,
      allowTextCommands: false,
      hasControlCommand: false,
      commandAuthorized: false,
      implicitMentions: { replyToBot: true, threadParticipation: true },
    },
  });
  expect(admission.shouldSkip).toBe(false);
  expect(admission.effectiveWasMentioned).toBe(true);
  return {
    ChatType: "channel",
    Provider: "slack",
    Surface: "slack",
    InboundEventKind: "user_request",
    WasMentioned: admission.effectiveWasMentioned,
    MentionSource: "implicit_thread",
  };
}

describe("participating group reply expectation", () => {
  it.each(["bot_thread_participant", "reply_to_bot"] as const)(
    "admits %s without turning optional silence into missing output",
    (kind) => {
      const expectation = resolveSourceReplyExpectation({ ctx: participantContext(kind), cfg });
      expect(expectation).toBe("optional");
      expect(resolveReplyCompletion(expectation, "empty").outcome).toBe("silent");
      expect(resolveReplyCompletion(expectation, "ready").outcome).toBe("ready");
    },
  );

  it.each(["explicit_bot", "subteam", "mention_pattern", "command_bypass"] as const)(
    "still requires a reply to %s",
    (MentionSource) => {
      const ctx = { ...participantContext(), MentionSource };
      const expectation = resolveSourceReplyExpectation({ ctx, cfg });
      expect(expectation).toBe("required");
      expect(resolveReplyCompletion(expectation, "empty").outcome).toBe("missing");
    },
  );

  it("preserves required replies when mention provenance is unavailable", () => {
    const ctx = participantContext();
    delete ctx.MentionSource;
    expect(resolveSourceReplyExpectation({ ctx, cfg })).toBe("required");
  });

  it("respects a disallowed or default group-silence policy", () => {
    expect(resolveSourceReplyExpectation({ ctx: participantContext(), cfg: {} })).toBe("required");
    expect(
      resolveSourceReplyExpectation({
        ctx: participantContext(),
        cfg: { surfaces: { slack: { silentReply: { group: "disallow" } } } },
      }),
    ).toBe("required");
  });

  it("requires direct replies even with stale implicit-thread facts", () => {
    const ctx = { ...participantContext(), ChatType: "direct" };
    expect(resolveSourceReplyExpectation({ ctx, cfg })).toBe("required");
  });

  it("requires explicit commands even with stale implicit-thread facts", () => {
    const ctx = { ...participantContext(), CommandSource: "native" as const };
    expect(resolveSourceReplyExpectation({ ctx, cfg })).toBe("required");
  });
});
