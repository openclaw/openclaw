import { describe, expect, it } from "vitest";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import {
  applyLightweightReplyLane,
  classifyLightweightLane,
  LIGHTWEIGHT_LANE_MAX_TEXT_LENGTH,
  type LightweightLaneSignals,
} from "./lightweight-lane.js";

function signals(overrides: Partial<LightweightLaneSignals> = {}): LightweightLaneSignals {
  return {
    text: "how's your day going?",
    hasMedia: false,
    hasLink: false,
    isNativeCommand: false,
    hasUnresolvedReplyTarget: false,
    ...overrides,
  };
}

describe("classifyLightweightLane", () => {
  it("admits obvious low-risk chat", () => {
    for (const text of [
      "thanks, that really helped!",
      "good morning :)",
      "haha that's hilarious",
      "what do you think about jazz?",
      "how are you doing today?",
      "no worries, talk later",
    ]) {
      expect(classifyLightweightLane(signals({ text })), text).toEqual({ eligible: true });
    }
  });

  it("escalates empty or oversized text", () => {
    expect(classifyLightweightLane(signals({ text: "   " }))).toEqual({
      eligible: false,
      reason: "empty_or_long",
    });
    expect(
      classifyLightweightLane(signals({ text: "a".repeat(LIGHTWEIGHT_LANE_MAX_TEXT_LENGTH + 1) })),
    ).toEqual({ eligible: false, reason: "empty_or_long" });
  });

  it("escalates inbound media and links", () => {
    expect(classifyLightweightLane(signals({ hasMedia: true }))).toEqual({
      eligible: false,
      reason: "media",
    });
    expect(
      classifyLightweightLane(signals({ text: "see https://example.com", hasLink: true })),
    ).toEqual({ eligible: false, reason: "link" });
  });

  it("escalates native and slash commands", () => {
    expect(classifyLightweightLane(signals({ isNativeCommand: true }))).toEqual({
      eligible: false,
      reason: "native_command",
    });
    expect(classifyLightweightLane(signals({ text: "/status" }))).toEqual({
      eligible: false,
      reason: "slash_command",
    });
  });

  it("escalates unresolved reply targets", () => {
    expect(classifyLightweightLane(signals({ hasUnresolvedReplyTarget: true }))).toEqual({
      eligible: false,
      reason: "reply_target_dependency",
    });
  });

  it("escalates explicit action verbs", () => {
    for (const text of [
      "check the weather for tomorrow",
      "run the deploy script",
      "send an email to the team",
      "fix the failing test",
      "search for the latest news",
    ]) {
      expect(classifyLightweightLane(signals({ text })), text).toEqual({
        eligible: false,
        reason: "action_intent",
      });
    }
  });

  it("escalates ambiguous current-information chat instead of admitting by denylist fallback", () => {
    expect(classifyLightweightLane(signals({ text: "who won the game last night?" }))).toEqual({
      eligible: false,
      reason: "not_obvious_small_talk",
    });
    expect(
      classifyLightweightLane(signals({ text: "good morning, who won the game last night?" })),
    ).toEqual({
      eligible: false,
      reason: "not_obvious_small_talk",
    });
    expect(
      classifyLightweightLane(signals({ text: "good morning, what's the weather today?" })),
    ).toEqual({
      eligible: false,
      reason: "not_obvious_small_talk",
    });
    expect(classifyLightweightLane(signals({ text: "what's happening in London today?" }))).toEqual(
      {
        eligible: false,
        reason: "not_obvious_small_talk",
      },
    );
  });

  it("escalates code, system, and high-stakes topics", () => {
    expect(classifyLightweightLane(signals({ text: "what is in the codebase?" }))).toEqual({
      eligible: false,
      reason: "code_or_repo",
    });
    expect(
      classifyLightweightLane(signals({ text: "where do we store the gateway config" })),
    ).toEqual({ eligible: false, reason: "system_or_config" });
    expect(
      classifyLightweightLane(signals({ text: "should I worry about these symptoms" })),
    ).toEqual({ eligible: false, reason: "high_stakes" });
  });

  it("matches verbs on word boundaries, not substrings", () => {
    // "fixate" / "reading" must not trip the bare "fix" / "read" verbs.
    expect(classifyLightweightLane(signals({ text: "haha that's hilarious" }))).toEqual({
      eligible: true,
    });
    expect(
      classifyLightweightLane(signals({ text: "haha I keep fixating on small things" })),
    ).toEqual({ eligible: false, reason: "not_obvious_small_talk" });
  });
});

describe("applyLightweightReplyLane", () => {
  it("upgrades eligible chat with lightweight context", () => {
    const result = applyLightweightReplyLane(undefined, signals());
    expect(result).toEqual({ bootstrapContextMode: "lightweight" });
  });

  it("preserves unrelated caller options while upgrading", () => {
    const opts: GetReplyOptions = { runId: "abc", suppressTyping: true };
    const result = applyLightweightReplyLane(opts, signals());
    expect(result).toEqual({
      runId: "abc",
      suppressTyping: true,
      bootstrapContextMode: "lightweight",
    });
  });

  it("leaves ineligible turns on the full agent path", () => {
    expect(applyLightweightReplyLane(undefined, signals({ hasMedia: true }))).toBeUndefined();
    expect(
      applyLightweightReplyLane(undefined, signals({ text: "deploy the gateway" })),
    ).toBeUndefined();
  });

  it.each<[string, GetReplyOptions]>([
    ["isHeartbeat", { isHeartbeat: true }],
    ["bootstrapContextMode", { bootstrapContextMode: "full" }],
    ["disableTools=false", { disableTools: false }],
    ["sourceReplyDeliveryMode", { sourceReplyDeliveryMode: "message_tool_only" }],
    ["skillFilter", { skillFilter: ["weather"] }],
    ["images", { images: [{ type: "image", mimeType: "image/png", data: "x" }] }],
  ])("respects caller-pinned %s", (_label, opts) => {
    expect(applyLightweightReplyLane(opts, signals())).toBeUndefined();
  });
});
