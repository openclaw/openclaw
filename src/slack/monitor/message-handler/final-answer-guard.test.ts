import { describe, expect, it } from "vitest";
import { enforceSlackDirectEitherOrAnswer, extractEitherOrQuestion } from "./final-answer-guard.js";

describe("extractEitherOrQuestion", () => {
  it("extracts options from explicit either-or questions", () => {
    expect(extractEitherOrQuestion("What's best? Indian or Chinese food?")).toEqual({
      leftOption: "Indian",
      rightOption: "Chinese food",
    });
  });

  it("ignores messages without either-or question form", () => {
    expect(extractEitherOrQuestion("Can you help with this")).toBeNull();
    expect(extractEitherOrQuestion("Can you help? thanks")).toBeNull();
  });
});

describe("enforceSlackDirectEitherOrAnswer", () => {
  it("injects a direct-answer prefix when reply misses both options", () => {
    const payload = enforceSlackDirectEitherOrAnswer({
      questionText: "What's best? Indian or Chinese food?",
      payload: { text: "Absolute banger. Cyber-firefighter mode approved." },
    });

    expect(payload.text).toBe(
      "Direct answer: it depends.\n\nAbsolute banger. Cyber-firefighter mode approved.",
    );
  });

  it("keeps replies that already choose one option", () => {
    const payload = enforceSlackDirectEitherOrAnswer({
      questionText: "Indian or Chinese food?",
      payload: { text: "Chinese food today, faster and lighter." },
    });

    expect(payload.text).toBe("Chinese food today, faster and lighter.");
  });

  it("does nothing when prompt is not either-or", () => {
    const payload = enforceSlackDirectEitherOrAnswer({
      questionText: "Can you check rollout health?",
      payload: { text: "Yes. Looking now." },
    });

    expect(payload.text).toBe("Yes. Looking now.");
  });
});
