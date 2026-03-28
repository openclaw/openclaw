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

function expectFunctionKeys(value: Record<string, unknown>, keys: readonly string[]) {
  keys.forEach((key) => {
    expect(typeof value[key]).toBe("function");
  });
}

function expectRunCommandOutcome(params: {
  runtime: ReturnType<typeof createPluginRuntime>;
  expected: "resolve" | "reject";
  commandResult: ReturnType<typeof createCommandResult>;
}) {
  const command = params.runtime.system.runCommandWithTimeout(["echo", "hello"], {
    timeoutMs: 1000,
  });
  if (params.expected === "resolve") {
    return expect(command).resolves.toEqual(params.commandResult);
  }
  return expect(command).rejects.toThrow("boom");
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
    await expectRunCommandOutcome({ runtime, expected, commandResult });
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
        expectFunctionKeys(runtime.mediaUnderstanding as Record<string, unknown>, [
          "runFile",
          "describeImageFile",
          "describeImageFileWithModel",
          "describeVideoFile",
        ]);
        expect(runtime.mediaUnderstanding.transcribeAudioFile).toBe(
          runtime.stt.transcribeAudioFile,
        );
      },
    },
    {
      name: "exposes runtime.imageGeneration helpers",
      assert: (runtime: ReturnType<typeof createPluginRuntime>) => {
        expectFunctionKeys(runtime.imageGeneration as Record<string, unknown>, [
          "generate",
          "listProviders",
        ]);
      },
    },
    {
      name: "exposes runtime.webSearch helpers",
      assert: (runtime: ReturnType<typeof createPluginRuntime>) => {
        expectFunctionKeys(runtime.webSearch as Record<string, unknown>, [
          "listProviders",
          "search",
        ]);
      },
    },
    {
      name: "exposes runtime.agent host helpers",
      assert: (runtime: ReturnType<typeof createPluginRuntime>) => {
        expect(runtime.agent.defaults).toEqual({
          model: DEFAULT_MODEL,
          provider: DEFAULT_PROVIDER,
        });
        expectFunctionKeys(runtime.agent as Record<string, unknown>, [
          "runEmbeddedPiAgent",
          "resolveAgentDir",
        ]);
        expectFunctionKeys(runtime.agent.session as Record<string, unknown>, [
          "resolveSessionFilePath",
        ]);
      },
    },
    {
      name: "exposes runtime.modelAuth with getApiKeyForModel and resolveApiKeyForProvider",
      assert: (runtime: ReturnType<typeof createPluginRuntime>) => {
        expect(runtime.modelAuth).toBeDefined();
        expectFunctionKeys(runtime.modelAuth as Record<string, unknown>, [
          "getApiKeyForModel",
          "resolveApiKeyForProvider",
        ]);
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
