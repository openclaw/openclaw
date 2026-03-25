import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";

const writeConfigFileMock = vi.fn(async () => {});
const writeRestartSentinelMock = vi.fn(
  async (_payload: RestartSentinelPayload) => "/tmp/restart-sentinel.json",
);
const scheduleGatewaySigusr1RestartMock = vi.fn(() => ({ scheduled: true }));

const baseConfig = {
  gateway: {
    auth: { mode: "token", token: "test-token" },
    reload: { mode: "restart" },
  },
};

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: () => "/tmp/openclaw",
  resolveDefaultAgentId: () => "main",
}));

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: () => [],
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    createConfigIO: () => ({ configPath: "/tmp/openclaw.json" }),
    loadConfig: () => ({}),
    readConfigFileSnapshotForWrite: async () => ({
      snapshot: {
        path: "/tmp/openclaw.json",
        exists: true,
        raw: JSON.stringify(baseConfig),
        parsed: baseConfig,
        resolved: baseConfig,
        valid: true,
        config: baseConfig,
        issues: [],
        warnings: [],
        legacyIssues: [],
      },
      writeOptions: {},
    }),
    resolveConfigSnapshotHash: () => "snapshot-hash",
    validateConfigObjectWithPlugins: (config: unknown) => ({
      ok: true,
      config,
      issues: [],
    }),
    writeConfigFile: writeConfigFileMock,
  };
});

vi.mock("../../config/legacy.js", () => ({
  applyLegacyMigrations: (config: unknown) => ({ next: config }),
}));

vi.mock("../../config/redact-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/redact-snapshot.js")>();
  return {
    ...actual,
    redactConfigObject: (config: unknown) => config,
    restoreRedactedValues: (config: unknown) => ({ ok: true, result: config }),
  };
});

vi.mock("../../config/schema.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/schema.js")>();
  return {
    ...actual,
    buildConfigSchema: () => ({ uiHints: {} }),
  };
});

vi.mock("../../config/sessions.js", () => ({
  extractDeliveryInfo: () => ({ deliveryContext: undefined, threadId: undefined }),
}));

vi.mock("../../infra/restart-sentinel.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/restart-sentinel.js")>();
  return {
    ...actual,
    writeRestartSentinel: writeRestartSentinelMock,
  };
});

vi.mock("../../infra/restart.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/restart.js")>();
  return {
    ...actual,
    scheduleGatewaySigusr1Restart: scheduleGatewaySigusr1RestartMock,
  };
});

vi.mock("../../plugins/loader.js", () => ({
  loadOpenClawPlugins: () => ({ plugins: [] }),
}));

vi.mock("./validation.js", () => ({
  assertValidParams: () => true,
}));

beforeEach(() => {
  writeConfigFileMock.mockClear();
  writeRestartSentinelMock.mockClear();
  scheduleGatewaySigusr1RestartMock.mockClear();
  scheduleGatewaySigusr1RestartMock.mockReturnValue({ scheduled: true });
});

async function invokeConfigPatch(raw: Record<string, unknown>) {
  const { configHandlers } = await import("./config.js");
  let response:
    | {
        ok: boolean;
        payload?: Record<string, unknown>;
        error?: unknown;
      }
    | undefined;

  await configHandlers["config.patch"]({
    params: {
      raw: JSON.stringify(raw),
      baseHash: "snapshot-hash",
    },
    client: undefined,
    context: {
      logGateway: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    },
    respond: ((ok: boolean, payload?: unknown, error?: unknown) => {
      response = {
        ok,
        payload: (payload as Record<string, unknown> | undefined) ?? undefined,
        error,
      };
    }) as never,
  } as never);

  if (!response) {
    throw new Error("config.patch did not respond");
  }
  return response;
}

describe("config.patch restart scheduling", () => {
  it("uses the patched reload mode before deciding whether browser changes need SIGUSR1", async () => {
    const response = await invokeConfigPatch({
      gateway: {
        reload: {
          mode: "hybrid",
        },
      },
      browser: {
        profiles: {
          sandbox: {
            cdpUrl: "http://127.0.0.1:9222",
            color: "#0066CC",
          },
        },
      },
    });

    expect(response.ok).toBe(true);
    expect(writeConfigFileMock).toHaveBeenCalledTimes(1);
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(writeRestartSentinelMock).not.toHaveBeenCalled();
    expect(response.payload?.restart).toBeNull();
    expect(response.payload?.sentinel).toBeNull();
    expect(response.payload?.config).toMatchObject({
      gateway: {
        auth: { mode: "token", token: "test-token" },
        reload: { mode: "hybrid" },
      },
      browser: {
        profiles: {
          sandbox: {
            cdpUrl: "http://127.0.0.1:9222",
            color: "#0066CC",
          },
        },
      },
    });
  });

  it("still schedules restart and sentinel for restart-required paths", async () => {
    const response = await invokeConfigPatch({
      gateway: {
        port: 18888,
      },
    });

    expect(response.ok).toBe(true);
    expect(writeConfigFileMock).toHaveBeenCalledTimes(1);
    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledTimes(1);
    expect(writeRestartSentinelMock).toHaveBeenCalledTimes(1);
    expect(response.payload?.restart).toEqual({ scheduled: true });
    expect(response.payload?.sentinel).toMatchObject({
      path: "/tmp/restart-sentinel.json",
      payload: expect.objectContaining({
        kind: "config-patch",
        stats: expect.objectContaining({
          mode: "config.patch",
        }),
      }),
    });
  });
});
