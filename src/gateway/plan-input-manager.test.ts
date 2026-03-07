import { afterEach, describe, expect, it, vi } from "vitest";
import { PlanInputManager } from "./plan-input-manager.js";

describe("PlanInputManager", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("expires pending prompts after the timeout", async () => {
    vi.useFakeTimers();
    const manager = new PlanInputManager();
    const prompt = manager.create({
      runId: "run-1",
      sessionKey: "agent:main:main",
      timeoutMs: 50,
      questions: [
        {
          header: "Scope",
          id: "scope",
          question: "Which scope?",
          options: [
            { label: "TUI only", description: "Default" },
            { label: "All clients", description: "Alternative" },
          ],
        },
      ],
    });

    const resultPromise = manager.register(prompt);
    await vi.advanceTimersByTimeAsync(50);

    await expect(resultPromise).resolves.toEqual({ status: "expired" });
    expect(manager.getSnapshot(prompt.id)?.result).toEqual({ status: "expired" });
  });

  it("rejects concurrent prompts for the same run", () => {
    const manager = new PlanInputManager();
    const first = manager.create({
      runId: "run-1",
      sessionKey: "agent:main:main",
      questions: [
        {
          header: "Scope",
          id: "scope",
          question: "Which scope?",
          options: [
            { label: "TUI only", description: "Default" },
            { label: "All clients", description: "Alternative" },
          ],
        },
      ],
    });
    const second = manager.create({
      runId: "run-1",
      sessionKey: "agent:main:main",
      questions: [
        {
          header: "Name",
          id: "name",
          question: "What should we call it?",
          options: [
            { label: "Plan mode", description: "Default" },
            { label: "Proposal mode", description: "Alternative" },
          ],
        },
      ],
    });

    void manager.register(first);

    expect(() => manager.register(second)).toThrow(
      "run 'run-1' already has a pending plan input request",
    );
  });
});
