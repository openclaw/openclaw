import { expect, it, vi } from "vitest";
import { getPreparedModelRuntimePluginGeneration } from "../../agents/prepared-model-runtime-generation-scope.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { setCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "../../plugins/installed-plugin-index-policy.js";
import { getPluginExecutionFrame } from "../../plugins/plugin-instance-invocation.js";
import { getPluginRuntimeGenerationRegistry } from "../../plugins/runtime/generation-scope.js";
import { runPreparedReply } from "./get-reply-run.js";
import { baseParams } from "./get-reply-run.test-support.js";
import { bindPreparedReplyDispatchRuntime } from "./prepared-reply-dispatch-context.js";
import { expectCallCounts } from "./reply-contract.test-support.js";

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

it("keeps the admitted Gateway generation active through a different reply workspace", async () => {
  setCurrentPluginMetadataSnapshot(undefined);
  vi.clearAllMocks();
  const config = {};
  const workspaceDir = "/tmp/openclaw-reply-workspace";
  const gatewayWorkspaceDir = "/tmp/openclaw-configured-workspace";
  const agent = { agentId: "main", agentDir: "/tmp/openclaw-reply-agent" };
  const model = { provider: "selected", model: "model" };
  const metadataSnapshot = {
    index: { plugins: [] },
    policyHash: resolveInstalledPluginIndexPolicyHash(config),
    workspaceDir: gatewayWorkspaceDir,
  } as never;
  const pluginGeneration = {
    remoteCatalog: null,
    pluginMetadataSnapshot: metadataSnapshot,
  };
  const release = vi.fn(async () => {});
  const selectedGeneration = { ...pluginGeneration, pluginRegistry: { selected: true } };
  mocks.prepareContext.mockResolvedValue({
    kind: "ready",
    params: { cfg: config, ...model },
    thinkingRuntime: "selected-harness",
    workspaceDir,
  });
  mocks.acquireRuntime.mockImplementation(async (_input, options) => ({
    snapshot: {
      config,
      metadataSnapshot: options.pluginGeneration.pluginMetadataSnapshot,
      pluginRegistry: selectedGeneration.pluginRegistry,
      workspaceDir,
    },
    [Symbol.asyncDispose]: release,
    pluginGeneration: selectedGeneration,
  }));
  const inSelectedScope = async <T>(result: T) => {
    expect(getPluginExecutionFrame()?.retentionOwner).toMatchObject({
      agentId: "main",
      sessionKey: "fixture-session",
    });
    expect(getCurrentPluginMetadataSnapshot({ config, workspaceDir })).toBe(metadataSnapshot);
    expect(getPluginRuntimeGenerationRegistry()).toBe(selectedGeneration.pluginRegistry);
    expect(getPreparedModelRuntimePluginGeneration()).toBe(selectedGeneration);
    return result;
  };
  mocks.prepareAdmission.mockImplementation(() => inSelectedScope({ kind: "ready" }));
  mocks.execute.mockImplementation(() => inSelectedScope({ text: "ok" }));
  const preparedInput = baseParams({
    cfg: config,
    sessionCtx: {},
    ctx: {},
    agentId: agent.agentId,
    sessionKey: "fixture-session",
    workspaceDir,
    ...model,
  });

  const run = bindPreparedReplyDispatchRuntime(
    {
      ...agent,
      workspaceDir: gatewayWorkspaceDir,
      config,
      pluginGeneration,
    } as never,
    () => runPreparedReply(preparedInput),
  );

  await expect(run()).resolves.toEqual({ text: "ok" });
  expect(mocks.acquireRuntime).toHaveBeenCalledWith(
    {
      config,
      ...agent,
      allowGatewaySubagentBinding: true,
      workspaceDir,
      runtimePluginSelections: [
        { provider: "selected", modelId: "model", runtime: "selected-harness" },
      ],
    },
    { catalogMode: "static", pluginGeneration },
  );
  expectCallCounts(1, mocks.prepareAdmission, mocks.execute, release);
  expect(getCurrentPluginMetadataSnapshot({ config, workspaceDir })).toBeUndefined();
  expect(getPluginRuntimeGenerationRegistry()).toBeUndefined();
  expect(getPreparedModelRuntimePluginGeneration()).toBeUndefined();
  expect(getPluginExecutionFrame()?.retentionOwner).toBeUndefined();
});
