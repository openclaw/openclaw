import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const prepareModelRuntimeSnapshotMock = vi.fn(async (_params: unknown) => ({}));
const collectConfiguredRefs = vi.fn((_config: OpenClawConfig, agentId: string) => [
  { value: agentId === "main" ? "openai/gpt-5.4" : "anthropic/sonnet-4.6" },
]);
const hydrate = vi.fn();
const refreshPreparedModelRuntimeSnapshotsMock = vi.fn<
  typeof import("../agents/prepared-model-runtime.js").refreshPreparedModelRuntimeSnapshots
>(async () => {});

vi.mock("../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-scope.js")>()),
  listAgentIds: () => ["main", "secondary"],
  resolveAgentDir: (_config: OpenClawConfig, agentId: string) => `/tmp/${agentId}`,
  resolveDefaultAgentDir: () => "/tmp/agent",
  resolveAgentWorkspaceDir: () => "/tmp/workspace",
  resolveDefaultAgentId: () => "default",
}));

vi.mock("../agents/prepared-model-runtime.configured.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/prepared-model-runtime.configured.js")>()),
  collectPreparedModelRuntimeConfiguredRefs: collectConfiguredRefs,
}));
vi.mock("../agents/auth-profiles/store-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/auth-profiles/store-runtime.js")>()),
  ensureAuthProfileStoreAsync: hydrate,
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
    collectConfiguredRefs.mockClear();
    hydrate.mockClear();
  });

  it.each([undefined, "/tmp/explicit-workspace"])(
    "publishes startup lifecycle owners with workspace %s",
    async (workspaceDir) => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
      };
      await publishConfiguredModelRuntimeSnapshots({ cfg, workspaceDir });
      expect(refreshPreparedModelRuntimeSnapshotsMock).toHaveBeenCalledWith(cfg, {
        allowGatewaySubagentBinding: true,
        gatewayLifecycle: true,
        joinSupersedingPublication: true,
        startup: true,
        catalogMode: "static",
        ...(workspaceDir ? { defaultWorkspaceDir: workspaceDir } : {}),
      });
    },
  );

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

    const hydration = hydrateConfiguredExternalCliAuth({
      getConfig: () => currentConfig,
      log: { warn: vi.fn() },
    } as never);
    currentConfig = nextConfig;

    await expect(hydration).resolves.toBe(nextConfig);
    expect(hydrate).toHaveBeenCalledTimes(2);
    for (const [agentId, provider] of [
      ["main", "openai"],
      ["secondary", "anthropic"],
    ]) {
      expect(collectConfiguredRefs).toHaveBeenCalledWith(nextConfig, agentId);
      expect(hydrate).toHaveBeenCalledWith(`/tmp/${agentId}`, {
        config: nextConfig,
        externalCli: {
          mode: "scoped",
          config: nextConfig,
          allowKeychainPrompt: false,
          providerIds: [provider],
        },
        allowKeychainPrompt: false,
        readOnly: true,
        syncExternalCli: false,
      });
    }
    expect(refreshPreparedModelRuntimeSnapshotsMock).not.toHaveBeenCalled();
  });
});
