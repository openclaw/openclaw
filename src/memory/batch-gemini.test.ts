import { describe, expect, it } from "vitest";
import { normalizeGeminiBatchState } from "./batch-gemini.js";

describe("normalizeGeminiBatchState", () => {
  it("strips BATCH_STATE_ prefix", () => {
    expect(normalizeGeminiBatchState("BATCH_STATE_SUCCEEDED")).toBe("SUCCEEDED");
    expect(normalizeGeminiBatchState("BATCH_STATE_FAILED")).toBe("FAILED");
    expect(normalizeGeminiBatchState("BATCH_STATE_CANCELLED")).toBe("CANCELLED");
    expect(normalizeGeminiBatchState("BATCH_STATE_RUNNING")).toBe("RUNNING");
  });

  it("strips JOB_STATE_ prefix", () => {
    expect(normalizeGeminiBatchState("JOB_STATE_SUCCEEDED")).toBe("SUCCEEDED");
    expect(normalizeGeminiBatchState("JOB_STATE_FAILED")).toBe("FAILED");
    expect(normalizeGeminiBatchState("JOB_STATE_RUNNING")).toBe("RUNNING");
  });

  it("returns unprefixed values unchanged", () => {
    expect(normalizeGeminiBatchState("SUCCEEDED")).toBe("SUCCEEDED");
    expect(normalizeGeminiBatchState("FAILED")).toBe("FAILED");
    expect(normalizeGeminiBatchState("COMPLETED")).toBe("COMPLETED");
    expect(normalizeGeminiBatchState("DONE")).toBe("DONE");
    expect(normalizeGeminiBatchState("RUNNING")).toBe("RUNNING");
    expect(normalizeGeminiBatchState("UNKNOWN")).toBe("UNKNOWN");
  });

  it("handles empty string", () => {
    expect(normalizeGeminiBatchState("")).toBe("");
  });

  it("does not strip unrelated prefixes", () => {
    expect(normalizeGeminiBatchState("TASK_STATE_SUCCEEDED")).toBe("TASK_STATE_SUCCEEDED");
  });
});
