import { describe, expect, it } from "vitest";
import {
  allowedImplicitMentionKindsFromConfig,
  type InboundMentionFacts,
  type InboundMentionPolicy,
  resolveBotThreadMentionPolicy,
  resolveInboundMentionDecision,
  type InboundImplicitMentionKind,
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
      {
        implicitMentionKinds: ["reply_to_bot", "quoted_bot", "bot_thread_participant", "native"],
      },
      {
        implicitMentions: {
          replyToBot: false,
          quotedBot: true,
          threadParticipation: false,
        },
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
  it.each<{
    name: string;
    isBotOwnedThread: boolean;
    requireMentionInBotThreads?: boolean;
    requireMention: boolean;
    implicitMentionKinds?: readonly InboundImplicitMentionKind[];
    wasMentioned?: boolean;
    commandAuthorized?: boolean;
    shouldSkip: boolean;
  }>([
    {
      name: "admits an unmentioned reply when mentions are disabled for owned threads",
      isBotOwnedThread: true,
      requireMentionInBotThreads: false,
      requireMention: true,
      shouldSkip: false,
    },

    {
      name: "preserves the existing requirement when the override is unset",
      isBotOwnedThread: true,
      requireMention: true,
      shouldSkip: true,
    },

    {
      name: "requires mentions in owned threads even when the ordinary gate is disabled",
      isBotOwnedThread: true,
      requireMentionInBotThreads: true,
      requireMention: false,
      implicitMentionKinds: ["reply_to_bot", "quoted_bot", "bot_thread_participant"],
      shouldSkip: true,
    },

    {
      name: "preserves authorized command bypass under the owned-thread requirement",
      isBotOwnedThread: true,
      requireMentionInBotThreads: true,
      requireMention: true,
      commandAuthorized: true,
      shouldSkip: false,
    },
  ])("$name", ({ wasMentioned = false, commandAuthorized = false, shouldSkip, ...input }) => {
    const threadPolicy = resolveBotThreadMentionPolicy(input);
    const decision = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned,
        implicitMentionKinds: threadPolicy.implicitMentionKinds,
      },
      policy: {
        isGroup: true,
        requireMention: threadPolicy.requireMention,
        allowTextCommands: true,
        hasControlCommand: commandAuthorized,
        commandAuthorized,
      },
    });
    expect(decision.shouldSkip).toBe(shouldSkip);
  });
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
