import { describe, expect, it } from "vitest";
import { hasPollCreationParams, resolveTelegramPollVisibility } from "./poll-params.js";

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

  it("treats positive numeric poll params as poll creation intent", () => {
    expect(hasPollCreationParams({ pollDurationSeconds: 60 })).toBe(true);
    expect(hasPollCreationParams({ pollDurationSeconds: "60" })).toBe(true);
    expect(hasPollCreationParams({ pollDurationSeconds: "1e3" })).toBe(true);
    expect(hasPollCreationParams({ pollDurationHours: Number.NaN })).toBe(false);
    expect(hasPollCreationParams({ pollDurationSeconds: Infinity })).toBe(false);
    expect(hasPollCreationParams({ pollDurationSeconds: "60abc" })).toBe(false);
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
});
