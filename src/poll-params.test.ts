import { describe, expect, it } from "vitest";
import {
  hasPollCreationParams,
  resolveTelegramPollVisibility,
  stripInertPollCreationParams,
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

  it("stripInertPollCreationParams removes empty defaults without affecting real poll intent", () => {
    const cleared: Record<string, unknown> = {
      pollQuestion: "",
      pollOption: [],
      pollDurationHours: 0,
      pollDurationSeconds: "0",
      pollMulti: false,
      pollAnonymous: "false",
      pollPublic: "FALSE",
    };
    stripInertPollCreationParams(cleared);
    expect(cleared).toEqual({});

    const intact: Record<string, unknown> = {
      pollQuestion: "Snack?",
      pollOption: ["A", "B"],
      pollDurationSeconds: 60,
    };
    stripInertPollCreationParams(intact);
    expect(intact).toEqual({
      pollQuestion: "Snack?",
      pollOption: ["A", "B"],
      pollDurationSeconds: 60,
    });
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
