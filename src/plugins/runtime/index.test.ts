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

describe("plugin runtime command execution", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearGatewaySubagentRuntime();
  });

  it("exposes runtime.system.runCommandWithTimeout by default", async () => {
    const commandResult = {
      pid: 12345,
      stdout: "hello\n",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      noOutputTimedOut: false,
      termination: "exit" as const,
    };
    const runCommandWithTimeoutMock = vi
      .spyOn(execModule, "runCommandWithTimeout")
      .mockResolvedValue(commandResult);

    const runtime = createPluginRuntime();
    await expect(
      runtime.system.runCommandWithTimeout(["echo", "hello"], { timeoutMs: 1000 }),
    ).resolves.toEqual(commandResult);
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(["echo", "hello"], { timeoutMs: 1000 });
  });

  it("forwards runtime.system.runCommandWithTimeout errors", async () => {
    const runCommandWithTimeoutMock = vi
      .spyOn(execModule, "runCommandWithTimeout")
      .mockRejectedValue(new Error("boom"));
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

  it("exposes runtime.mediaUnderstanding helpers and keeps stt as an alias", () => {
    const runtime = createPluginRuntime();
    expect(typeof runtime.mediaUnderstanding.runFile).toBe("function");
    expect(typeof runtime.mediaUnderstanding.describeImageFile).toBe("function");
    expect(typeof runtime.mediaUnderstanding.describeImageFileWithModel).toBe("function");
    expect(typeof runtime.mediaUnderstanding.describeVideoFile).toBe("function");
    expect(runtime.mediaUnderstanding.transcribeAudioFile).toBe(runtime.stt.transcribeAudioFile);
  });

  it("exposes runtime.imageGeneration helpers", () => {
    const runtime = createPluginRuntime();
    expect(typeof runtime.imageGeneration.generate).toBe("function");
    expect(typeof runtime.imageGeneration.listProviders).toBe("function");
  });

  it("exposes runtime.webSearch helpers", () => {
    const runtime = createPluginRuntime();
    expect(typeof runtime.webSearch.listProviders).toBe("function");
    expect(typeof runtime.webSearch.search).toBe("function");
  });

  it("exposes runtime.system.requestHeartbeatNow", () => {
    const runtime = createPluginRuntime();
    expect(runtime.system.requestHeartbeatNow).toBe(requestHeartbeatNow);
  });

  it("exposes runtime.agent host helpers", () => {
    const runtime = createPluginRuntime();
    expect(runtime.agent.defaults).toEqual({
      model: DEFAULT_MODEL,
      provider: DEFAULT_PROVIDER,
    });
    expect(typeof runtime.agent.runEmbeddedPiAgent).toBe("function");
    expect(typeof runtime.agent.resolveAgentDir).toBe("function");
    expect(typeof runtime.agent.session.resolveSessionFilePath).toBe("function");
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

  it("keeps subagent unavailable by default even after gateway initialization", async () => {
    const runtime = createPluginRuntime();
    setGatewaySubagentRuntime({
      run: vi.fn(),
      waitForRun: vi.fn(),
      getSessionMessages: vi.fn(),
      getSession: vi.fn(),
      deleteSession: vi.fn(),
    });

    expect(() => runtime.subagent.run({ sessionKey: "s-1", message: "hello" })).toThrow(
      "Plugin runtime subagent methods are only available during a gateway request.",
    );
  });

  it("late-binds to the gateway subagent when explicitly enabled", async () => {
    const run = vi.fn().mockResolvedValue({ runId: "run-1" });
    const runtime = createPluginRuntime({ allowGatewaySubagentBinding: true });

    setGatewaySubagentRuntime({
      run,
      waitForRun: vi.fn(),
      getSessionMessages: vi.fn(),
      getSession: vi.fn(),
      deleteSession: vi.fn(),
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
