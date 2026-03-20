import { describe, expect, it } from "vitest";
import { resolveMentionGating, resolveMentionGatingWithBypass } from "./mention-gating.js";

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
