import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/config.js";
import type { NodeHostClient } from "./client.js";
import { NodeWorkerContainerContextMismatchError } from "./node-worker-container-lifecycle.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import { prepareNodeHostRuntime } from "./runtime.js";

const mocks = vi.hoisted(() => ({
  checkWorkspaceAdmission: vi.fn(async () => undefined),
  closeWorkerSupervisor: vi.fn<() => Promise<void>>(async () => undefined),
  initializeWorkerSupervisor: vi.fn(async () => undefined),
  handleInvoke: vi.fn(async () => undefined),
  resolveContainerEngine: vi.fn(async (_options?: { env?: NodeJS.ProcessEnv }) => ({
    id: "docker" as const,
    command: "docker",
    target: "e".repeat(64),
  })),
}));

vi.mock("../infra/path-env.js", () => ({ ensureOpenClawCliOnPath: vi.fn() }));
vi.mock("./invoke.js", () => ({ handleInvoke: mocks.handleInvoke }));
vi.mock("./mcp.js", () => ({
  startNodeHostMcpManager: vi.fn(async () => ({
    descriptors: [],
    close: vi.fn(async () => undefined),
  })),
}));
vi.mock("./node-worker-container-engine.js", () => ({
  resolveNodeWorkerContainerEngine: mocks.resolveContainerEngine,
}));
vi.mock("./node-worker-supervisor.js", () => ({
  createNodeWorkerSupervisor: vi.fn(() => ({
    initialize: mocks.initializeWorkerSupervisor,
    retireIdle: vi.fn(async () => undefined),
    close: mocks.closeWorkerSupervisor,
  })),
}));
vi.mock("./node-worker-workspace.js", () => ({
  NodeWorkerWorkspaceRuntime: class {
    readonly exec = vi.fn();
    readonly checkAdmission = mocks.checkWorkspaceAdmission;
  },
}));
vi.mock("./plugin-node-host.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugin-node-host.js")>()),
  ensureNodeHostPluginRegistry: vi.fn(async () => undefined),
  hasRegisteredNodeHostCommandActiveWork: vi.fn(() => false),
  isRegisteredNodeHostCommandDuplex: vi.fn(() => false),
  notifyRegisteredNodeHostCommandDisconnect: vi.fn(async () => undefined),
  listRegisteredNodeHostCapsAndCommands: vi.fn(() => ({
    caps: [],
    commands: [],
    nodePluginTools: [],
  })),
}));
vi.mock("./skills.js", () => ({ scanNodeHostedSkills: vi.fn(() => []) }));

const client = { request: vi.fn(async () => ({})) } as unknown as NodeHostClient;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkWorkspaceAdmission.mockReset().mockResolvedValue(undefined);
  mocks.closeWorkerSupervisor.mockReset().mockResolvedValue(undefined);
  mocks.initializeWorkerSupervisor.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

function prepareWorkerRuntime(
  isolation?: "container",
  options: {
    enabled?: boolean;
    forceWorkerRuns?: boolean;
    platform?: NodeJS.Platform;
    containerImage?: string;
  } = {},
) {
  const { enabled = true, containerImage, ...runtimeOptions } = options;
  return prepareNodeHostRuntime({
    config: {
      nodeHost: { skills: { enabled: false }, workerRuns: { enabled, isolation, containerImage } },
    },
    env: { PATH: "/usr/bin" },
    ...runtimeOptions,
  });
}

function configThatRejectsModelAccess(workerRuns: {
  enabled: boolean;
  isolation?: "container";
}): OpenClawConfig {
  const config: OpenClawConfig = {
    nodeHost: { skills: { enabled: false }, workerRuns },
  };
  Object.defineProperty(config, "models", {
    get() {
      throw new Error("native inference inspected models outside its launch boundary");
    },
  });
  return config;
}

