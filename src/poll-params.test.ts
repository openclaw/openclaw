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
    "does not treat $key=true as poll creation intent without a question or option",
    ({ key }) => {
      expect(
        hasPollCreationParams({
          [key]: true,
        }),
      ).toBe(false);
    },
  );

  it("does not treat numeric poll metadata as poll creation intent without a question or option", () => {
    expect(hasPollCreationParams({ pollDurationSeconds: 60 })).toBe(false);
    expect(hasPollCreationParams({ pollDurationSeconds: "60" })).toBe(false);
    expect(hasPollCreationParams({ pollDurationSeconds: "+60" })).toBe(false);
    expect(hasPollCreationParams({ pollDurationSeconds: "1e3" })).toBe(false);
    expect(hasPollCreationParams({ pollDurationHours: -1 })).toBe(false);
    expect(hasPollCreationParams({ pollDurationSeconds: "-5" })).toBe(false);
    expect(hasPollCreationParams({ pollDurationHours: Number.NaN })).toBe(false);
    expect(hasPollCreationParams({ pollDurationSeconds: Infinity })).toBe(false);
    expect(hasPollCreationParams({ pollDurationSeconds: "60abc" })).toBe(false);
    expect(hasPollCreationParams({ pollDurationSeconds: "0x10" })).toBe(false);
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

  it("does not treat string-encoded boolean poll metadata as poll creation intent", () => {
    expect(hasPollCreationParams({ pollPublic: "true" })).toBe(false);
    expect(hasPollCreationParams({ pollAnonymous: "false" })).toBe(false);
  });

  it("treats string poll options as poll creation intent", () => {
    expect(hasPollCreationParams({ pollOption: "Yes" })).toBe(true);
  });

  it("detects snake_case poll fields as poll creation intent", () => {
    expect(hasPollCreationParams({ poll_question: "Lunch?" })).toBe(true);
    expect(hasPollCreationParams({ poll_option: ["Pizza", "Sushi"] })).toBe(true);
    expect(hasPollCreationParams({ poll_duration_seconds: "60" })).toBe(false);
    expect(hasPollCreationParams({ poll_public: "true" })).toBe(false);
  });

  it("ignores poll vote params when deciding whether send should become poll", () => {
    expect(hasPollCreationParams({ pollId: "poll-1" })).toBe(false);
    expect(hasPollCreationParams({ pollOptionId: "answer-1" })).toBe(false);
    expect(hasPollCreationParams({ pollOptionIndexes: [1] })).toBe(false);
  });
});
