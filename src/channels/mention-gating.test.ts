import { describe, expect, it } from "vitest";
import {
  allowedImplicitMentionKindsFromConfig,
  type InboundMentionFacts,
  type InboundMentionPolicy,
  resolveBotThreadMentionPolicy,
  resolveInboundMentionDecision,
} from "./mention-gating.js";

function decide(facts: Partial<InboundMentionFacts>, policy: Partial<InboundMentionPolicy> = {}) {
  return resolveInboundMentionDecision({
    facts: { canDetectMention: true, wasMentioned: false, implicitMentionKinds: [], ...facts },
    policy: {
      isGroup: true,
      requireMention: true,
      allowTextCommands: true,
      hasControlCommand: false,
      commandAuthorized: false,
      ...policy,
    },
  });
}

describe("resolveInboundMentionDecision", () => {
  it("translates positive implicit mention config inside the evaluator", () => {
    const res = decide(
      { implicitMentionKinds: ["reply_to_bot", "quoted_bot", "bot_thread_participant", "native"] },
      {
        implicitMentions: { replyToBot: false, quotedBot: true, threadParticipation: false },
      },
    );
    expect(res.matchedImplicitMentionKinds).toEqual(["quoted_bot", "native"]);
  });

  it("keeps the flat call shape for compatibility", () => {
    const res = resolveInboundMentionDecision({
      isGroup: true,
      requireMention: true,
      canDetectMention: true,
      wasMentioned: false,
      implicitMentionKinds: ["reply_to_bot"],
      allowTextCommands: true,
      hasControlCommand: false,
      commandAuthorized: false,
    });
    expect(res.effectiveWasMentioned).toBe(true);
  });
});

describe("bot-owned thread mention policy", () => {
  it.each([
    ["disabled for owned threads", false, true, false, false],
    ["unset override", undefined, true, false, true],
    ["required despite ordinary gate", true, false, false, true],
    ["authorized command bypass", true, true, true, false],
  ] as const)(
    "%s",
    (_name, requireMentionInBotThreads, requireMention, commandAuthorized, skip) => {
      const threadPolicy = resolveBotThreadMentionPolicy({
        isBotOwnedThread: true,
        requireMentionInBotThreads,
        requireMention,
        implicitMentionKinds:
          requireMentionInBotThreads && !requireMention
            ? ["reply_to_bot", "quoted_bot", "bot_thread_participant"]
            : undefined,
      });
      expect(
        decide(
          { implicitMentionKinds: threadPolicy.implicitMentionKinds },
          {
            requireMention: threadPolicy.requireMention,
            hasControlCommand: commandAuthorized,
            commandAuthorized,
          },
        ).shouldSkip,
      ).toBe(skip);
    },
  );
});

describe("allowedImplicitMentionKindsFromConfig", () => {
  it("maps positive config flags to evaluator kinds while preserving native mentions", () => {
    expect(
      allowedImplicitMentionKindsFromConfig({
        replyToBot: true,
        quotedBot: false,
        threadParticipation: false,
      }),
    ).toEqual(["reply_to_bot", "native"]);
  });
});
