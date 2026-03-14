import { describe, expect, it } from "vitest";
import {
  hasPollCreationParams,
  resolveTelegramPollVisibility,
  stripPollCreationParams,
} from "./poll-params.js";

describe("poll params", () => {
  it("does not treat explicit false booleans as poll creation params", () => {
    expect(
      hasPollCreationParams({
        pollMulti: false,
        pollAnonymous: false,
        pollPublic: false,
      }),
    ).toBe(false);
  });

  it.each([{ key: "pollMulti" }, { key: "pollAnonymous" }, { key: "pollPublic" }])(
    "treats $key=true as poll creation intent",
    ({ key }) => {
      expect(
        hasPollCreationParams({
          [key]: true,
        }),
      ).toBe(true);
    },
  );

  it("treats finite numeric poll params as poll creation intent", () => {
    expect(hasPollCreationParams({ pollDurationHours: 0 })).toBe(true);
    expect(hasPollCreationParams({ pollDurationSeconds: 60 })).toBe(true);
    expect(hasPollCreationParams({ pollDurationSeconds: "60" })).toBe(true);
    expect(hasPollCreationParams({ pollDurationSeconds: "1e3" })).toBe(true);
    expect(hasPollCreationParams({ pollDurationHours: Number.NaN })).toBe(false);
    expect(hasPollCreationParams({ pollDurationSeconds: Infinity })).toBe(false);
    expect(hasPollCreationParams({ pollDurationSeconds: "60abc" })).toBe(false);
  });

  it("treats string-encoded boolean poll params as poll creation intent when true", () => {
    expect(hasPollCreationParams({ pollPublic: "true" })).toBe(true);
    expect(hasPollCreationParams({ pollAnonymous: "false" })).toBe(false);
  });

  it("treats string poll options as poll creation intent", () => {
    expect(hasPollCreationParams({ pollOption: "Yes" })).toBe(true);
  });

  it("detects snake_case poll fields as poll creation intent", () => {
    expect(hasPollCreationParams({ poll_question: "Lunch?" })).toBe(true);
    expect(hasPollCreationParams({ poll_option: ["Pizza", "Sushi"] })).toBe(true);
    expect(hasPollCreationParams({ poll_duration_seconds: "60" })).toBe(true);
    expect(hasPollCreationParams({ poll_public: "true" })).toBe(true);
  });

  it("resolves telegram poll visibility flags", () => {
    expect(resolveTelegramPollVisibility({ pollAnonymous: true })).toBe(true);
    expect(resolveTelegramPollVisibility({ pollPublic: true })).toBe(false);
    expect(resolveTelegramPollVisibility({})).toBeUndefined();
    expect(() => resolveTelegramPollVisibility({ pollAnonymous: true, pollPublic: true })).toThrow(
      /mutually exclusive/i,
    );
  });

  describe("stripPollCreationParams", () => {
    it("removes camelCase poll creation keys", () => {
      const params: Record<string, unknown> = {
        action: "send",
        message: "hello",
        pollQuestion: "Lunch?",
        pollOption: ["Pizza", "Sushi"],
        pollMulti: true,
      };
      const stripped = stripPollCreationParams(params);
      expect(stripped).toBe(true);
      expect(params).toEqual({ action: "send", message: "hello" });
    });

    it("removes snake_case poll creation keys", () => {
      const params: Record<string, unknown> = {
        action: "send",
        poll_question: "Lunch?",
        poll_option: ["A", "B"],
        poll_duration_hours: 24,
      };
      const stripped = stripPollCreationParams(params);
      expect(stripped).toBe(true);
      expect(params).toEqual({ action: "send" });
    });

    it("returns false when no poll keys are present", () => {
      const params: Record<string, unknown> = { action: "send", message: "hello" };
      const stripped = stripPollCreationParams(params);
      expect(stripped).toBe(false);
      expect(params).toEqual({ action: "send", message: "hello" });
    });

    it("makes hasPollCreationParams return false after stripping", () => {
      const params: Record<string, unknown> = {
        pollQuestion: "Lunch?",
        pollOption: ["A", "B"],
        pollDurationHours: 24,
        pollMulti: true,
        pollAnonymous: true,
      };
      expect(hasPollCreationParams(params)).toBe(true);
      stripPollCreationParams(params);
      expect(hasPollCreationParams(params)).toBe(false);
    });
  });
});
