import { describe, expect, it } from "vitest";

import { resolveMentionGating } from "./mention-gating.js";

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
