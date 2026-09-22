/**
 * Gateway startup orchestration tests.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/config.js";

const prepareModelRuntimeSnapshotMock = vi.fn(async (_params: unknown) => ({}));
const refreshPreparedModelRuntimeSnapshotsMock = vi.fn<
  typeof import("../agents/prepared-model-runtime.js").refreshPreparedModelRuntimeSnapshots
>(async () => {});

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentDir: () => "/tmp/agent",
  resolveAgentWorkspaceDir: () => "/tmp/workspace",
  resolveDefaultAgentId: () => "default",
}));

vi.mock("../agents/prepared-model-runtime.js", () => ({
  publishPreparedModelRuntimeSnapshot: (params: unknown) => prepareModelRuntimeSnapshotMock(params),
  refreshPreparedModelRuntimeSnapshots: refreshPreparedModelRuntimeSnapshotsMock,
}));

let publishConfiguredModelRuntimeSnapshots: typeof import("./server-startup-model-runtime.js").publishConfiguredModelRuntimeSnapshots;
let hydrateConfiguredExternalCliAuth: typeof import("./server-startup-model-runtime.js").hydrateConfiguredExternalCliAuth;

describe("gateway startup model runtime publication", () => {
  beforeAll(async () => {
    ({ publishConfiguredModelRuntimeSnapshots, hydrateConfiguredExternalCliAuth } =
      await import("./server-startup-model-runtime.js"));
  });

  beforeEach(() => {
    prepareModelRuntimeSnapshotMock.mockClear();
    refreshPreparedModelRuntimeSnapshotsMock.mockClear();
  });

  it("publishes an explicit configured primary model", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
          },
        },
      },
    } as OpenClawConfig;

    await publishConfiguredModelRuntimeSnapshots({
      cfg,
    });

    expect(refreshPreparedModelRuntimeSnapshotsMock).toHaveBeenCalledWith(cfg, {
      allowGatewaySubagentBinding: true,
      gatewayLifecycle: true,
      startup: true,
      catalogMode: "static",
    });
  });

  it("hydrates configured external CLI auth before prepared owner publication", async () => {
    const cfg = {} as OpenClawConfig;
    const hydrate = vi.fn();

    await hydrateConfiguredExternalCliAuth({
      getConfig: () => cfg,
      log: { warn: vi.fn() },
      deps: {
        listAgentIds: () => ["main", "secondary"],
        resolveAgentDir: (_config, agentId) => `/tmp/${agentId}`,
        collectConfiguredRefs: (_config, agentId) => [
          { value: agentId === "main" ? "openai/gpt-5.4" : "anthropic/sonnet-4.6" },
        ],
        hydrate,
      },
    });

    expect(hydrate).toHaveBeenCalledTimes(2);
    expect(hydrate).toHaveBeenCalledWith(cfg, "/tmp/main", ["openai"]);
    expect(hydrate).toHaveBeenCalledWith(cfg, "/tmp/secondary", ["anthropic"]);
    expect(refreshPreparedModelRuntimeSnapshotsMock).not.toHaveBeenCalled();
  });

  it("publishes the default catalog when no explicit primary model is configured", async () => {
    const cfg = {} as OpenClawConfig;
    await publishConfiguredModelRuntimeSnapshots({
      cfg,
    });

    expect(refreshPreparedModelRuntimeSnapshotsMock).toHaveBeenCalledWith(cfg, {
      allowGatewaySubagentBinding: true,
      gatewayLifecycle: true,
      startup: true,
      catalogMode: "static",
    });
  });

  it("publishes lifecycle owners for configured CLI backends", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "codex-cli/gpt-5.5",
          },
        },
      },
    } as OpenClawConfig;
    await publishConfiguredModelRuntimeSnapshots({ cfg });

    expect(refreshPreparedModelRuntimeSnapshotsMock).toHaveBeenCalledWith(cfg, {
      allowGatewaySubagentBinding: true,
      gatewayLifecycle: true,
      startup: true,
      catalogMode: "static",
    });
  });

  it("preserves the explicit startup workspace in the published default owner", async () => {
    const cfg = {} as OpenClawConfig;
    await publishConfiguredModelRuntimeSnapshots({
      cfg,
      workspaceDir: "/tmp/explicit-workspace",
    });

    expect(refreshPreparedModelRuntimeSnapshotsMock).toHaveBeenCalledWith(cfg, {
      allowGatewaySubagentBinding: true,
      gatewayLifecycle: true,
      startup: true,
      catalogMode: "static",
      defaultWorkspaceDir: "/tmp/explicit-workspace",
    });
  });

  it("propagates lifecycle catalog preparation failure", async () => {
    const error = new Error("models write failed");
    refreshPreparedModelRuntimeSnapshotsMock.mockRejectedValueOnce(error);

    await expect(
      publishConfiguredModelRuntimeSnapshots({
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "codex/gpt-5.4",
              },
            },
          },
        } as OpenClawConfig,
      }),
    ).rejects.toBe(error);
  });
  it("passes a current-config supplier after loading the prepared runtime", async () => {
    const initialConfig = { ui: { theme: "light" } } as never;
    const nextConfig = { ui: { theme: "dark" } } as never;
    let currentConfig = initialConfig;

    const publication = publishConfiguredModelRuntimeSnapshots({
      cfg: initialConfig,
      getConfig: () => currentConfig,
    } as never);
    currentConfig = nextConfig;
    await publication;

    const getConfig = refreshPreparedModelRuntimeSnapshotsMock.mock.calls[0]?.[0];
    expect(getConfig).toBeTypeOf("function");
    await expect(Promise.resolve((getConfig as () => unknown)())).resolves.toBe(nextConfig);
  });

  it("hydrates external CLI auth from the config supplied to model publication", async () => {
    const initialConfig = { ui: { theme: "light" } } as never;
    const nextConfig = { ui: { theme: "dark" } } as never;
    let currentConfig = initialConfig;
    const depsReady = createDeferred<{
      listAgentIds: () => string[];
      resolveAgentDir: () => string;
      collectConfiguredRefs: ReturnType<typeof vi.fn>;
      hydrate: ReturnType<typeof vi.fn>;
    }>();
    const collectConfiguredRefs = vi.fn(() => [{ value: "openai/gpt-5.4" }]);
    const hydrate = vi.fn();

    const hydration = hydrateConfiguredExternalCliAuth({
      getConfig: () => currentConfig,
      log: { warn: vi.fn() },
      deps: depsReady.promise,
    } as never);
    currentConfig = nextConfig;
    depsReady.resolve({
      listAgentIds: () => ["default"],
      resolveAgentDir: () => "/tmp/default-agent",
      collectConfiguredRefs,
      hydrate,
    });

    await expect(hydration).resolves.toBe(nextConfig);
    expect(collectConfiguredRefs).toHaveBeenCalledWith(nextConfig, "default");
    expect(hydrate).toHaveBeenCalledWith(nextConfig, "/tmp/default-agent", ["openai"]);
  });

  it("drops a stale plugin generation after loading the prepared runtime", async () => {
    let current = true;
    const publication = publishConfiguredModelRuntimeSnapshots({
      cfg: {},
      isCurrent: () => current,
    } as never);
    current = false;

    await publication;

    expect(refreshPreparedModelRuntimeSnapshotsMock).not.toHaveBeenCalled();
  });

  it("threads plugin claim loss through async model config publication", async () => {
    const configStarted = createDeferred();
    const releaseConfig = createDeferred();
    let current = true;
    refreshPreparedModelRuntimeSnapshotsMock.mockImplementationOnce(
      async (getConfig: unknown, options: unknown) => {
        expect(getConfig).toBeTypeOf("function");
        const config = (getConfig as () => Promise<unknown>)();
        await configStarted.promise;
        expect(options).toMatchObject({ isPublicationCurrent: expect.any(Function) });
        await config;
        expect((options as { isPublicationCurrent: () => boolean }).isPublicationCurrent()).toBe(
          false,
        );
      },
    );
    const publication = publishConfiguredModelRuntimeSnapshots({
      cfg: {},
      getConfig: async () => {
        configStarted.resolve();
        await releaseConfig.promise;
        return {};
      },
      isCurrent: () => current,
    } as never);

    await configStarted.promise;
    current = false;
    releaseConfig.resolve();
    await publication;

    expect(refreshPreparedModelRuntimeSnapshotsMock).toHaveBeenCalledOnce();
  });
});
