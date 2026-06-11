// Mention gating tests cover channel mention requirements before inbound messages trigger agents.
import { describe, expect, it } from "vitest";
import {
  implicitMentionKindWhen,
  resolveInboundMentionDecision,
  resolveMentionGating,
  resolveMentionGatingWithBypass,
} from "./mention-gating.js";
import { resolveMentionPatternPolicy } from "./mention-pattern-policy.js";

describe("resolveMentionGating", () => {
  it("combines explicit, implicit, and bypass mentions", () => {
    const res = resolveMentionGating({
      requireMention: true,
      canDetectMention: true,
      wasMentioned: false,
      implicitMention: true,
      shouldBypassMention: false,
    });
    expect(res.effectiveWasMentioned).toBe(true);
    expect(res.shouldSkip).toBe(false);
  });

  it("skips when mention required and none detected", () => {
    const res = resolveMentionGating({
      requireMention: true,
      canDetectMention: true,
      wasMentioned: false,
      implicitMention: false,
      shouldBypassMention: false,
    });
    expect(res.effectiveWasMentioned).toBe(false);
    expect(res.shouldSkip).toBe(true);
  });
});

describe("resolveMentionGatingWithBypass", () => {
  it.each([
    {
      name: "enables bypass when control commands are authorized",
      commandAuthorized: true,
      shouldBypassMention: true,
      shouldSkip: false,
    },
    {
      name: "does not bypass when control commands are not authorized",
      commandAuthorized: false,
      shouldBypassMention: false,
      shouldSkip: true,
    },
  ])("$name", ({ commandAuthorized, shouldBypassMention, shouldSkip }) => {
    const res = resolveMentionGatingWithBypass({
      isGroup: true,
      requireMention: true,
      canDetectMention: true,
      wasMentioned: false,
      hasAnyMention: false,
      allowTextCommands: true,
      hasControlCommand: true,
      commandAuthorized,
    });
    expect(res.shouldBypassMention).toBe(shouldBypassMention);
    expect(res.shouldSkip).toBe(shouldSkip);
  });
});

describe("resolveMentionPatternPolicy", () => {
  it("keeps regex mention patterns enabled when no provider policy is configured", () => {
    const res = resolveMentionPatternPolicy({
      provider: "matrix",
      conversationId: "!room:example.test",
    });
    expect(res.enabled).toBe(true);
  });

  it("keeps regex mention patterns enabled for an empty provider policy", () => {
    const res = resolveMentionPatternPolicy({
      providerPolicy: {},
      conversationId: "!room:example.test",
    });
    expect(res.enabled).toBe(true);
  });

  it("requires allowIn to match when provider policy explicitly uses allow mode", () => {
    const res = resolveMentionPatternPolicy({
      providerPolicy: {
        mode: "allow",
        allowIn: ["!the-donghouse:example.test"],
      },
      conversationId: "!bottoy:example.test",
    });
    expect(res.allowMatched).toBe(false);
    expect(res.enabled).toBe(false);
  });

  it("enables explicit allow mode when allowIn matches", () => {
    const res = resolveMentionPatternPolicy({
      providerPolicy: {
        mode: "allow",
        allowIn: ["!the-donghouse:example.test"],
      },
      conversationId: "!the-donghouse:example.test",
    });
    expect(res.allowMatched).toBe(true);
    expect(res.enabled).toBe(true);
  });

  it("keeps denyIn precedence over explicit allow mode matches", () => {
    const res = resolveMentionPatternPolicy({
      providerPolicy: {
        mode: "allow",
        allowIn: ["!the-donghouse:example.test"],
        denyIn: ["!the-donghouse:example.test"],
      },
      conversationId: "!the-donghouse:example.test",
    });
    expect(res.allowMatched).toBe(true);
    expect(res.denyMatched).toBe(true);
    expect(res.enabled).toBe(false);
  });

  it("resolves provider policy from OpenClaw config", () => {
    const res = resolveMentionPatternPolicy({
      cfg: {
        channels: {
          matrix: {
            mentionPatterns: {
              mode: "allow",
              allowIn: ["!the-donghouse:example.test", "!scoob-admin:example.test"],
            },
          },
        },
      },
      provider: "matrix",
      conversationId: "!bottoy:example.test",
    });
    expect(res.enabled).toBe(false);
  });
});

