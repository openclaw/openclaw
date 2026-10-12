// Plugin runtime index tests cover runtime entrypoint exports and registry setup.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import type { resolveSandboxContext } from "../../agents/sandbox/context.js";
import {
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { requestHeartbeat, setHeartbeatWakeHandler } from "../../infra/heartbeat-wake.js";
import { createDeferredCore } from "../../shared/deferred.js";

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

const sandboxContextMocks = vi.hoisted(() => ({
  resolveSandboxContext: vi.fn(),
}));

vi.mock("./runtime-model-auth.runtime.js", () => ({
  getApiKeyForModel: runtimeModelAuthMocks.getApiKeyForModel,
  getRuntimeAuthForModelCore: runtimeModelAuthMocks.getRuntimeAuthForModelCore,
  resolveProviderRuntimeApiKey: runtimeModelAuthMocks.resolveProviderRuntimeApiKey,
}));
vi.mock("../../agents/sandbox/context.js", () => sandboxContextMocks);

import { createPluginRuntime } from "./index.js";

describe("plugin runtime command execution", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    runtimeModelAuthMocks.getApiKeyForModel.mockReset();
    runtimeModelAuthMocks.getRuntimeAuthForModelCore.mockReset();
    runtimeModelAuthMocks.resolveProviderRuntimeApiKey.mockReset();
    sandboxContextMocks.resolveSandboxContext.mockReset();
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
      createPluginRuntime().system.requestHeartbeatNow({
        reason: "legacy-plugin",
        coalesceMs: 0,
      });
      await vi.advanceTimersByTimeAsync(1);
      const request = handler.mock.calls[0]?.[0] as
        | { source?: string; intent?: string; reason?: string }
        | undefined;
      expect(request?.source).toBe("other");
      expect(request?.intent).toBe("immediate");
      expect(request?.reason).toBe("legacy-plugin");
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });

  it("resolves thinking policy with configured model compat from runtime config", () => {
    setRuntimeConfigSnapshot({
      models: {
        providers: {
          gmn: {
            baseUrl: "https://gmn.example.com/v1",
            models: [
              {
                id: "gpt-5.4",
                name: "GPT 5.4 via GMN",
                reasoning: true,
                compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig);

    const runtime = createPluginRuntime();
    const policy = runtime.agent.resolveThinkingPolicy({
      provider: "gmn",
      model: "gpt-5.4",
    });

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

    const result = runtime.sandbox.resolveWorkspaceAuthority({
      config,
      agentId: "main",
      sessionKey: "agent:main:subagent:workboard-card",
    });

    expect(getSessionEntry).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:subagent:workboard-card",
    });
    expect(result.confinementError).toContain("outside the sandbox");
  });

  it("prepares the live sandbox before returning workspace authority", async () => {
    const runtime = createPluginRuntime();
    vi.spyOn(runtime.agent.session, "getSessionEntry").mockReturnValue(undefined);
    vi.spyOn(runtime.agent.session, "getSessionEntryAsync").mockResolvedValue(undefined);
    sandboxContextMocks.resolveSandboxContext.mockResolvedValue({ backendId: "docker" });
    const config: OpenClawConfig = {
      agents: {
        defaults: { sandbox: { mode: "all", scope: "session", workspaceAccess: "rw" } },
        entries: { main: { workspace: "/workspace" } },
      },
      tools: {
        elevated: { enabled: false },
        sandbox: { tools: { allow: ["read"] } },
      },
    };

    await expect(
      runtime.sandbox.prepareWorkspaceAuthority({
        config,
        agentId: "main",
        sessionKey: "agent:main:subagent:workboard-card",
        workspaceDir: "/workspace",
      }),
    ).resolves.toEqual({ sandboxed: true, workspaceAccess: "rw" });
    expect(sandboxContextMocks.resolveSandboxContext).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        agentId: "main",
        sessionKey: "agent:main:subagent:workboard-card",
        workspaceDir: "/workspace",
        requireCurrentConfig: true,
        preparedRuntimeStatus: expect.objectContaining({ sandboxed: true, sandboxRequired: false }),
        assertCurrent: expect.any(Function),
      }),
    );
  });

  it("refuses stale sandbox authority before provisioning after a policy change", async () => {
    const runtime = createPluginRuntime();
    let entry: SessionEntry = { sessionId: "sandbox-policy", updatedAt: 1 };
    vi.spyOn(runtime.agent.session, "getSessionEntry").mockImplementation(() => entry);
    vi.spyOn(runtime.agent.session, "getSessionEntryAsync").mockResolvedValue(
      structuredClone(entry),
    );
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const provision = vi.fn();
    sandboxContextMocks.resolveSandboxContext.mockImplementation(
      async (params: Parameters<typeof resolveSandboxContext>[0]) => {
        params.assertCurrent?.();
        entered.resolve();
        await release.promise;
        params.assertCurrent?.();
        provision();
        return null;
      },
    );
    const config: OpenClawConfig = {
      agents: {
        defaults: { sandbox: { mode: "all", scope: "session", workspaceAccess: "rw" } },
        entries: { main: { workspace: "/workspace" } },
      },
      tools: { elevated: { enabled: false }, sandbox: { tools: { allow: ["read"] } } },
    };
    const preparation = runtime.sandbox.prepareWorkspaceAuthority({
      config,
      agentId: "main",
      sessionKey: "agent:main:subagent:sandbox-policy",
      workspaceDir: "/workspace",
    });
    const rejected = expect(preparation).rejects.toThrow(
      "Session workspace authority changed during sandbox preparation",
    );
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        preparation,
        "sandbox preparation did not enter",
      );
      entry = { ...entry, sandboxMode: "off" };
    } finally {
      release.resolve();
    }
    await rejected;
    expect(provision).not.toHaveBeenCalled();
  });

  it("modelAuth wrappers preserve workspace scope while stripping credential steering", async () => {
    const runtime = createPluginRuntime();
    const model = {
      id: "workspace-cloud/model",
      provider: "workspace-cloud",
      api: "openai-responses",
      baseUrl: "https://workspace-cloud.example/v1",
    };
    const cfg = { plugins: { allow: ["workspace-cloud"] } } as OpenClawConfig;
    runtimeModelAuthMocks.getApiKeyForModel.mockResolvedValue({
      apiKey: "model-key",
      source: "workspace cloud credentials",
      mode: "api-key",
    });
    runtimeModelAuthMocks.getRuntimeAuthForModelCore.mockResolvedValue({
      apiKey: "runtime-key",
      source: "workspace cloud runtime credentials",
      mode: "api-key",
    });
    runtimeModelAuthMocks.resolveProviderRuntimeApiKey.mockResolvedValue({
      apiKey: "provider-key",
      source: "workspace cloud credentials",
      mode: "api-key",
    });

    const modelAuth = await runtime.modelAuth.getApiKeyForModel({
      model: model as never,
      cfg,
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
      store: { version: 1, profiles: {} },
    } as never);
    expect(modelAuth.apiKey).toBe("model-key");
    const runtimeAuth = await runtime.modelAuth.getRuntimeAuthForModel({
      model: model as never,
      cfg,
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
      store: { version: 1, profiles: {} },
    } as never);
    expect(runtimeAuth.apiKey).toBe("runtime-key");

    const providerAuth = await runtime.modelAuth.resolveApiKeyForProvider({
      provider: "workspace-cloud",
      cfg,
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
      store: { version: 1, profiles: {} },
    } as never);
    expect(providerAuth.apiKey).toBe("provider-key");

    expect(runtimeModelAuthMocks.getApiKeyForModel).toHaveBeenCalledWith({
      model,
      cfg,
      workspaceDir: "/tmp/workspace",
    });
    expect(runtimeModelAuthMocks.getRuntimeAuthForModelCore).toHaveBeenCalledWith({
      model,
      cfg,
      workspaceDir: "/tmp/workspace",
    });
    expect(runtimeModelAuthMocks.resolveProviderRuntimeApiKey).toHaveBeenCalledWith({
      provider: "workspace-cloud",
      cfg,
      workspaceDir: "/tmp/workspace",
    });
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
