import { beforeEach, describe, expect, it, vi } from "vitest";

const writeRestartSentinelMock = vi.fn();
const transitionRestartSentinelStatusMock = vi.fn();
const scheduleGatewaySigusr1RestartMock = vi.fn(() => ({ scheduled: true }));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: () => "/tmp/workspace",
  resolveDefaultAgentId: () => "main",
}));

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: () => [],
}));

vi.mock("../../config/config.js", () => ({
  createConfigIO: () => ({ configPath: "/tmp/config.json" }),
  loadConfig: () => ({}),
  parseConfigJson5: () => ({ ok: true, parsed: {} }),
  readConfigFileSnapshot: async () => ({ exists: true, valid: true, config: {} }),
  readConfigFileSnapshotForWrite: async () => ({
    snapshot: { exists: true, valid: true, config: {} },
    writeOptions: {},
  }),
  resolveConfigSnapshotHash: () => "base-hash",
  validateConfigObjectWithPlugins: () => ({ ok: true, config: {} }),
  writeConfigFile: async () => {},
}));

vi.mock("../../config/legacy.js", () => ({
  applyLegacyMigrations: () => ({ next: undefined }),
}));

vi.mock("../../config/merge-patch.js", () => ({
  applyMergePatch: () => ({}),
}));

vi.mock("../../config/redact-snapshot.js", () => ({
  redactConfigObject: (config: unknown) => config,
  redactConfigSnapshot: (snapshot: unknown) => snapshot,
  restoreRedactedValues: () => ({ ok: true, result: {} }),
}));

vi.mock("../../config/schema.js", () => ({
  buildConfigSchema: () => ({ uiHints: {}, properties: {} }),
  lookupConfigSchema: () => null,
}));

vi.mock("../../config/sessions.js", () => ({
  extractDeliveryInfo: () => ({ deliveryContext: undefined, threadId: undefined }),
}));

vi.mock("../../infra/restart-sentinel.js", () => ({
  formatDoctorNonInteractiveHint: () => "hint",
  transitionRestartSentinelStatus: (...args: unknown[]) =>
    transitionRestartSentinelStatusMock(...args),
  writeRestartSentinel: (...args: unknown[]) => writeRestartSentinelMock(...args),
}));

vi.mock("../../infra/restart.js", () => ({
  scheduleGatewaySigusr1Restart: (...args: unknown[]) => scheduleGatewaySigusr1RestartMock(...args),
}));

vi.mock("../../plugins/loader.js", () => ({
  loadOpenClawPlugins: () => ({ plugins: [] }),
}));

vi.mock("../config-reload.js", () => ({
  diffConfigPaths: () => [],
}));

vi.mock("../control-plane-audit.js", () => ({
  formatControlPlaneActor: () => "actor=test",
  resolveControlPlaneActor: () => ({ actor: "test", deviceId: "dev-1", clientIp: "127.0.0.1" }),
  summarizeChangedPaths: () => "none",
}));

vi.mock("../protocol/index.js", () => ({
  ErrorCodes: { INVALID_REQUEST: -32600 },
  errorShape: (_code: number, message: string) => ({ message }),
  formatValidationErrors: () => "",
  validateConfigApplyParams: () => true,
  validateConfigGetParams: () => true,
  validateConfigPatchParams: () => true,
  validateConfigSchemaLookupParams: () => true,
  validateConfigSchemaLookupResult: Object.assign(() => true, { errors: [] }),
  validateConfigSchemaParams: () => true,
  validateConfigSetParams: () => true,
}));

vi.mock("./base-hash.js", () => ({
  resolveBaseHashParam: () => "base-hash",
}));

vi.mock("./restart-request.js", () => ({
  parseRestartRequestParams: () => ({
    sessionKey: undefined,
    note: undefined,
    restartDelayMs: undefined,
  }),
}));

vi.mock("./validation.js", () => ({
  assertValidParams: () => true,
}));

beforeEach(() => {
  writeRestartSentinelMock.mockReset();
  transitionRestartSentinelStatusMock.mockReset();
  scheduleGatewaySigusr1RestartMock.mockClear();
  scheduleGatewaySigusr1RestartMock.mockReturnValue({ scheduled: true });
});

async function invoke(method: "config.patch" | "config.apply") {
  const { configHandlers } = await import("./config.js");
  const respond = vi.fn();
  await configHandlers[method]({
    params: { raw: "{}", baseHash: "base-hash" },
    respond,
    client: {},
    context: {
      logGateway: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    },
  } as never);
  return respond;
}

describe("config restart sentinel transition hook", () => {
  it.each(["config.patch", "config.apply"] as const)(
    "does not register beforeRestart when sentinel write fails for %s",
    async (method) => {
      writeRestartSentinelMock.mockRejectedValueOnce(new Error("disk full"));

      await invoke(method);

      expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledTimes(1);
      const [restartRequest] = scheduleGatewaySigusr1RestartMock.mock.calls[0] ?? [];
      expect(restartRequest).toBeTruthy();
      expect(restartRequest.beforeRestart).toBeUndefined();
      expect(transitionRestartSentinelStatusMock).not.toHaveBeenCalled();
    },
  );

  it.each(["config.patch", "config.apply"] as const)(
    "registers beforeRestart only when sentinel write succeeds for %s",
    async (method) => {
      writeRestartSentinelMock.mockResolvedValueOnce("/tmp/restart-sentinel.json");

      await invoke(method);

      expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledTimes(1);
      const [restartRequest] = scheduleGatewaySigusr1RestartMock.mock.calls[0] ?? [];
      expect(typeof restartRequest.beforeRestart).toBe("function");

      await restartRequest.beforeRestart();

      expect(transitionRestartSentinelStatusMock).toHaveBeenCalledWith("in-progress", {
        allowedCurrentStatuses: ["pending"],
      });
    },
  );
});
