import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry, TEST_PLUGIN_AGENT_CTX } from "./hooks.test-fixtures.js";
import type { PluginHookBeforeAgentFinalizeResult } from "./types.js";

const event = {
  runId: "run-1",
  sessionId: "session-1",
  stopHookActive: false,
  lastAssistantMessage: "done",
};
function finalize(...results: PluginHookBeforeAgentFinalizeResult[]) {
  return createHookRunner(
    createMockPluginRegistry(
      results.map((result) => ({
        hookName: "before_agent_finalize",
        handler: () => result,
      })),
    ),
  ).runBeforeAgentFinalize(event, TEST_PLUGIN_AGENT_CTX);
}

describe("before_agent_finalize", () => {
  it("retains valid retry candidates in order while discarding invalid instructions", async () => {
    const result = await finalize(
      { action: "revise", reason: "empty", retry: { instruction: "   ", idempotencyKey: "empty" } },
      {
        action: "revise",
        reason: "malformed",
        retry: { instruction: 123, idempotencyKey: "bad" } as never,
      },
      {
        action: "revise",
        reason: "artifacts",
        retry: {
          instruction: " regenerate artifacts ",
          idempotencyKey: "artifacts",
          maxAttempts: 1,
        },
      },
      {
        action: "revise",
        reason: "tests",
        retry: { instruction: "rerun tests", idempotencyKey: "tests", maxAttempts: 1 },
      },
    );
    expect(result).toEqual({
      action: "revise",
      reason: "empty\n\nmalformed\n\nartifacts\n\ntests",
      retry: { instruction: "regenerate artifacts", idempotencyKey: "artifacts", maxAttempts: 1 },
    });
    expect(Object.getOwnPropertyDescriptor(result, "retryCandidates")).toMatchObject({
      enumerable: false,
      value: [
        { instruction: "regenerate artifacts", idempotencyKey: "artifacts", maxAttempts: 1 },
        { instruction: "rerun tests", idempotencyKey: "tests", maxAttempts: 1 },
      ],
    });
  });

  it("lets finalize override revise decisions", async () => {
    await expect(
      finalize(
        { action: "revise", reason: "keep going" },
        { action: "finalize", reason: "enough" },
      ),
    ).resolves.toEqual({ action: "finalize", reason: "enough" });
  });

  it("bounds hung handlers so the original final answer can proceed", async () => {
    vi.useFakeTimers();
    try {
      const logger = { error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
      const runner = createHookRunner(
        createMockPluginRegistry([
          { hookName: "before_agent_finalize", handler: () => new Promise(() => {}) },
        ]),
        { logger },
      );
      const run = runner.runBeforeAgentFinalize(event, TEST_PLUGIN_AGENT_CTX);
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(run).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("timed out after 15000ms"));
    } finally {
      vi.useRealTimers();
    }
  });
});
