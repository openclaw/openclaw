import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  applySettingsFromUrlMock,
  connectGatewayMock,
  loadBootstrapMock,
  startNodesPollingMock,
} = vi.hoisted(() => ({
  applySettingsFromUrlMock: vi.fn(),
  connectGatewayMock: vi.fn(),
  loadBootstrapMock: vi.fn(),
  startNodesPollingMock: vi.fn(),
}));

vi.mock("./app-gateway.ts", () => ({
  connectGateway: connectGatewayMock,
}));

vi.mock("./controllers/control-ui-bootstrap.ts", () => ({
  loadControlUiBootstrapConfig: loadBootstrapMock,
}));

vi.mock("./app-settings.ts", () => ({
  applySettingsFromUrl: applySettingsFromUrlMock,
  attachThemeListener: vi.fn(),
  detachThemeListener: vi.fn(),
  inferBasePath: vi.fn(() => "/"),
  syncTabWithLocation: vi.fn(),
  syncThemeWithSettings: vi.fn(),
}));

vi.mock("./app-polling.ts", () => ({
  startLogsPolling: vi.fn(),
  startNodesPolling: startNodesPollingMock,
  stopLogsPolling: vi.fn(),
  stopNodesPolling: vi.fn(),
  startDebugPolling: vi.fn(),
  stopDebugPolling: vi.fn(),
}));

vi.mock("./app-scroll.ts", () => ({
  observeTopbar: vi.fn(),
  scheduleChatScroll: vi.fn(),
  scheduleLogsScroll: vi.fn(),
}));

import { handleConnected } from "./app-lifecycle.ts";

function createHost() {
  return {
    basePath: "",
    client: null,
    connectGeneration: 0,
    connected: false,
    tab: "chat",
    assistantName: "OpenClaw",
    assistantAvatar: null,
    assistantAgentId: null,
    serverVersion: null,
    chatHasAutoScrolled: false,
    chatManualRefreshInFlight: false,
    chatLoading: false,
    chatMessages: [],
    chatToolMessages: [],
    chatStream: "",
    logsAutoFollow: false,
    logsAtBottom: true,
    logsEntries: [],
    popStateHandler: vi.fn(),
    topbarObserver: null,
    sessionsChangedReloadTimer: null,
  };
}

describe("handleConnected", () => {
  beforeEach(() => {
    applySettingsFromUrlMock.mockReset();
    connectGatewayMock.mockReset();
    loadBootstrapMock.mockReset();
    startNodesPollingMock.mockReset();
  });

  it("waits for bootstrap load before first gateway connect", async () => {
    let resolveBootstrap!: () => void;
    loadBootstrapMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveBootstrap = resolve;
      }),
    );
    connectGatewayMock.mockReset();
    const host = createHost();

    handleConnected(host as never);
    expect(connectGatewayMock).not.toHaveBeenCalled();

    resolveBootstrap();
    await Promise.resolve();
    expect(connectGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("skips deferred connect when disconnected before bootstrap resolves", async () => {
    let resolveBootstrap!: () => void;
    loadBootstrapMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveBootstrap = resolve;
      }),
    );
    connectGatewayMock.mockReset();
    const host = createHost();

    handleConnected(host as never);
    expect(connectGatewayMock).not.toHaveBeenCalled();

    host.connectGeneration += 1;
    resolveBootstrap();
    await Promise.resolve();

    expect(connectGatewayMock).not.toHaveBeenCalled();
  });

  it("scrubs URL settings before starting the bootstrap fetch", () => {
    loadBootstrapMock.mockResolvedValueOnce(undefined);
    const host = createHost();

    handleConnected(host as never);

    expect(applySettingsFromUrlMock).toHaveBeenCalledTimes(1);
    expect(loadBootstrapMock).toHaveBeenCalledTimes(1);
    expect(applySettingsFromUrlMock.mock.invocationCallOrder[0]).toBeLessThan(
      loadBootstrapMock.mock.invocationCallOrder[0],
    );
  });

  it("starts node polling only when the active tab is nodes", () => {
    loadBootstrapMock.mockResolvedValue(undefined);
    const host = createHost();

    handleConnected(host as never);
    expect(startNodesPollingMock).not.toHaveBeenCalled();

    host.tab = "nodes";
    handleConnected(host as never);
    expect(startNodesPollingMock).toHaveBeenCalledTimes(1);
  });
});
