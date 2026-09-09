import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCurrentPluginMetadataSnapshot,
  setCurrentPluginMetadataSnapshot,
} from "../../plugins/current-plugin-metadata-snapshot.js";
import { resolveInstalledPluginIndexPolicyHash } from "../../plugins/installed-plugin-index-policy.js";
import { getPluginRuntimeGenerationRegistry } from "../../plugins/runtime/generation-scope.js";
import { runPreparedReply } from "./get-reply-run.js";
import { bindPreparedReplyDispatchRuntime } from "./prepared-reply-dispatch-context.js";

const mocks = vi.hoisted(() => ({
  acquireRuntime: vi.fn(),
  execute: vi.fn(),
  prepareAdmission: vi.fn(),
  prepareContext: vi.fn(),
}));

vi.mock("../../agents/prepared-model-runtime.js", () => ({
  acquireAgentRunPreparedModelRuntime: mocks.acquireRuntime,
}));
vi.mock("./get-reply-run-context.js", () => ({
  prepareReplyRunContext: mocks.prepareContext,
}));
vi.mock("./get-reply-run-admission.js", () => ({
  prepareReplyRunAdmission: mocks.prepareAdmission,
}));
vi.mock("./get-reply-run-execute.js", () => ({
  executePreparedReplyRun: mocks.execute,
}));

describe("runPreparedReply prepared metadata", () => {
  beforeEach(() => {
    setCurrentPluginMetadataSnapshot(undefined);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps the admitted Gateway generation active through a different reply workspace", async () => {
    const config = {};
    const workspaceDir = "/tmp/openclaw-reply-workspace";
    const gatewayWorkspaceDir = "/tmp/openclaw-configured-workspace";
    const metadataSnapshot = {
      index: { plugins: [] },
      pluginIds: undefined,
      policyHash: resolveInstalledPluginIndexPolicyHash(config),
      workspaceDir: gatewayWorkspaceDir,
    } as never;
    const pluginRegistry = { registrations: [] } as never;
    const pluginGeneration = {
      configuredCatalogEntries: [],
      inlineProviderModels: [],
      pluginMetadataSnapshot: metadataSnapshot,
      pluginRegistry,
    } as never;
    const release = vi.fn();
    mocks.prepareContext.mockResolvedValue({
      kind: "run",
      params: { cfg: config },
      workspaceDir,
    });
    mocks.acquireRuntime.mockImplementation(async (_input, options) => ({
      snapshot: {
        config,
        metadataSnapshot: options.pluginGeneration.pluginMetadataSnapshot,
        pluginRegistry: options.pluginGeneration.pluginRegistry,
        workspaceDir,
      },
      release,
    }));
    let admissionSnapshot: unknown;
    let admissionRegistry: unknown;
    mocks.prepareAdmission.mockImplementation(async () => {
      admissionSnapshot = getCurrentPluginMetadataSnapshot({ config, workspaceDir });
      admissionRegistry = getPluginRuntimeGenerationRegistry();
      return { kind: "run" };
    });
    let executionSnapshot: unknown;
    let executionRegistry: unknown;
    mocks.execute.mockImplementation(async () => {
      executionSnapshot = getCurrentPluginMetadataSnapshot({ config, workspaceDir });
      executionRegistry = getPluginRuntimeGenerationRegistry();
      return { text: "ok" };
    });

    const run = bindPreparedReplyDispatchRuntime(
      {
        agentId: "main",
        agentDir: "/tmp/openclaw-reply-agent",
        workspaceDir: gatewayWorkspaceDir,
        config,
        pluginGeneration,
      } as never,
      async () => await runPreparedReply({} as never),
    );

    await expect(run()).resolves.toEqual({ text: "ok" });
    expect(mocks.acquireRuntime).toHaveBeenCalledWith(
      {
        config,
        agentId: "main",
        agentDir: "/tmp/openclaw-reply-agent",
        workspaceDir,
      },
      { pluginGeneration },
    );
    expect(admissionSnapshot).toBe(metadataSnapshot);
    expect(executionSnapshot).toBe(metadataSnapshot);
    expect(admissionRegistry).toBe(pluginRegistry);
    expect(executionRegistry).toBe(pluginRegistry);
    expect(release).toHaveBeenCalledOnce();
    expect(getCurrentPluginMetadataSnapshot({ config, workspaceDir })).toBeUndefined();
    expect(getPluginRuntimeGenerationRegistry()).toBeUndefined();
  });

  it("sanitizes prepared reply run owner paths before acquiring a runtime lease", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", "/home/openclaw/.openclaw");
    vi.stubEnv("HOME", "/home/openclaw");
    const config = {
      channels: { msteams: {} },
      agents: {
        entries: {
          "r-harris": {
            model: "openai/gpt-5.5",
            workspace: "/srv/openclaw/data/employee-agents/r-harris/workspace",
            agentDir: "/srv/openclaw/data/employee-agents/r-harris/agent",
          },
        },
      },
    };
    const pluginGeneration = {
      configuredCatalogEntries: [],
      inlineProviderModels: [],
      pluginMetadataSnapshot: {
        index: { plugins: [] },
        policyHash: resolveInstalledPluginIndexPolicyHash(config),
      },
    } as never;
    const release = vi.fn();
    mocks.prepareContext.mockResolvedValue({
      kind: "run",
      params: { cfg: config },
      promptSessionCtx: { OriginatingChannel: "msteams" },
      workspaceDir: "/srv/openclaw/data/employee-agents/r-harris/workspace",
    });
    mocks.acquireRuntime.mockResolvedValue({
      snapshot: {
        config,
        metadataSnapshot: pluginGeneration.pluginMetadataSnapshot,
        workspaceDir: "/home/openclaw/.openclaw/agents/r-harris/workspace",
      },
      release,
    });
    mocks.prepareAdmission.mockResolvedValue({ kind: "run" });
    mocks.execute.mockResolvedValue({ text: "ok" });

    const run = bindPreparedReplyDispatchRuntime(
      {
        agentId: "r-harris",
        agentDir: "/srv/openclaw/data/employee-agents/r-harris/agent",
        workspaceDir: "/srv/openclaw/data/employee-agents/r-harris/workspace",
        config,
        pluginGeneration,
      } as never,
      async () => await runPreparedReply({} as never),
    );

    await expect(run()).resolves.toEqual({ text: "ok" });
    expect(mocks.acquireRuntime).toHaveBeenCalledWith(
      {
        config,
        agentId: "r-harris",
        agentDir: "/home/openclaw/.openclaw/agents/r-harris/agent",
        workspaceDir: "/home/openclaw/.openclaw/agents/r-harris/workspace",
      },
      { pluginGeneration },
    );
    const [leaseInput] = mocks.acquireRuntime.mock.calls[0] ?? [];
    expect((leaseInput as { agentDir?: string }).agentDir).not.toContain("/srv/openclaw");
    expect((leaseInput as { workspaceDir?: string }).workspaceDir).not.toContain("/srv/openclaw");
  });
});
