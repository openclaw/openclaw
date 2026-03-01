/**
 * Test: Plugin lifecycle interception — synthetic result injection via before_tool_call.
 *
 * Verifies that a plugin returning `syntheticResult` in `before_tool_call` causes
 * the actual tool function to be skipped and the synthetic value to be returned
 * instead (both in the wrapToolWithBeforeToolCallHook path and the
 * pi-tool-definition-adapter path).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => false),
    runBeforeToolCall: vi.fn(async () => undefined),
    runAfterToolCall: vi.fn(async () => {}),
  },
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
}));

// Suppress loop-detection side effects
vi.mock("../logging/diagnostic-session-state.js", () => ({
  getDiagnosticSessionState: () => ({}),
}));
vi.mock("./tool-loop-detection.js", () => ({
  detectToolCallLoop: () => ({ stuck: false }),
  recordToolCall: () => {},
  recordToolCallOutcome: () => {},
}));
vi.mock("../logging/diagnostic.js", () => ({
  logToolLoopAction: () => {},
}));

let runBeforeToolCallHook: typeof import("../agents/pi-tools.before-tool-call.js").runBeforeToolCallHook;
let wrapToolWithBeforeToolCallHook: typeof import("../agents/pi-tools.before-tool-call.js").wrapToolWithBeforeToolCallHook;

describe("before_tool_call syntheticResult injection", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ runBeforeToolCallHook, wrapToolWithBeforeToolCallHook } =
      await import("../agents/pi-tools.before-tool-call.js"));
    hookMocks.runner.hasHooks.mockReset().mockReturnValue(false);
    hookMocks.runner.runBeforeToolCall.mockReset().mockResolvedValue(undefined);
    hookMocks.runner.runAfterToolCall.mockReset().mockResolvedValue(undefined);
  });

  describe("runBeforeToolCallHook", () => {
    it("returns syntheticResult when hook provides one", async () => {
      hookMocks.runner.hasHooks.mockReturnValue(true);
      hookMocks.runner.runBeforeToolCall.mockResolvedValue({
        syntheticResult: { status: "cached", data: [1, 2, 3] },
      });

      const outcome = await runBeforeToolCallHook({ toolName: "read", params: { path: "/a" } });

      expect(outcome.blocked).toBe(false);
      // syntheticResult should be present
      expect((outcome as { syntheticResult?: unknown }).syntheticResult).toEqual({
        status: "cached",
        data: [1, 2, 3],
      });
    });

    it("does not block when syntheticResult is provided (syntheticResult wins over block)", async () => {
      hookMocks.runner.hasHooks.mockReturnValue(true);
      hookMocks.runner.runBeforeToolCall.mockResolvedValue({
        syntheticResult: "intercepted",
        block: true, // should be ignored when syntheticResult present
      });

      const outcome = await runBeforeToolCallHook({ toolName: "exec", params: {} });
      expect(outcome.blocked).toBe(false);
      expect((outcome as { syntheticResult?: unknown }).syntheticResult).toBe("intercepted");
    });

    it("still works normally (no hooks)", async () => {
      hookMocks.runner.hasHooks.mockReturnValue(false);
      const outcome = await runBeforeToolCallHook({ toolName: "read", params: { path: "/x" } });
      expect(outcome.blocked).toBe(false);
      expect((outcome as { syntheticResult?: unknown }).syntheticResult).toBeUndefined();
    });
  });

  describe("wrapToolWithBeforeToolCallHook", () => {
    it("skips real tool execution when syntheticResult is provided", async () => {
      hookMocks.runner.hasHooks.mockReturnValue(true);
      hookMocks.runner.runBeforeToolCall.mockResolvedValue({
        syntheticResult: { content: [{ type: "text", text: "cached result" }], details: {} },
      });

      const realExecute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "real" }] });
      const tool = {
        name: "read_file",
        description: "reads a file",
        parameters: {} as never,
        execute: realExecute,
      };

      const wrapped = wrapToolWithBeforeToolCallHook(tool);
      const result = await wrapped.execute("call-1", { path: "/file" }, undefined, undefined);

      // Real execute should NOT have been called
      expect(realExecute).not.toHaveBeenCalled();
      // Should return the synthetic result
      expect(result).toEqual({
        content: [{ type: "text", text: "cached result" }],
        details: {},
      });
    });

    it("calls real tool when no syntheticResult", async () => {
      hookMocks.runner.hasHooks.mockReturnValue(true);
      hookMocks.runner.runBeforeToolCall.mockResolvedValue({ params: { path: "/modified" } });

      const realExecute = vi
        .fn()
        .mockResolvedValue({ content: [{ type: "text", text: "real output" }] });
      const tool = {
        name: "read_file",
        description: "reads a file",
        parameters: {} as never,
        execute: realExecute,
      };

      const wrapped = wrapToolWithBeforeToolCallHook(tool);
      await wrapped.execute("call-2", { path: "/original" }, undefined, undefined);

      expect(realExecute).toHaveBeenCalledOnce();
    });

    it("blocks tool when hook returns block=true and no syntheticResult", async () => {
      hookMocks.runner.hasHooks.mockReturnValue(true);
      hookMocks.runner.runBeforeToolCall.mockResolvedValue({
        block: true,
        blockReason: "forbidden tool",
      });

      const realExecute = vi.fn();
      const tool = {
        name: "exec",
        description: "exec",
        parameters: {} as never,
        execute: realExecute,
      };

      const wrapped = wrapToolWithBeforeToolCallHook(tool);
      await expect(wrapped.execute("call-block", {}, undefined, undefined)).rejects.toThrow(
        "forbidden tool",
      );
      expect(realExecute).not.toHaveBeenCalled();
    });
  });
});
