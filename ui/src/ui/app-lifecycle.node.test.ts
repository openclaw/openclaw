import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./app-gateway.ts", () => ({
  connectGateway: vi.fn(),
}));
vi.mock("./controllers/control-ui-bootstrap.ts", () => ({
  loadControlUiBootstrapConfig: vi.fn(),
}));
vi.mock("./app-settings.ts", () => ({
  applySettingsFromUrl: vi.fn(),
  attachThemeListener: vi.fn(),
  detachThemeListener: vi.fn(),
  inferBasePath: vi.fn(() => "/"),
  syncTabWithLocation: vi.fn(),
  syncThemeWithSettings: vi.fn(),
}));
vi.mock("./app-polling.ts", () => ({
  startLogsPolling: vi.fn(),
  startNodesPolling: vi.fn(),
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

const windowStub = {
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
};

beforeAll(() => {
  (globalThis as Record<string, unknown>).window = windowStub;
});
afterAll(() => {
  delete (globalThis as Record<string, unknown>).window;
});

import { handleDisconnected } from "./app-lifecycle.ts";

function createHost() {
  return {
    basePath: "",
    client: { stop: vi.fn() },
    connectGeneration: 0,
    connected: true,
    tab: "chat",
    assistantName: "OpenClaw",
    assistantAvatar: null,
    assistantAgentId: null,
    chatHasAutoScrolled: false,
    chatManualRefreshInFlight: false,
    chatLoading: false,
    chatMessages: [],
    chatToolMessages: [],
    chatStream: null,
    logsAutoFollow: false,
    logsAtBottom: true,
    logsEntries: [],
    popStateHandler: vi.fn(),
    topbarObserver: { disconnect: vi.fn() } as unknown as ResizeObserver,
  };
}

describe("handleDisconnected", () => {
  it("stops and clears gateway client on teardown", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener").mockImplementation(() => undefined);
    const host = createHost();
    const disconnectSpy = (
      host.topbarObserver as unknown as { disconnect: ReturnType<typeof vi.fn> }
    ).disconnect;

    handleDisconnected(host as unknown as Parameters<typeof handleDisconnected>[0]);

    expect(removeSpy).toHaveBeenCalledWith("popstate", host.popStateHandler);
    expect(host.connectGeneration).toBe(1);
    expect(host.client).toBeNull();
    expect(host.connected).toBe(false);
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    expect(host.topbarObserver).toBeNull();
    removeSpy.mockRestore();
  });
});
