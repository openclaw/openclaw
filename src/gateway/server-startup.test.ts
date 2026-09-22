/**
 * Gateway startup orchestration tests.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const prepareModelRuntimeSnapshotMock = vi.fn(async (_params: unknown) => ({}));
const refreshPreparedModelRuntimeSnapshotsMock = vi.fn(
  async (
    _cfg: OpenClawConfig,
    _options?: {
      gatewayLifecycle?: boolean;
      defaultWorkspaceDir?: string;
      catalogMode?: "live" | "static";
      allowGatewaySubagentBinding?: boolean;
      isPublicationCurrent?: () => boolean;
    },
  ) => {},
);

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentDir: () => "/tmp/agent",
  resolveAgentWorkspaceDir: () => "/tmp/workspace",
  resolveDefaultAgentId: () => "default",
}));

vi.mock("../agents/prepared-model-runtime.js", () => ({
  publishPreparedModelRuntimeSnapshot: (params: unknown) => prepareModelRuntimeSnapshotMock(params),
  refreshPreparedModelRuntimeSnapshots: (
    cfg: OpenClawConfig,
    options?: {
      gatewayLifecycle?: boolean;
      defaultWorkspaceDir?: string;
      catalogMode?: "live" | "static";
      allowGatewaySubagentBinding?: boolean;
      isPublicationCurrent?: () => boolean;
    },
  ) => refreshPreparedModelRuntimeSnapshotsMock(cfg, options),
}));

let publishConfiguredModelRuntimeSnapshots: typeof import("./server-startup-post-attach.js").testing.publishConfiguredModelRuntimeSnapshots;
let hydrateConfiguredExternalCliAuth: typeof import("./server-startup-post-attach.js").testing.hydrateConfiguredExternalCliAuth;

describe("gateway startup model runtime publication", () => {
  beforeAll(async () => {
    ({
      testing: { publishConfiguredModelRuntimeSnapshots, hydrateConfiguredExternalCliAuth },
    } = await import("./server-startup-post-attach.js"));
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
});
