import { describe, expect, it } from "vitest";
import { DEFAULT_CONTINUITY_CONFIG, resolveContinuityConfig } from "./config.js";

describe("resolveContinuityConfig", () => {
  it("falls back to defaults when the input is missing or invalid", () => {
    expect(resolveContinuityConfig()).toEqual(DEFAULT_CONTINUITY_CONFIG);
    expect(resolveContinuityConfig(["bad-input"])).toEqual(DEFAULT_CONTINUITY_CONFIG);
  });

  it("normalizes modes, booleans, numeric limits, and clones custom scope rules", () => {
    const raw = {
      capture: {
        mainDirect: "review",
        pairedDirect: "off",
        group: "auto",
        channel: "invalid",
        minConfidence: 9,
      },
      review: {
        autoApproveMain: false,
        requireSource: false,
      },
      recall: {
        maxItems: 3.9,
        includeOpenLoops: false,
        scope: {
          default: "deny",
          rules: [
            {
              action: "allow",
              match: {
                channel: "discord",
                chatType: "direct",
                keyPrefix: "discord:direct",
                rawKeyPrefix: "agent:alpha:",
              },
            },
          ],
        },
      },
    };

    const resolved = resolveContinuityConfig(raw);

    expect(resolved.capture).toEqual({
      mainDirect: "review",
      pairedDirect: "off",
      group: "auto",
      channel: DEFAULT_CONTINUITY_CONFIG.capture.channel,
      minConfidence: 1,
    });
    expect(resolved.review).toEqual({
      autoApproveMain: false,
      requireSource: false,
    });
    expect(resolved.recall).toEqual({
      maxItems: 3,
      includeOpenLoops: false,
      scope: raw.recall.scope,
    });
    expect(resolved.recall.scope).not.toBe(raw.recall.scope);
    expect(resolved.recall.scope.rules).not.toBe(raw.recall.scope.rules);
    expect(resolved.recall.scope.rules?.[0]?.match).not.toBe(raw.recall.scope.rules?.[0]?.match);

    if (raw.recall.scope.rules?.[0]?.match) {
      raw.recall.scope.rules[0].match.chatType = "group";
    }
    expect(resolved.recall.scope.rules?.[0]?.match?.chatType).toBe("direct");
  });

  it("enforces recall bounds and reuses defaults for invalid values", () => {
    const resolved = resolveContinuityConfig({
      capture: {
        minConfidence: Number.NaN,
      },
      review: {
        autoApproveMain: "nope",
        requireSource: "nope",
      },
      recall: {
        maxItems: 99,
        includeOpenLoops: "nope",
      },
    });

    expect(resolved.capture.minConfidence).toBe(DEFAULT_CONTINUITY_CONFIG.capture.minConfidence);
    expect(resolved.review).toEqual(DEFAULT_CONTINUITY_CONFIG.review);
    expect(resolved.recall.maxItems).toBe(12);
    expect(resolved.recall.includeOpenLoops).toBe(
      DEFAULT_CONTINUITY_CONFIG.recall.includeOpenLoops,
    );
    expect(resolved.recall.scope).toEqual(DEFAULT_CONTINUITY_CONFIG.recall.scope);
    expect(resolved.recall.scope).not.toBe(DEFAULT_CONTINUITY_CONFIG.recall.scope);
  });
});
