import { describe, expect, it } from "vitest";
import { hasPollCreationParams } from "./poll-params.js";

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

  it("treats non-zero finite numeric poll params as poll creation intent only when question or options are present", () => {
    // Duration alone is insufficient — GPT-5.4/5.5 sends pollDurationHours:24 on every call.
    // A question or option list is required to distinguish genuine poll intent (#52757).
    expect(hasPollCreationParams({ pollDurationSeconds: 60 })).toBe(false);
    expect(hasPollCreationParams({ pollDurationHours: -1 })).toBe(false);
    expect(hasPollCreationParams({ pollDurationHours: Number.NaN })).toBe(false);
    expect(hasPollCreationParams({ pollDurationSeconds: Infinity })).toBe(false);
    expect(hasPollCreationParams({ pollDurationSeconds: "60abc" })).toBe(false);
    // Duration together with a real question IS poll intent
    expect(hasPollCreationParams({ pollDurationSeconds: 60, pollQuestion: "Lunch?" })).toBe(true);
    expect(hasPollCreationParams({ pollDurationHours: 24, pollOption: ["Yes", "No"] })).toBe(true);
  });

  it("does not treat zero-valued numeric poll params as poll creation intent", () => {
    // Zero values are typically defaults/unset values from tool schemas,
    // not intentional poll creation. Fixes #52118.
    expect(hasPollCreationParams({ pollDurationHours: 0 })).toBe(false);
    expect(hasPollCreationParams({ pollDurationSeconds: 0 })).toBe(false);
    expect(hasPollCreationParams({ pollDurationHours: "0" })).toBe(false);
    expect(hasPollCreationParams({ poll_duration_seconds: 0 })).toBe(false);
    expect(hasPollCreationParams({ poll_duration_hours: "0" })).toBe(false);
  });

  it("treats string-encoded boolean poll params as poll creation intent only when question or options are present", () => {
    // Boolean-only params (pollPublic, pollMulti) without a question are not poll intent (#52757).
    expect(hasPollCreationParams({ pollPublic: "true" })).toBe(false);
    expect(hasPollCreationParams({ pollAnonymous: "false" })).toBe(false);
    // Boolean together with a question IS poll intent
    expect(hasPollCreationParams({ pollPublic: "true", pollQuestion: "Should we go?" })).toBe(true);
  });

  it("treats string poll options as poll creation intent", () => {
    expect(hasPollCreationParams({ pollOption: "Yes" })).toBe(true);
  });

  it("detects snake_case poll fields as poll creation intent", () => {
    expect(hasPollCreationParams({ poll_question: "Lunch?" })).toBe(true);
    expect(hasPollCreationParams({ poll_option: ["Pizza", "Sushi"] })).toBe(true);
    // snake_case duration and boolean alone are no longer sufficient — question/options required
    expect(hasPollCreationParams({ poll_duration_seconds: "60" })).toBe(false);
    expect(hasPollCreationParams({ poll_public: "true" })).toBe(false);
    expect(hasPollCreationParams({ poll_duration_seconds: "60", poll_question: "Ready?" })).toBe(true);
  });

  it("ignores poll vote params when deciding whether send should become poll", () => {
    expect(hasPollCreationParams({ pollId: "poll-1" })).toBe(false);
    expect(hasPollCreationParams({ pollOptionId: "answer-1" })).toBe(false);
    expect(hasPollCreationParams({ pollOptionIndexes: [1] })).toBe(false);
  });
});
