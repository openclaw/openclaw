// Tests content-bearing poll intent and ignored metadata.
import { describe, expect, it } from "vitest";
import { hasPollCreationParams } from "./poll-params.js";

describe("poll params", () => {
  it("does not treat shared modifier params (pollDurationHours, pollMulti) as poll creation intent without a question or options", () => {
    // These two are exposed by the shared `message` tool schema for both
    // `send` and `poll` actions, so LLMs routinely schema-pad them on every
    // plain `send` call with their schema-implied defaults (1 for an integer
    // with `minimum: 1`, `false` for a boolean). Treating those defaults as
    // poll intent blocks routine sends — see the regression that motivated
    // this carve-out.
    expect(hasPollCreationParams({ pollDurationHours: 1 })).toBe(false);
    expect(hasPollCreationParams({ pollDurationHours: 1, pollMulti: false })).toBe(false);
    expect(hasPollCreationParams({ pollDurationHours: 0 })).toBe(false);
    expect(hasPollCreationParams({ pollDurationHours: -1 })).toBe(false);
    expect(hasPollCreationParams({ pollDurationHours: "0" })).toBe(false);
    expect(hasPollCreationParams({ pollDurationHours: Number.NaN })).toBe(false);
    expect(hasPollCreationParams({ poll_duration_hours: "0" })).toBe(false);
    expect(hasPollCreationParams({ pollMulti: true })).toBe(false);
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
});
