import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  getAgentToolExecutionModel,
  runWithAgentToolExecutionModel,
} from "./tool-execution-model.js";

const parent = Object.freeze({ provider: "fixture", model: "parent" });
const specialist = Object.freeze({ provider: "fixture", model: "vision" });

describe("tool execution model facts", () => {
  it("restores nested scopes across awaited tool work", async () => {
    expect(getAgentToolExecutionModel()).toBeUndefined();
    await runWithAgentToolExecutionModel(parent, async () => {
      await runWithAgentToolExecutionModel(specialist, async () => {
        await Promise.resolve();
        expect(getAgentToolExecutionModel()).toBe(specialist);
      });
      expect(getAgentToolExecutionModel()).toBe(parent);
    });
    expect(getAgentToolExecutionModel()).toBeUndefined();
  });

  it("does not leak the model after an executor throws", async () => {
    await expect(
      runWithAgentToolExecutionModel(specialist, async () => {
        await Promise.resolve();
        throw new Error("synthetic executor failure");
      }),
    ).rejects.toThrow("synthetic executor failure");
    expect(getAgentToolExecutionModel()).toBeUndefined();
  });

  it("keeps parallel invocation models separate", async () => {
    const gate = createDeferred();
    const pending = [parent, specialist].map((model) =>
      runWithAgentToolExecutionModel(model, async () => {
        await gate.promise;
        return getAgentToolExecutionModel();
      }),
    );
    expect(getAgentToolExecutionModel()).toBeUndefined();
    gate.resolve();
    expect(await Promise.all(pending)).toEqual([parent, specialist]);
    expect(getAgentToolExecutionModel()).toBeUndefined();
  });

  it("shares facts with duplicate source/SDK module instances", async () => {
    vi.resetModules();
    const duplicate = await import("./tool-execution-model.js");
    await runWithAgentToolExecutionModel(specialist, async () => {
      await Promise.resolve();
      expect(duplicate.getAgentToolExecutionModel()).toBe(specialist);
    });
    expect(duplicate.getAgentToolExecutionModel()).toBeUndefined();
  });
});
