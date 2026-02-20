import { describe, expect, it } from "vitest";
import { shouldVerifyResponse } from "./agent-verifier-trigger.js";

describe("shouldVerifyResponse", () => {
  it('"done" matches "I\'m done with the task" -> true', () => {
    expect(shouldVerifyResponse("I'm done with the task", ["done"])).toBe(true);
  });

  it('"done" does NOT match "undone" -> false', () => {
    expect(shouldVerifyResponse("undone", ["done"])).toBe(false);
  });

  it('"done" does NOT match "abandoned" -> false', () => {
    expect(shouldVerifyResponse("abandoned", ["done"])).toBe(false);
  });

  it('"completed" matches "Task completed!" -> true (case-insensitive + punctuation)', () => {
    expect(shouldVerifyResponse("Task completed!", ["completed"])).toBe(true);
  });

  it('"here you go" matches "Here you go, the results are ready" -> true', () => {
    expect(shouldVerifyResponse("Here you go, the results are ready", ["here you go"])).toBe(true);
  });

  it("Empty text -> false", () => {
    expect(shouldVerifyResponse("", ["done"])).toBe(false);
  });

  it("Empty keywords array -> false", () => {
    expect(shouldVerifyResponse("I'm done", [])).toBe(false);
  });

  it("Multiple keywords: matches if ANY keyword found", () => {
    expect(shouldVerifyResponse("Task completed!", ["done", "completed"])).toBe(true);
    expect(shouldVerifyResponse("I'm done!", ["done", "completed"])).toBe(true);
    expect(shouldVerifyResponse("Neither word here", ["done", "completed"])).toBe(false);
  });

  it("Special regex chars in keywords don't break matching", () => {
    // These should not throw or break matching
    expect(shouldVerifyResponse("test.test", ["test.test"])).toBe(true);
    expect(shouldVerifyResponse("test+test", ["test+test"])).toBe(true);
    expect(shouldVerifyResponse("test*test", ["test*test"])).toBe(true);
    expect(shouldVerifyResponse("test[1]", ["test[1]"])).toBe(true);
  });
});
