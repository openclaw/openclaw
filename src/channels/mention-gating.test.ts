import { describe, expect, it } from "vitest";
import {
  implicitMentionKindWhen,
  resolveInboundMentionDecision,
  resolveMentionGating,
  resolveMentionGatingWithBypass,
} from "./mention-gating.js";

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

  it("does not skip when mention detection is unavailable", () => {
    const res = resolveMentionGating({
      requireMention: true,
      canDetectMention: false,
      wasMentioned: false,
    });
    expect(res.shouldSkip).toBe(false);
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
    expect(res.matchedImplicitMentionKinds).toEqual([]);
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

  it("does not skip when mention detection is unavailable", () => {
    const res = resolveInboundMentionDecision({
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
    });
    expect(res.shouldSkip).toBe(false);
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

describe("implicitMentionKindWhen", () => {
  it("returns a one-item list when enabled", () => {
    expect(implicitMentionKindWhen("reply_to_bot", true)).toEqual(["reply_to_bot"]);
  });

  it("returns an empty list when disabled", () => {
    expect(implicitMentionKindWhen("reply_to_bot", false)).toEqual([]);
  });
});

describe("resolveInboundMentionDecision — suppressIfOtherAgentMentioned", () => {
  const baseAlwaysOnPolicy = {
    isGroup: true,
    requireMention: false, // always-on agent
    allowTextCommands: true,
    hasControlCommand: false,
    commandAuthorized: false,
  };

  it("suppresses always-on agent when another agent is explicitly mentioned", () => {
    const res = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: false,
        hasAnyMention: true,
      },
      policy: {
        ...baseAlwaysOnPolicy,
        suppressIfOtherAgentMentioned: true,
      },
    });
    expect(res.shouldSkip).toBe(true);
    expect(res.suppressedByOtherAgentMention).toBe(true);
    expect(res.effectiveWasMentioned).toBe(false);
  });

  it("does not suppress always-on agent when this agent was mentioned too", () => {
    const res = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: true,
        hasAnyMention: true,
      },
      policy: {
        ...baseAlwaysOnPolicy,
        suppressIfOtherAgentMentioned: true,
      },
    });
    expect(res.shouldSkip).toBe(false);
    expect(res.suppressedByOtherAgentMention).toBe(false);
  });

  it("does not suppress always-on agent when no mention is present (normal message)", () => {
    const res = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: false,
        hasAnyMention: false,
      },
      policy: {
        ...baseAlwaysOnPolicy,
        suppressIfOtherAgentMentioned: true,
      },
    });
    expect(res.shouldSkip).toBe(false);
    expect(res.suppressedByOtherAgentMention).toBe(false);
  });

  it("does not suppress when suppressIfOtherAgentMentioned is not set (opt-in only)", () => {
    const res = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: false,
        hasAnyMention: true,
      },
      policy: baseAlwaysOnPolicy,
    });
    expect(res.shouldSkip).toBe(false);
    expect(res.suppressedByOtherAgentMention).toBe(false);
  });

  it("does not suppress when mention detection is unavailable", () => {
    const res = resolveInboundMentionDecision({
      facts: {
        canDetectMention: false,
        wasMentioned: false,
        hasAnyMention: true,
      },
      policy: {
        ...baseAlwaysOnPolicy,
        suppressIfOtherAgentMentioned: true,
      },
    });
    expect(res.shouldSkip).toBe(false);
    expect(res.suppressedByOtherAgentMention).toBe(false);
  });

  it("does not suppress in direct/non-group chats", () => {
    const res = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: false,
        hasAnyMention: true,
      },
      policy: {
        ...baseAlwaysOnPolicy,
        isGroup: false,
        suppressIfOtherAgentMentioned: true,
      },
    });
    expect(res.shouldSkip).toBe(false);
    expect(res.suppressedByOtherAgentMention).toBe(false);
  });

  it("does not suppress a mention-required agent (requireMention=true handles its own skip)", () => {
    const res = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: false,
        hasAnyMention: true,
      },
      policy: {
        ...baseAlwaysOnPolicy,
        requireMention: true,
        suppressIfOtherAgentMentioned: true,
      },
    });
    // shouldSkip is true due to requireMention, but NOT via suppressedByOtherAgentMention
    expect(res.shouldSkip).toBe(true);
    expect(res.suppressedByOtherAgentMention).toBe(false);
  });

  it("suppressedByOtherAgentMention is false when always-on agent is not suppressed", () => {
    const res = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: false,
        hasAnyMention: false,
      },
      policy: {
        ...baseAlwaysOnPolicy,
        suppressIfOtherAgentMentioned: true,
      },
    });
    expect(res.suppressedByOtherAgentMention).toBe(false);
    expect(res.shouldSkip).toBe(false);
  });

  it("forwards suppressIfOtherAgentMentioned through the deprecated flat-params call shape", () => {
    // Regression: normalizeMentionDecisionParams previously dropped the field silently.
    const res = resolveInboundMentionDecision({
      isGroup: true,
      requireMention: false,
      canDetectMention: true,
      wasMentioned: false,
      hasAnyMention: true,
      allowTextCommands: true,
      hasControlCommand: false,
      commandAuthorized: false,
      suppressIfOtherAgentMentioned: true,
    });
    expect(res.shouldSkip).toBe(true);
    expect(res.suppressedByOtherAgentMention).toBe(true);
  });
});
