import { beforeEach, describe, expect, it, vi } from "vitest";

const { scheduleChatScrollMock, scheduleLogsScrollMock, scheduleMermaidRenderMock } = vi.hoisted(
  () => ({
    scheduleChatScrollMock: vi.fn(),
    scheduleLogsScrollMock: vi.fn(),
    scheduleMermaidRenderMock: vi.fn(),
  }),
);

vi.mock("./app-scroll.ts", () => ({
  observeTopbar: vi.fn(),
  scheduleChatScroll: scheduleChatScrollMock,
  scheduleLogsScroll: scheduleLogsScrollMock,
}));

vi.mock("./mermaid.ts", () => ({
  scheduleMermaidRender: scheduleMermaidRenderMock,
}));

import { handleDisconnected, handleUpdated } from "./app-lifecycle.ts";

type TestHost = {
  basePath: string;
  client: { stop: () => void } | null;
  connectGeneration: number;
  connected: boolean;
  tab: "chat";
  assistantName: string;
  assistantAvatar: null;
  assistantAgentId: null;
  serverVersion: null;
  chatHasAutoScrolled: boolean;
  chatManualRefreshInFlight: boolean;
  chatLoading: boolean;
  chatMessages: unknown[];
  chatToolMessages: unknown[];
  chatStream: string | null;
  settings: {
    chatShowThinking: boolean;
    chatShowToolCalls: boolean;
  };
  logsAutoFollow: boolean;
  logsAtBottom: boolean;
  logsEntries: unknown[];
  popStateHandler: ReturnType<typeof vi.fn>;
  topbarObserver: ResizeObserver | null;
};

function createHost() {
  const host: TestHost = {
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
    chatStream: null,
    settings: {
      chatShowThinking: true,
      chatShowToolCalls: true,
    },
    logsAutoFollow: false,
    logsAtBottom: true,
    logsEntries: [],
    popStateHandler: vi.fn(),
    topbarObserver: null,
  };

  return host;
}

describe("handleUpdated", () => {
  beforeEach(() => {
    scheduleChatScrollMock.mockReset();
    scheduleLogsScrollMock.mockReset();
    scheduleMermaidRenderMock.mockReset();
  });

  it("rerenders Mermaid blocks when chat visibility settings change", () => {
    const host = createHost();
    host.settings = {
      chatShowThinking: false,
      chatShowToolCalls: true,
    };
    const changed = new Map<PropertyKey, unknown>([
      [
        "settings",
        {
          chatShowThinking: true,
          chatShowToolCalls: true,
        },
      ],
    ]);

    handleUpdated(host as never, changed);

    expect(scheduleChatScrollMock).toHaveBeenCalledOnce();
    expect(scheduleMermaidRenderMock).toHaveBeenCalledOnce();
  });

  it("does not rerender Mermaid blocks for unrelated settings changes", () => {
    const host = createHost();
    const changed = new Map<PropertyKey, unknown>([
      [
        "settings",
        {
          chatShowThinking: true,
          chatShowToolCalls: true,
          locale: "en",
        },
      ],
    ]);

    handleUpdated(host as never, changed);

    expect(scheduleChatScrollMock).not.toHaveBeenCalled();
    expect(scheduleMermaidRenderMock).not.toHaveBeenCalled();
  });
});

describe("handleDisconnected", () => {
  it("stops and clears gateway client on teardown", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener").mockImplementation(() => undefined);
    const host = createHost();
    const stop = vi.fn();
    const disconnect = vi.fn();
    host.client = { stop };
    host.connected = true;
    host.topbarObserver = { disconnect } as unknown as ResizeObserver;

    handleDisconnected(host as never);

    expect(removeSpy).toHaveBeenCalledWith("popstate", host.popStateHandler);
    expect(host.connectGeneration).toBe(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(host.client).toBeNull();
    expect(host.connected).toBe(false);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(host.topbarObserver).toBeNull();
    removeSpy.mockRestore();
  });
});
