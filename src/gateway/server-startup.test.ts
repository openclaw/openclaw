import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.js";

const { getGlobalHookRunnerMock } = vi.hoisted(() => ({
  getGlobalHookRunnerMock: vi.fn(),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: getGlobalHookRunnerMock,
}));

vi.mock("../agents/defaults.js", () => ({
  DEFAULT_MODEL: "test-model",
  DEFAULT_PROVIDER: "test-provider",
}));

vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn().mockResolvedValue({}),
}));

vi.mock("../agents/model-selection.js", () => ({
  getModelRefStatus: vi.fn().mockReturnValue({ allowed: true, inCatalog: true }),
  resolveConfiguredModelRef: vi.fn().mockReturnValue({ provider: "test", model: "test" }),
  resolveHooksGmailModel: vi.fn().mockReturnValue(null),
}));

vi.mock("../hooks/gmail-watcher.js", () => ({
  startGmailWatcher: vi
    .fn()
    .mockResolvedValue({ started: false, reason: "no gmail account configured" }),
}));

vi.mock("../hooks/internal-hooks.js", () => ({
  clearInternalHooks: vi.fn(),
  createInternalHookEvent: vi.fn(),
  triggerInternalHook: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../hooks/loader.js", () => ({
  loadInternalHooks: vi.fn().mockResolvedValue(0),
}));

vi.mock("../infra/env.js", () => ({
  isTruthyEnvValue: vi.fn().mockReturnValue(true),
}));

vi.mock("../plugins/services.js", () => ({
  startPluginServices: vi.fn().mockResolvedValue(null),
}));

vi.mock("./server-browser.js", () => ({
  startBrowserControlServerIfEnabled: vi.fn().mockResolvedValue(null),
}));

vi.mock("./server-restart-sentinel.js", () => ({
  shouldWakeFromRestartSentinel: vi.fn().mockReturnValue(false),
  scheduleRestartSentinelWake: vi.fn(),
}));

vi.mock("./server-startup-memory.js", () => ({
  startGatewayMemoryBackend: vi.fn().mockResolvedValue(undefined),
}));

import { startGatewaySidecars } from "./server-startup.js";

function createMockParams(overrides: Partial<Parameters<typeof startGatewaySidecars>[0]> = {}) {
  return {
    cfg: {} as ReturnType<
      Parameters<typeof startGatewaySidecars>[0]["cfg"] extends infer T ? () => T : never
    >,
    pluginRegistry: {} as Parameters<typeof startGatewaySidecars>[0]["pluginRegistry"],
    defaultWorkspaceDir: "/tmp/test-workspace",
    deps: {} as unknown as CliDeps,
    port: 18789,
    startChannels: vi.fn().mockResolvedValue(undefined),
    log: { warn: vi.fn() },
    logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    logChannels: { info: vi.fn(), error: vi.fn() },
    logBrowser: { error: vi.fn() },
    ...overrides,
  } as Parameters<typeof startGatewaySidecars>[0];
}

describe("startGatewaySidecars", () => {
  beforeEach(() => {
    getGlobalHookRunnerMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fires gateway_start plugin hook with port", async () => {
    const runGatewayStart = vi.fn().mockResolvedValue(undefined);
    getGlobalHookRunnerMock.mockReturnValue({ runGatewayStart });

    await startGatewaySidecars(createMockParams());

    expect(runGatewayStart).toHaveBeenCalledWith({ port: 18789 }, { port: 18789 });
  });

  it("does not throw when hook runner is null", async () => {
    getGlobalHookRunnerMock.mockReturnValue(null);

    await expect(startGatewaySidecars(createMockParams())).resolves.not.toThrow();
  });

  it("completes startup when gateway_start hook rejects", async () => {
    vi.useFakeTimers();
    const runGatewayStart = vi.fn().mockRejectedValue(new Error("hook boom"));
    getGlobalHookRunnerMock.mockReturnValue({ runGatewayStart });

    const params = createMockParams();
    const result = await startGatewaySidecars(params);

    expect(result).toHaveProperty("browserControl");
    expect(result).toHaveProperty("pluginServices");
    await vi.advanceTimersByTimeAsync(0);
    expect(params.logHooks.warn).toHaveBeenCalledWith(
      expect.stringContaining("gateway_start hook failed"),
    );
    vi.useRealTimers();
  });
});
