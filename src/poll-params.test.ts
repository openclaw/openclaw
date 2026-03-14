import { describe, expect, it } from "vitest";
import {
  hasPollCreationParams,
  resolveTelegramPollVisibility,
  stripPollCreationParams,
} from "./poll-params.js";

describe("poll params", () => {
  // --- hasPollCreationParams: now gates on pollQuestion ---

  it("returns false when no poll params are present", () => {
    expect(hasPollCreationParams({})).toBe(false);
  });

  it("returns false when only non-question poll params are present (model auto-fill)", () => {
    // This is the core bug fix: models auto-fill these defaults on action="send"
    expect(hasPollCreationParams({ pollMulti: false })).toBe(false);
    expect(hasPollCreationParams({ pollMulti: true })).toBe(false);
    expect(hasPollCreationParams({ pollDurationHours: 0 })).toBe(false);
    expect(hasPollCreationParams({ pollDurationHours: 24 })).toBe(false);
    expect(hasPollCreationParams({ pollAnonymous: false })).toBe(false);
    expect(hasPollCreationParams({ pollPublic: true })).toBe(false);
    expect(hasPollCreationParams({ pollOption: ["Pizza", "Sushi"] })).toBe(false);
  });

  it("returns true when pollQuestion has a non-empty value", () => {
    expect(hasPollCreationParams({ pollQuestion: "Lunch?" })).toBe(true);
  });

  it("returns false when pollQuestion is empty or whitespace", () => {
    expect(hasPollCreationParams({ pollQuestion: "" })).toBe(false);
    expect(hasPollCreationParams({ pollQuestion: "   " })).toBe(false);
  });

  it("detects snake_case poll_question as poll creation intent", () => {
    expect(hasPollCreationParams({ poll_question: "Lunch?" })).toBe(true);
    expect(hasPollCreationParams({ poll_question: "" })).toBe(false);
  });

  it("returns true when pollQuestion is present alongside other poll params", () => {
    expect(
      hasPollCreationParams({
        pollQuestion: "Lunch?",
        pollOption: ["Pizza", "Sushi"],
        pollMulti: true,
        pollDurationHours: 24,
      }),
    ).toBe(true);
  });

  // --- stripPollCreationParams ---

  it("strips all poll creation params from a params object", () => {
    const params: Record<string, unknown> = {
      action: "send",
      channel: "discord",
      message: "Hello",
      filePath: "/tmp/image.png",
      pollQuestion: "Lunch?",
      pollOption: ["Pizza", "Sushi"],
      pollDurationHours: 24,
      pollMulti: true,
    };
    stripPollCreationParams(params);
    expect(params).toEqual({
      action: "send",
      channel: "discord",
      message: "Hello",
      filePath: "/tmp/image.png",
    });
  });

  it("strips snake_case poll params", () => {
    const params: Record<string, unknown> = {
      message: "Hello",
      poll_question: "Lunch?",
      poll_option: ["A", "B"],
      poll_duration_hours: 12,
      poll_multi: false,
    };
    stripPollCreationParams(params);
    expect(params).toEqual({ message: "Hello" });
  });

  it("is a no-op when no poll params are present", () => {
    const params: Record<string, unknown> = {
      action: "send",
      channel: "discord",
      message: "Hello",
    };
    const original = { ...params };
    stripPollCreationParams(params);
    expect(params).toEqual(original);
  });

  // --- resolveTelegramPollVisibility (unchanged) ---

  it("resolves telegram poll visibility flags", () => {
    expect(resolveTelegramPollVisibility({ pollAnonymous: true })).toBe(true);
    expect(resolveTelegramPollVisibility({ pollPublic: true })).toBe(false);
    expect(resolveTelegramPollVisibility({})).toBeUndefined();
    expect(() => resolveTelegramPollVisibility({ pollAnonymous: true, pollPublic: true })).toThrow(
      /mutually exclusive/i,
    );
  });
});
