import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../../config/config.js";
import { requestHeartbeat, setHeartbeatWakeHandler } from "../../infra/heartbeat-wake.js";

const runtimeModelAuthMocks = vi.hoisted(() => ({
  getApiKeyForModel: vi.fn(),
  getRuntimeAuthForModelCore: vi.fn(),
  resolveProviderRuntimeApiKey: vi.fn(),
}));
const heartbeatRunnerMocks = vi.hoisted(() => ({ loads: 0, runHeartbeatOnce: vi.fn() }));
vi.mock("../../infra/heartbeat-runner.js", () => {
  heartbeatRunnerMocks.loads++;
  return { runHeartbeatOnce: heartbeatRunnerMocks.runHeartbeatOnce };
});

// mock-isolation: Exercise the lazy runtime facade without loading credential-backed model auth.
vi.mock("./runtime-model-auth.runtime.js", () => runtimeModelAuthMocks);

import { createPluginRuntime } from "./index.js";

describe("plugin runtime command execution", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.values(runtimeModelAuthMocks).forEach((mock) => mock.mockReset());
    resetConfigRuntimeState();
  });

  it("defers heartbeat execution and forwards only plugin-safe options", async () => {
    const system = createPluginRuntime().system;
    expect(heartbeatRunnerMocks.loads).toBe(0);
    const result = { status: "skipped", reason: "disabled" };
    heartbeatRunnerMocks.runHeartbeatOnce.mockResolvedValueOnce(result);
    await expect(
      system.runHeartbeatOnce({
        reason: "plugin-event",
        agentId: "main",
        sessionKey: "session",
        heartbeat: { target: "none", every: "1ms" },
        cfg: {},
        deps: {},
      } as Parameters<typeof system.runHeartbeatOnce>[0]),
    ).resolves.toBe(result);
    expect(heartbeatRunnerMocks.loads).toBe(1);
    expect(heartbeatRunnerMocks.runHeartbeatOnce).toHaveBeenCalledWith({
      reason: "plugin-event",
      agentId: "main",
      sessionKey: "session",
      heartbeat: { target: "none" },
    });
    const failure = new Error("heartbeat failed");
    heartbeatRunnerMocks.runHeartbeatOnce.mockRejectedValueOnce(failure);
    await expect(system.runHeartbeatOnce()).rejects.toBe(failure);
    expect(heartbeatRunnerMocks.runHeartbeatOnce).toHaveBeenLastCalledWith({
      reason: undefined,
      agentId: undefined,
      sessionKey: undefined,
      heartbeat: undefined,
    });
    heartbeatRunnerMocks.runHeartbeatOnce.mockReset();
  });

  it("maps deprecated runtime.system.requestHeartbeatNow to an immediate compatibility wake", async () => {
    vi.useFakeTimers();
    const handler = vi.fn(async (_request: Parameters<typeof requestHeartbeat>[0]) => ({
      status: "skipped" as const,
      reason: "disabled",
    }));
    const dispose = setHeartbeatWakeHandler(handler);
    try {
      createPluginRuntime().system.requestHeartbeatNow({ reason: "legacy-plugin", coalesceMs: 0 });
      await vi.advanceTimersByTimeAsync(1);
      expect(handler.mock.calls[0]?.[0]).toMatchObject({
        source: "other",
        intent: "immediate",
        reason: "legacy-plugin",
      });
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });

  it("resolves thinking policy with configured model compat from runtime config", () => {
    const model = {
      id: "gpt-5.4",
      name: "GPT 5.4 via GMN",
      reasoning: true,
      compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
    };
    const providers = { gmn: { baseUrl: "https://gmn.example.com/v1", models: [model] } };
    setRuntimeConfigSnapshot({ models: { providers } } as unknown as OpenClawConfig);

    const runtime = createPluginRuntime();
    const policy = runtime.agent.resolveThinkingPolicy({ provider: "gmn", model: "gpt-5.4" });

    expect(policy.levels.map((level) => level.id)).toContain("xhigh");
  });

  it("includes persisted session exec overrides in sandbox authority", () => {
    const runtime = createPluginRuntime();
    const getSessionEntry = vi
      .spyOn(runtime.agent.session, "getSessionEntry")
      .mockReturnValue({ sessionId: "session", updatedAt: 1, execHost: "gateway" });
    const config: OpenClawConfig = {
      agents: {
        defaults: { sandbox: { mode: "all", scope: "session", workspaceAccess: "rw" } },
        entries: { main: {} },
      },
      tools: { elevated: { enabled: false } },
    };

    const scope = {
      agentId: "main",
      sessionKey: "agent:main:subagent:workboard-card",
    };
    const result = runtime.sandbox.resolveWorkspaceAuthority({ config, ...scope });

    expect(getSessionEntry).toHaveBeenCalledWith(scope);
    expect(result.confinementError).toContain("outside the sandbox");
  });

  it("modelAuth wrappers preserve workspace scope while stripping credential steering", async () => {
    const runtime = createPluginRuntime();
    const model = {
      id: "workspace-cloud/model",
      provider: "workspace-cloud",
      api: "openai-responses",
      baseUrl: "https://workspace-cloud.example/v1",
    };
    const cfg: OpenClawConfig = { plugins: { allow: ["workspace-cloud"] } };
    const scope = {
      cfg,
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
      store: { version: 1, profiles: {} },
    };
    for (const [method, mockName, apiKey] of [
      ["getApiKeyForModel", "getApiKeyForModel", "model-key"],
      ["getRuntimeAuthForModel", "getRuntimeAuthForModelCore", "runtime-key"],
      ["resolveApiKeyForProvider", "resolveProviderRuntimeApiKey", "provider-key"],
    ] as const) {
      const mock = runtimeModelAuthMocks[mockName];
      const target =
        method === "resolveApiKeyForProvider" ? { provider: "workspace-cloud" } : { model };
      mock.mockResolvedValue({ apiKey, source: "workspace cloud credentials", mode: "api-key" });
      const auth = await runtime.modelAuth[method]({ ...scope, ...target } as never);
      expect(auth.apiKey).toBe(apiKey);
      expect(mock).toHaveBeenCalledWith({ ...target, cfg, workspaceDir: scope.workspaceDir });
    }
  });

  it("keeps subagent unavailable by default", () => {
    const runtime = createPluginRuntime();
    expect(() => runtime.subagent.run({ sessionKey: "s-1", message: "hello" })).toThrow(
      "Plugin runtime subagent methods are only available during a gateway request.",
    );
  });

  it("exposes a node duplex capability even when Gateway access is unavailable", () => {
    const nodes = createPluginRuntime().nodes;
    expect(nodes).toHaveProperty("openDuplex", expect.any(Function));
    expect(() => nodes.openDuplex({ nodeId: "node-1", command: "image.bridge" })).toThrow(
      "only available inside the Gateway",
    );
  });
});