describe("node-host worker manifest", () => {
  it.each([
    { name: "disabled worker hosting", enabled: false },
    { name: "rejected worker hosting", enabled: true, admissionFailure: true },
    { name: "container-isolated worker hosting", enabled: true, isolation: "container" as const },
  ])(
    "does not inspect models or advertise native inference for $name",
    async ({ enabled, isolation, admissionFailure }) => {
      if (admissionFailure) {
        mocks.checkWorkspaceAdmission.mockRejectedValueOnce(
          new Error("workspace admission failed"),
        );
      }
      const prepared = await prepareNodeHostRuntime({
        config: configThatRejectsModelAccess({ enabled, isolation }),
        env: { PATH: "/usr/bin" },
        platform: "linux",
      });
      expect(prepared.nativeInferenceEnabled).toBe(false);

      const runtime = prepared.start({ client });
      await runtime.close();
    },
  );

  it("advertises native inference after unisolated worker hosting is admitted", async () => {
    const prepared = await prepareNodeHostRuntime({
      config: {
        nodeHost: {
          skills: { enabled: false },
          workerRuns: { enabled: true, isolation: "none" },
        },
        models: {
          providers: {
            local: {
              apiKey: "synthetic-native-key",
              api: "openai-completions",
              baseUrl: "https://model.example.test/v1",
              models: [
                {
                  id: "model-1",
                  name: "Model 1",
                  contextWindow: 8192,
                  maxTokens: 1024,
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
      },
      env: { PATH: "/usr/bin" },
      platform: "linux",
    });
    expect(prepared.nativeInferenceEnabled).toBe(true);

    const runtime = prepared.start({ client });
    await runtime.close();
  });

  it("keeps container hosting opted out without probing an engine or reporting a failure", async () => {
    const prepared = await prepareWorkerRuntime("container", { enabled: false });
    const onWorkerHostingDisabled = vi.fn();
    const runtime = prepared.start({ client, onWorkerHostingDisabled });
    try {
      expect(prepared.workerHostingEnabled).toBe(false);
      expect(prepared.workerHostingDisabledReason).toBeUndefined();
      expect(mocks.resolveContainerEngine).not.toHaveBeenCalled();
      expect(createNodeWorkerSupervisor).not.toHaveBeenCalled();
      expect(onWorkerHostingDisabled).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it("disables hosting before engine discovery when workspace admission fails", async () => {
    const reason =
      "State directory /srv/node-state is group-writable; run chmod go-w /srv/node-state";
    mocks.checkWorkspaceAdmission.mockRejectedValueOnce(new Error(reason));
    const prepared = await prepareWorkerRuntime("container");
    expect(prepared.workerHostingEnabled).toBe(false);
    expect(prepared.workerHostingDisabledReason).toBe(reason);
    expect(mocks.resolveContainerEngine).not.toHaveBeenCalled();
    const runtime = prepared.start({ client });
    expect(createNodeWorkerSupervisor).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("disables container-isolated hosting on Windows before probing or advertising an engine", async () => {
    const prepared = await prepareWorkerRuntime("container", { platform: "win32" });

    expect(prepared.workerHostingEnabled).toBe(false);
    expect(prepared.workerHostingDisabledReason).toMatch(/windows.*(?:linux|macos)/iu);
    expect(mocks.resolveContainerEngine).not.toHaveBeenCalled();
    expect(createNodeWorkerSupervisor).not.toHaveBeenCalled();
    const runtime = prepared.start({ client });
    expect(createNodeWorkerSupervisor).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("resolves the container engine once and passes its exact identity to the supervisor", async () => {
    mocks.initializeWorkerSupervisor.mockImplementationOnce(async () => {
      const options = vi.mocked(createNodeWorkerSupervisor).mock.calls[0]?.[0];
      options?.onCapacityChanged?.({ total: 3, available: 0 });
      options?.onCapacityChanged?.({ total: 3, available: 3 });
    });
    const prepared = await prepareWorkerRuntime("container", {
      containerImage: "registry.example/openclaw-worker:22",
    });

    expect(prepared.workerHostingEnabled).toBe(true);
    expect(mocks.resolveContainerEngine).toHaveBeenCalledOnce();
    expect(mocks.initializeWorkerSupervisor).toHaveBeenCalledOnce();
    const onRunnerCapacityChanged = vi.fn();
    const runtime = prepared.start({ client, onRunnerCapacityChanged });

    expect(createNodeWorkerSupervisor).toHaveBeenCalledWith(
      expect.objectContaining({
        containerEngine: { id: "docker", command: "docker", target: "e".repeat(64) },
        containerImage: "registry.example/openclaw-worker:22",
      }),
    );
    expect(mocks.resolveContainerEngine).toHaveBeenCalledOnce();
    expect(mocks.initializeWorkerSupervisor).toHaveBeenCalledOnce();
    expect(onRunnerCapacityChanged).toHaveBeenCalledExactlyOnceWith({ total: 3, available: 3 });
    await runtime.close();
  });

  it("retains container hosting after failed reconciliation and recovers its capacity on start", async () => {
    mocks.initializeWorkerSupervisor
      .mockRejectedValueOnce(new Error("orphan sweep failed"))
      .mockImplementationOnce(async () => {
        const options = vi.mocked(createNodeWorkerSupervisor).mock.calls[0]?.[0];
        options?.onCapacityChanged?.({ total: 2, available: 0 });
        options?.onCapacityChanged?.({ total: 2, available: 2 });
      });

    const prepared = await prepareWorkerRuntime("container");

    expect(prepared.workerHostingEnabled).toBe(true);
    expect(prepared.workerHostingDisabledReason).toBeUndefined();
    expect(mocks.closeWorkerSupervisor).not.toHaveBeenCalled();
    expect(mocks.initializeWorkerSupervisor).toHaveBeenCalledOnce();
    const onRunnerCapacityChanged = vi.fn();
    const runtime = prepared.start({ client, onRunnerCapacityChanged });

    await vi.waitFor(() =>
      expect(onRunnerCapacityChanged).toHaveBeenLastCalledWith({ total: 2, available: 2 }),
    );
    expect(onRunnerCapacityChanged.mock.calls).toEqual([
      [{ total: 2, available: 0 }],
      [{ total: 2, available: 2 }],
    ]);
    expect(mocks.initializeWorkerSupervisor).toHaveBeenCalledTimes(2);
    expect(createNodeWorkerSupervisor).toHaveBeenCalledOnce();
    await runtime.close();
    expect(mocks.closeWorkerSupervisor).toHaveBeenCalledOnce();
  });

  it("keeps a container engine-context mismatch permanently and actionably disabled", async () => {
    const mismatch = new NodeWorkerContainerContextMismatchError(
      "node worker launch launch-1 belongs to a different docker engine or daemon; restore its original engine context before enabling worker hosting",
    );
    mocks.initializeWorkerSupervisor.mockRejectedValueOnce(mismatch);

    const prepared = await prepareWorkerRuntime("container");

    expect(prepared.workerHostingEnabled).toBe(false);
    expect(prepared.workerHostingDisabledReason).toBe(mismatch.message);
    expect(mocks.initializeWorkerSupervisor).toHaveBeenCalledOnce();
    expect(mocks.closeWorkerSupervisor).toHaveBeenCalledOnce();
    const onRunnerCapacityChanged = vi.fn();
    const runtime = prepared.start({ client, onRunnerCapacityChanged });

    expect(createNodeWorkerSupervisor).toHaveBeenCalledOnce();
    expect(onRunnerCapacityChanged).not.toHaveBeenCalled();
    await runtime.invoke({ id: "after-mismatch", nodeId: "node-1", command: "system.which" });
    expect(await runtime.tryPauseForUpdate()).toBe(false);
    await runtime.close();
    expect(mocks.closeWorkerSupervisor).toHaveBeenCalledOnce();
  });

  it("keeps foreign container ownership busy after cleanup fails", async () => {
    const mismatch = new NodeWorkerContainerContextMismatchError(
      "node worker launch launch-1 belongs to a different docker engine or daemon; restore its original engine context before enabling worker hosting",
    );
    mocks.initializeWorkerSupervisor
      .mockRejectedValueOnce(new Error("launch journal temporarily unavailable"))
      .mockRejectedValueOnce(mismatch);
    const retired = createDeferred();
    mocks.closeWorkerSupervisor.mockImplementationOnce(async () => await retired.promise);

    const prepared = await prepareWorkerRuntime("container");

    expect(prepared.workerHostingEnabled).toBe(true);
    const onWorkerHostingDisabled = vi.fn();
    const runtime = prepared.start({ client, onWorkerHostingDisabled });

    await vi.waitFor(() =>
      expect(onWorkerHostingDisabled).toHaveBeenCalledExactlyOnceWith(mismatch.message),
    );
    expect(mocks.initializeWorkerSupervisor).toHaveBeenCalledTimes(2);
    expect(mocks.closeWorkerSupervisor).toHaveBeenCalledOnce();
    expect(await runtime.tryPauseForUpdate()).toBe(false);
    retired.reject(new Error("container cleanup failed"));
    await runtime.invoke({ id: "after-retirement", nodeId: "node-1", command: "system.which" });
    expect(mocks.handleInvoke).toHaveBeenCalledOnce();
    expect(await runtime.tryPauseForUpdate()).toBe(false);
    await runtime.close();
    expect(mocks.closeWorkerSupervisor).toHaveBeenCalledOnce();
  });

  it("retries non-container reconciliation after a bounded delay before publishing capacity", async () => {
    vi.useFakeTimers();
    mocks.initializeWorkerSupervisor
      .mockRejectedValueOnce(new Error("launch journal temporarily unavailable"))
      .mockImplementationOnce(async () => {
        const options = vi.mocked(createNodeWorkerSupervisor).mock.calls[0]?.[0];
        options?.onCapacityChanged?.({ total: 2, available: 2 });
      });
    const prepared = await prepareWorkerRuntime();
    const onRunnerCapacityChanged = vi.fn();
    const runtime = prepared.start({ client, onRunnerCapacityChanged });

    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.initializeWorkerSupervisor).toHaveBeenCalledOnce();
    expect(onRunnerCapacityChanged).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(mocks.initializeWorkerSupervisor).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    expect(mocks.initializeWorkerSupervisor).toHaveBeenCalledTimes(2);
    expect(onRunnerCapacityChanged).toHaveBeenCalledExactlyOnceWith({ total: 2, available: 2 });
    await runtime.close();
  });

  it("cancels pending reconciliation retries and closes its supervisor exactly once", async () => {
    vi.useFakeTimers();
    mocks.initializeWorkerSupervisor.mockRejectedValueOnce(new Error("launch journal unavailable"));
    const prepared = await prepareWorkerRuntime();
    const runtime = prepared.start({ client });
    await vi.advanceTimersByTimeAsync(0);

    const closing = runtime.close();
    expect(runtime.close()).toBe(closing);
    await closing;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mocks.initializeWorkerSupervisor).toHaveBeenCalledOnce();
    expect(mocks.closeWorkerSupervisor).toHaveBeenCalledOnce();
  });
});
