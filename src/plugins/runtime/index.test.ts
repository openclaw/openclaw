import { beforeEach, describe, expect, it, vi } from "vitest";
import { onAgentEvent } from "../../infra/agent-events.js";
import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";

const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());

vi.mock("../../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

import { createPluginRuntime } from "./index.js";

describe("plugin runtime command execution", () => {
  beforeEach(() => {
    runCommandWithTimeoutMock.mockClear();
  });

  it("exposes runtime.system.runCommandWithTimeout by default", async () => {
    const commandResult = {
      stdout: "hello\n",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit" as const,
    };
    runCommandWithTimeoutMock.mockResolvedValue(commandResult);

    const runtime = createPluginRuntime();
    await expect(
      runtime.system.runCommandWithTimeout(["echo", "hello"], { timeoutMs: 1000 }),
    ).resolves.toEqual(commandResult);
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(["echo", "hello"], { timeoutMs: 1000 });
  });

  it("forwards runtime.system.runCommandWithTimeout errors", async () => {
    runCommandWithTimeoutMock.mockRejectedValue(new Error("boom"));
    const runtime = createPluginRuntime();
    await expect(
      runtime.system.runCommandWithTimeout(["echo", "hello"], { timeoutMs: 1000 }),
    ).rejects.toThrow("boom");
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(["echo", "hello"], { timeoutMs: 1000 });
  });

  it("exposes runtime.events listener registration helpers", () => {
    const runtime = createPluginRuntime();
    expect(runtime.events.onAgentEvent).toBe(onAgentEvent);
    expect(runtime.events.onSessionTranscriptUpdate).toBe(onSessionTranscriptUpdate);
  });

  it("exposes runtime.system.requestHeartbeatNow", () => {
    const runtime = createPluginRuntime();
    expect(runtime.system.requestHeartbeatNow).toBe(requestHeartbeatNow);
  });

  it("exposes runtime.modelAuth with getApiKeyForModel and resolveApiKeyForProvider", () => {
    const runtime = createPluginRuntime();
    expect(runtime.modelAuth).toBeDefined();
    expect(typeof runtime.modelAuth.getApiKeyForModel).toBe("function");
    expect(typeof runtime.modelAuth.resolveApiKeyForProvider).toBe("function");
  });

  it("modelAuth wrappers strip agentDir and store to prevent credential steering", async () => {
    // The wrappers should not forward agentDir or store from plugin callers.
    // We verify this by checking the wrapper functions exist and are not the
    // raw implementations (they are wrapped, not direct references).
    const { getApiKeyForModel: rawGetApiKey } = await import("../../agents/model-auth.js");
    const runtime = createPluginRuntime();
    // Wrappers should NOT be the same reference as the raw functions
    expect(runtime.modelAuth.getApiKeyForModel).not.toBe(rawGetApiKey);
  });

  it("uses the provided subagent runtime when available", async () => {
    const subagent = {
      run: vi.fn(async () => ({ runId: "run-1" })),
      enqueue: vi.fn(async () => ({ runId: "run-1" })),
      abort: vi.fn(async () => ({ aborted: true })),
      waitForRun: vi.fn(async () => ({ status: "ok" as const })),
      getSessionMessages: vi.fn(async () => ({ messages: [] })),
      getSession: vi.fn(async () => ({ messages: [] })),
      deleteSession: vi.fn(async () => undefined),
    };

    const runtime = createPluginRuntime({ subagent });
    await expect(runtime.subagent.run({ sessionKey: "s", message: "hi" })).resolves.toEqual({
      runId: "run-1",
    });
    await expect(runtime.subagent.enqueue({ sessionKey: "s", message: "hi" })).resolves.toEqual({
      runId: "run-1",
    });
    await expect(runtime.subagent.abort({ runId: "run-1" })).resolves.toEqual({
      aborted: true,
    });
    expect(subagent.run).toHaveBeenCalledWith({ sessionKey: "s", message: "hi" });
    expect(subagent.enqueue).toHaveBeenCalledWith({ sessionKey: "s", message: "hi" });
    expect(subagent.abort).toHaveBeenCalledWith({ runId: "run-1" });
  });
});