describe("resolveInboundMentionDecision", () => {
  it("allows matching implicit mention kinds by default", () => {
    const res = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: false,
        implicitMentionKinds: ["reply_to_bot"],
      },
      policy: {
        isGroup: true,
        requireMention: true,
        allowTextCommands: true,
        hasControlCommand: false,
        commandAuthorized: false,
      },
    });
    expect(res.implicitMention).toBe(true);
    expect(res.matchedImplicitMentionKinds).toEqual(["reply_to_bot"]);
    expect(res.effectiveWasMentioned).toBe(true);
    expect(res.shouldSkip).toBe(false);
  });

  it("filters implicit mention kinds through the allowlist", () => {
    const res = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: false,
        implicitMentionKinds: ["reply_to_bot", "bot_thread_participant"],
      },
      policy: {
        isGroup: true,
        requireMention: true,
        allowedImplicitMentionKinds: ["reply_to_bot"],
        allowTextCommands: true,
        hasControlCommand: false,
        commandAuthorized: false,
      },
    });
    expect(res.implicitMention).toBe(true);
    expect(res.matchedImplicitMentionKinds).toEqual(["reply_to_bot"]);
    expect(res.shouldSkip).toBe(false);
  });

  it("blocks implicit mention kinds excluded by policy", () => {
    const res = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: false,
        implicitMentionKinds: ["reply_to_bot"],
      },
      policy: {
        isGroup: true,
        requireMention: true,
        allowedImplicitMentionKinds: [],
        allowTextCommands: true,
        hasControlCommand: false,
        commandAuthorized: false,
      },
    });
    expect(res.implicitMention).toBe(false);
    expect(res.matchedImplicitMentionKinds).toStrictEqual([]);
    expect(res.effectiveWasMentioned).toBe(false);
    expect(res.shouldSkip).toBe(true);
  });

  it("dedupes repeated implicit mention kinds", () => {
    const res = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: false,
        implicitMentionKinds: ["reply_to_bot", "reply_to_bot", "native"],
      },
      policy: {
        isGroup: true,
        requireMention: true,
        allowTextCommands: true,
        hasControlCommand: false,
        commandAuthorized: false,
      },
    });
    expect(res.matchedImplicitMentionKinds).toEqual(["reply_to_bot", "native"]);
  });

  it("keeps command bypass behavior unchanged", () => {
    const res = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: false,
        hasAnyMention: false,
        implicitMentionKinds: [],
      },
      policy: {
        isGroup: true,
        requireMention: true,
        allowTextCommands: true,
        hasControlCommand: true,
        commandAuthorized: true,
      },
    });
    expect(res.shouldBypassMention).toBe(true);
    expect(res.effectiveWasMentioned).toBe(true);
    expect(res.shouldSkip).toBe(false);
  });

  it("does not allow command bypass when some other mention is present", () => {
    const res = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: false,
        hasAnyMention: true,
        implicitMentionKinds: [],
      },
      policy: {
        isGroup: true,
        requireMention: true,
        allowTextCommands: true,
        hasControlCommand: true,
        commandAuthorized: true,
      },
    });
    expect(res.shouldBypassMention).toBe(false);
    expect(res.effectiveWasMentioned).toBe(false);
    expect(res.shouldSkip).toBe(true);
  });

  it("does not allow command bypass outside groups", () => {
    const res = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: false,
        hasAnyMention: false,
        implicitMentionKinds: [],
      },
      policy: {
        isGroup: false,
        requireMention: true,
        allowTextCommands: true,
        hasControlCommand: true,
        commandAuthorized: true,
      },
    });
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
  it.each([
    {
      name: "raw gating",
      check: () =>
        resolveMentionGating({
          requireMention: true,
          canDetectMention: false,
          wasMentioned: false,
        }).shouldSkip,
    },
    {
      name: "inbound decision",
      check: () =>
        resolveInboundMentionDecision({
          facts: {
            canDetectMention: false,
            wasMentioned: false,
            implicitMentionKinds: [],
          },
          policy: {
            isGroup: true,
            requireMention: true,
            allowTextCommands: true,
            hasControlCommand: false,
            commandAuthorized: false,
          },
        }).shouldSkip,
    },
  ])("does not skip when mention detection is unavailable for $name", ({ check }) => {
    expect(check()).toBe(false);
  });
});

describe("implicitMentionKindWhen", () => {
  it("returns a one-item list when enabled", () => {
    expect(implicitMentionKindWhen("reply_to_bot", true)).toEqual(["reply_to_bot"]);
  });

  it("returns an empty list when disabled", () => {
    expect(implicitMentionKindWhen("reply_to_bot", false)).toStrictEqual([]);
  });
});
