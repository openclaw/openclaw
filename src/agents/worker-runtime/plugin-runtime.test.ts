import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ensureRuntimePluginsLoaded } from "../runtime-plugins.js";
import type { AgentRuntimeWorkerRunParams } from "./agent-runtime.types.js";
import { restoreAgentWorkerPluginRuntime } from "./plugin-runtime.js";

vi.mock("../runtime-plugins.js", () => ({
  ensureRuntimePluginsLoaded: vi.fn(),
}));

const mockedEnsureRuntimePluginsLoaded = vi.mocked(ensureRuntimePluginsLoaded);

function makeParams(): AgentRuntimeWorkerRunParams {
  return {
    providerOverride: "openai",
    originalProvider: "openai",
    modelOverride: "gpt-5.5",
    cfg: { plugins: { entries: { demo: { enabled: true } } } } as OpenClawConfig,
    sessionEntry: undefined,
    sessionId: "session-worker-test",
    sessionKey: "agent:main:worker-test",
    sessionAgentId: "main",
    sessionFile: "/tmp/openclaw-worker-session.jsonl",
    workspaceDir: "/tmp/openclaw-worker-workspace",
    body: "hello",
    isFallbackRetry: false,
    resolvedThinkLevel: "medium",
    timeoutMs: 1_000,
    runId: "run-worker-test",
    opts: { message: "hello", senderIsOwner: false },
    runContext: {} as AgentRuntimeWorkerRunParams["runContext"],
    spawnedBy: undefined,
    messageChannel: undefined,
    skillsSnapshot: undefined,
    resolvedVerboseLevel: undefined,
    agentDir: "/tmp/openclaw-worker-agent",
    authProfileProvider: "openai",
    sessionHasHistory: false,
  };
}

describe("agent worker plugin runtime", () => {
  beforeEach(() => {
    mockedEnsureRuntimePluginsLoaded.mockClear();
  });

  it("restores gateway-bindable runtime plugins before worker attempts", () => {
    const params = makeParams();

    restoreAgentWorkerPluginRuntime(params);

    expect(mockedEnsureRuntimePluginsLoaded).toHaveBeenCalledWith({
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      allowGatewaySubagentBinding: true,
    });
  });
});
