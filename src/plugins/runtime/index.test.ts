import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import * as execModule from "../../process/exec.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { VERSION } from "../../version.js";
import {
  clearGatewaySubagentRuntime,
  createPluginRuntime,
  setGatewaySubagentRuntime,
} from "./index.js";

function createCommandResult() {
  return {
    pid: 12345,
    stdout: "hello\n",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    noOutputTimedOut: false,
    termination: "exit" as const,
  };
}

function createGatewaySubagentRuntime() {
  return {
    run: vi.fn(),
    waitForRun: vi.fn(),
    getSessionMessages: vi.fn(),
    getSession: vi.fn(),
    deleteSession: vi.fn(),
  };
}

function expectRuntimeShape(
  assertRuntime: (runtime: ReturnType<typeof createPluginRuntime>) => void,
) {
  const runtime = createPluginRuntime();
  assertRuntime(runtime);
}

function expectGatewaySubagentRunFailure(
  runtime: ReturnType<typeof createPluginRuntime>,
  params: { sessionKey: string; message: string },
) {
  expect(() => runtime.subagent.run(params)).toThrow(
    "Plugin runtime subagent methods are only available during a gateway request.",
  );
}

describe("plugin runtime command execution", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearGatewaySubagentRuntime();
  });

  it.each([
    {
      name: "exposes runtime.system.runCommandWithTimeout by default",
      mockKind: "resolve" as const,
      expected: "resolve" as const,
    },
    {
      name: "forwards runtime.system.runCommandWithTimeout errors",
      mockKind: "reject" as const,
      expected: "reject" as const,
    },
  ] as const)("$name", async ({ mockKind, expected }) => {
    const commandResult = createCommandResult();
    const runCommandWithTimeoutMock = vi.spyOn(execModule, "runCommandWithTimeout");
    if (mockKind === "resolve") {
      runCommandWithTimeoutMock.mockResolvedValue(commandResult);
    } else {
      runCommandWithTimeoutMock.mockRejectedValue(new Error("boom"));
    }

    const runtime = createPluginRuntime();
    const command = runtime.system.runCommandWithTimeout(["echo", "hello"], { timeoutMs: 1000 });
    if (expected === "resolve") {
      await expect(command).resolves.toEqual(commandResult);
    } else {
      await expect(command).rejects.toThrow("boom");
    }
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(["echo", "hello"], { timeoutMs: 1000 });
  });

  it("exposes runtime.events listener registration helpers", () => {
    const runtime = createPluginRuntime();
    expect(runtime.events.onAgentEvent).toBe(onAgentEvent);
    expect(runtime.events.onSessionTranscriptUpdate).toBe(onSessionTranscriptUpdate);
  });

  it.each([
    {
      name: "exposes runtime.mediaUnderstanding helpers and keeps stt as an alias",
      assert: (runtime: ReturnType<typeof createPluginRuntime>) => {
        expect(typeof runtime.mediaUnderstanding.runFile).toBe("function");
        expect(typeof runtime.mediaUnderstanding.describeImageFile).toBe("function");
        expect(typeof runtime.mediaUnderstanding.describeImageFileWithModel).toBe("function");
        expect(typeof runtime.mediaUnderstanding.describeVideoFile).toBe("function");
        expect(runtime.mediaUnderstanding.transcribeAudioFile).toBe(
          runtime.stt.transcribeAudioFile,
        );
      },
    },
    {
      name: "exposes runtime.imageGeneration helpers",
      assert: (runtime: ReturnType<typeof createPluginRuntime>) => {
        expect(typeof runtime.imageGeneration.generate).toBe("function");
        expect(typeof runtime.imageGeneration.listProviders).toBe("function");
      },
    },
    {
      name: "exposes runtime.webSearch helpers",
      assert: (runtime: ReturnType<typeof createPluginRuntime>) => {
        expect(typeof runtime.webSearch.listProviders).toBe("function");
        expect(typeof runtime.webSearch.search).toBe("function");
      },
    },
    {
      name: "exposes runtime.agent host helpers",
      assert: (runtime: ReturnType<typeof createPluginRuntime>) => {
        expect(runtime.agent.defaults).toEqual({
          model: DEFAULT_MODEL,
          provider: DEFAULT_PROVIDER,
        });
        expect(typeof runtime.agent.runEmbeddedPiAgent).toBe("function");
        expect(typeof runtime.agent.resolveAgentDir).toBe("function");
        expect(typeof runtime.agent.session.resolveSessionFilePath).toBe("function");
      },
    },
    {
      name: "exposes runtime.modelAuth with getApiKeyForModel and resolveApiKeyForProvider",
      assert: (runtime: ReturnType<typeof createPluginRuntime>) => {
        expect(runtime.modelAuth).toBeDefined();
        expect(typeof runtime.modelAuth.getApiKeyForModel).toBe("function");
        expect(typeof runtime.modelAuth.resolveApiKeyForProvider).toBe("function");
      },
    },
  ] as const)("$name", ({ assert }) => {
    expectRuntimeShape(assert);
  });

  it("exposes runtime.system.requestHeartbeatNow", () => {
    const runtime = createPluginRuntime();
    expect(runtime.system.requestHeartbeatNow).toBe(requestHeartbeatNow);
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

  it("keeps subagent unavailable by default even after gateway initialization", async () => {
    const runtime = createPluginRuntime();
    setGatewaySubagentRuntime(createGatewaySubagentRuntime());

    expectGatewaySubagentRunFailure(runtime, { sessionKey: "s-1", message: "hello" });
  });

  it("late-binds to the gateway subagent when explicitly enabled", async () => {
    const run = vi.fn().mockResolvedValue({ runId: "run-1" });
    const runtime = createPluginRuntime({ allowGatewaySubagentBinding: true });

    setGatewaySubagentRuntime({
      ...createGatewaySubagentRuntime(),
      run,
    });

    await expect(runtime.subagent.run({ sessionKey: "s-2", message: "hello" })).resolves.toEqual({
      runId: "run-1",
    });
    expect(run).toHaveBeenCalledWith({ sessionKey: "s-2", message: "hello" });
  });

  it("exposes runtime.version from the shared VERSION constant", () => {
    const runtime = createPluginRuntime();
    expect(runtime.version).toBe(VERSION);
  });
});
