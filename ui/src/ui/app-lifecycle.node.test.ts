import { describe, expect, it, vi } from "vitest";

const removeEventListenerMock = vi.fn();

vi.stubGlobal("window", {
  removeEventListener: removeEventListenerMock,
});
vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
});
vi.stubGlobal("navigator", {
  language: "en-US",
});

const { handleDisconnected } = await import("./app-lifecycle.ts");

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
    visualViewportCleanup: null,
  };
}

describe("handleDisconnected", () => {
  it("stops and clears gateway client on teardown", () => {
    const host = createHost();
    const disconnectSpy = (
      host.topbarObserver as unknown as { disconnect: ReturnType<typeof vi.fn> }
    ).disconnect;

    handleDisconnected(host as unknown as Parameters<typeof handleDisconnected>[0]);

    expect(removeEventListenerMock).toHaveBeenCalledWith("popstate", host.popStateHandler);
    expect(host.connectGeneration).toBe(1);
    expect(host.client).toBeNull();
    expect(host.connected).toBe(false);
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    expect(host.topbarObserver).toBeNull();
  });
});
