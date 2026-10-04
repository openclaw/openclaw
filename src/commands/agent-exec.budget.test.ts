import { afterEach, describe, expect, it, vi } from "vitest";
import { captureAgentToolSourceExecutionGuard } from "../agents/agent-tool-source-execution-guard.js";
import { wrapToolWithBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.js";
import { createStubTool } from "../agents/test-helpers/agent-tool-stubs.js";
import { runAgentExecWithMock } from "./agent-exec.test-helpers.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const runtime = createTestRuntime();
const success = () => ({ payloads: [{ text: "done" }], meta: { durationMs: 1 } });

afterEach(() => vi.restoreAllMocks());

describe("agent exec tool lifetime", () => {
  it("closes retained tool closures when the invocation ends", async () => {
    const source = vi.fn(async () => ({ content: [], details: {} }));
    let retained: ReturnType<typeof wrapToolWithBeforeToolCallHook> | undefined;
    const result = await runAgentExecWithMock("inspect", {}, runtime, async () => {
      retained = wrapToolWithBeforeToolCallHook({ ...createStubTool("read"), execute: source });
      return success();
    });

    expect(result.exitCode).toBe(0);
    await expect(retained?.execute("late", {})).rejects.toThrow();
    expect(source).not.toHaveBeenCalled();
  });

  it("retained effect guards cannot borrow a replacement invocation's authority", async () => {
    let retainedGuard: (() => void) | undefined;
    const effect = vi.fn();
    await runAgentExecWithMock("inspect", {}, runtime, async () => {
      retainedGuard = captureAgentToolSourceExecutionGuard();
      return success();
    });
    const replacement = await runAgentExecWithMock("inspect", {}, runtime, async () => {
      expect(() => {
        retainedGuard?.();
        effect();
      }).toThrow("execution scope is no longer active");
      return success();
    });
    expect(replacement.exitCode).toBe(0);
    expect(effect).not.toHaveBeenCalled();
  });
});
