import { describe, expect, it } from "vitest";
import {
  allowedImplicitMentionKindsFromConfig,
  type InboundMentionFacts,
  type InboundMentionPolicy,
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
  it("blocks implicit mention kinds excluded by policy", () => {
    const res = decide(
      { implicitMentionKinds: ["reply_to_bot"] },
      { allowedImplicitMentionKinds: [] },
    );
    expect(res.implicitMention).toBe(false);
    expect(res.matchedImplicitMentionKinds).toStrictEqual([]);
    expect(res.effectiveWasMentioned).toBe(false);
    expect(res.shouldSkip).toBe(true);
  });

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

  it("keeps an explicit plugin allowlist ahead of implicit mention config", () => {
    const res = decide(
      {
        implicitMentionKinds: ["reply_to_bot", "bot_thread_participant"],
      },
      {
        implicitMentions: { replyToBot: false, threadParticipation: true },
        allowedImplicitMentionKinds: ["reply_to_bot"],
      },
    );
    expect(res.matchedImplicitMentionKinds).toEqual(["reply_to_bot"]);
    expect(res.implicitMention).toBe(true);
    expect(res.shouldSkip).toBe(false);
  });

  it("dedupes repeated implicit mention kinds", () => {
    const res = decide({ implicitMentionKinds: ["reply_to_bot", "reply_to_bot", "native"] });
    expect(res.matchedImplicitMentionKinds).toEqual(["reply_to_bot", "native"]);
    expect(res.implicitMention).toBe(true);
    expect(res.effectiveWasMentioned).toBe(true);
    expect(res.shouldSkip).toBe(false);
  });

  it("keeps command bypass behavior unchanged", () => {
    const res = decide(
      { hasAnyMention: false },
      { hasControlCommand: true, commandAuthorized: true },
    );
    expect(res.shouldBypassMention).toBe(true);
    expect(res.effectiveWasMentioned).toBe(true);
    expect(res.shouldSkip).toBe(false);
  });

  it("does not allow command bypass when some other mention is present", () => {
    const res = decide(
      { hasAnyMention: true },
      { hasControlCommand: true, commandAuthorized: true },
    );
    expect(res.shouldBypassMention).toBe(false);
    expect(res.effectiveWasMentioned).toBe(false);
    expect(res.shouldSkip).toBe(true);
  });

  it("does not allow command bypass outside groups", () => {
    const res = decide(
      {
        hasAnyMention: false,
      },
      {
        isGroup: false,
        hasControlCommand: true,
        commandAuthorized: true,
      },
    );
    expect(res.shouldBypassMention).toBe(false);
    expect(res.effectiveWasMentioned).toBe(false);
    expect(res.shouldSkip).toBe(true);
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

describe("unavailable mention detection", () => {
  it("does not skip when mention detection is unavailable", () => {
    const decision = decide({ canDetectMention: false });
    expect(decision.shouldSkip).toBe(false);
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

  it("keeps unset kinds allowed for shipped-behavior compatibility", () => {
    expect(allowedImplicitMentionKindsFromConfig({})).toEqual([
      "reply_to_bot",
      "quoted_bot",
      "bot_thread_participant",
      "native",
    ]);
  });
});
