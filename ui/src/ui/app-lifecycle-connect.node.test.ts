// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatQueueItem } from "./ui-types.ts";

const {
  applySettingsFromUrlMock,
  connectGatewayMock,
  loadBootstrapMock,
  appRouterStartMock,
  restoreComposerMock,
} = vi.hoisted(() => ({
  applySettingsFromUrlMock: vi.fn(),
  connectGatewayMock: vi.fn(),
  loadBootstrapMock: vi.fn(),
  appRouterStartMock: vi.fn(),
  restoreComposerMock: vi.fn<(...args: unknown[]) => boolean>(() => false),
}));

vi.mock("../app-routes.ts", () => ({
  appRouter: {
    subscribe: vi.fn(() => vi.fn()),
    subscribeSelector: vi.fn(() => vi.fn()),
    getState: vi.fn(() => ({ matches: [] })),
    start: appRouterStartMock,
    stop: vi.fn(),
  },
  routeLoadContext: (host: unknown) => host,
}));

vi.mock("./app-gateway.ts", () => ({
  connectGateway: connectGatewayMock,
}));

vi.mock("./controllers/control-ui-bootstrap.ts", () => ({
  loadControlUiBootstrapConfig: loadBootstrapMock,
}));

vi.mock("./chat/composer-persistence.ts", () => ({
  persistChatComposerState: vi.fn(),
  restoreChatComposerState: restoreComposerMock,
}));

vi.mock("./app-settings.ts", () => ({
  applySettingsFromUrl: applySettingsFromUrlMock,
  attachThemeListener: vi.fn(),
  detachThemeListener: vi.fn(),
  inferBasePath: vi.fn(() => "/"),
  syncSessionWithLocation: vi.fn(),
  syncThemeWithSettings: vi.fn(),
}));

vi.mock("./app-polling.ts", () => ({
  startLogsPolling: vi.fn(),
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

import { handleConnected, handleUpdated } from "./app-lifecycle.ts";
import { scheduleChatScroll } from "./app-scroll.ts";

const scheduleChatScrollMock = vi.mocked(scheduleChatScroll);

function createDeferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  if (!resolve) {
    throw new Error("Expected bootstrap deferred resolver to be initialized");
  }
  return { promise, resolve };
}

function createHost() {
  return {
    basePath: "",
    client: null,
    connectGeneration: 0,
    connected: false,
    routeId: "chat",
    assistantName: "OpenClaw",
    assistantAvatar: null,
    assistantAgentId: null,
    serverVersion: null,
    chatHasAutoScrolled: false,
    chatManualRefreshInFlight: false,
    sessionKey: "main",
    chatMessage: "",
    chatQueue: [] as ChatQueueItem[],
    pendingGatewayUrl: null as string | null,
    chatComposerProvisionalRestore: null as {
      sessionKey: string;
      chatMessage: string;
      chatQueue: ChatQueueItem[];
    } | null,
    chatLoading: false,
    chatMessages: [],
    chatToolMessages: [],
    chatStream: "" as string | null,
    logsAutoFollow: false,
    logsAtBottom: true,
    logsEntries: [],
    topbarObserver: null,
  };
}

describe("handleConnected", () => {
  beforeEach(() => {
    applySettingsFromUrlMock.mockReset();
    connectGatewayMock.mockReset();
    loadBootstrapMock.mockReset();
    appRouterStartMock.mockReset();
    restoreComposerMock.mockReset();
    restoreComposerMock.mockReturnValue(false);
    scheduleChatScrollMock.mockReset();
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      location: { pathname: "/chat", search: "", hash: "" },
    });
  });

  it("starts the first gateway connect without waiting for bootstrap", async () => {
    const bootstrap = createDeferred();
    loadBootstrapMock.mockReturnValueOnce(bootstrap.promise);
    connectGatewayMock.mockReset();
    const host = createHost();

    handleConnected(host as never);
    expect(connectGatewayMock).toHaveBeenCalledTimes(1);

    bootstrap.resolve();
    await Promise.resolve();
    expect(connectGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("does not start a second gateway connect when bootstrap resolves after disconnect", async () => {
    const bootstrap = createDeferred();
    loadBootstrapMock.mockReturnValueOnce(bootstrap.promise);
    connectGatewayMock.mockReset();
    const host = createHost();

    handleConnected(host as never);
    expect(connectGatewayMock).toHaveBeenCalledTimes(1);

    host.connectGeneration += 1;
    bootstrap.resolve();
    await Promise.resolve();

    expect(connectGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("scrubs URL settings before starting the bootstrap fetch", () => {
    const bootstrap = Promise.resolve();
    loadBootstrapMock.mockReturnValueOnce(bootstrap);
    const host = createHost();

    handleConnected(host as never);

    expect(applySettingsFromUrlMock).toHaveBeenCalledTimes(1);
    expect(loadBootstrapMock).toHaveBeenCalledTimes(1);
    expect(applySettingsFromUrlMock.mock.invocationCallOrder[0]).toBeLessThan(
      loadBootstrapMock.mock.invocationCallOrder[0],
    );
    expect(loadBootstrapMock).toHaveBeenCalledWith(host, {
      applyIdentity: false,
      skipWithoutAuthCandidate: true,
    });
    expect(
      (host as typeof host & { controlUiBootstrapReady?: Promise<void> }).controlUiBootstrapReady,
    ).toBe(bootstrap);
  });

  it("restores the local composer before starting the gateway connect", () => {
    loadBootstrapMock.mockResolvedValue(undefined);
    restoreComposerMock.mockImplementationOnce((target: unknown) => {
      const hostTarget = target as ReturnType<typeof createHost>;
      hostTarget.chatMessage = "offline draft";
      hostTarget.chatQueue = [{ id: "queued-1", text: "retry me", createdAt: 1 }];
      return true;
    });
    const host = createHost();

    handleConnected(host as never);

    expect(restoreComposerMock).toHaveBeenCalledWith(host, { preserveCurrent: true });
    expect(restoreComposerMock.mock.invocationCallOrder[0]).toBeLessThan(
      connectGatewayMock.mock.invocationCallOrder[0],
    );
    expect(host.chatComposerProvisionalRestore).toEqual({
      sessionKey: "main",
      chatMessage: "offline draft",
      chatQueue: [{ id: "queued-1", text: "retry me", createdAt: 1 }],
    });
  });

  it("does not restore old-gateway composer state during a pending gateway switch", () => {
    loadBootstrapMock.mockResolvedValue(undefined);
    applySettingsFromUrlMock.mockImplementationOnce((target: ReturnType<typeof createHost>) => {
      target.pendingGatewayUrl = "ws://new-gateway.test/control";
    });
    const host = createHost();

    handleConnected(host as never);

    expect(restoreComposerMock).not.toHaveBeenCalled();
    expect(host.chatComposerProvisionalRestore).toBeNull();
    expect(connectGatewayMock).toHaveBeenCalledWith(host);
  });

  it("starts the router from the current location on connect", () => {
    loadBootstrapMock.mockResolvedValue(undefined);
    const chatHost = createHost();

    handleConnected(chatHost as never);
    expect(appRouterStartMock).toHaveBeenCalledWith(expect.anything(), chatHost.basePath, chatHost);

    const nodesHost = createHost();
    nodesHost.routeId = "nodes";
    handleConnected(nodesHost as never);
    expect(appRouterStartMock).toHaveBeenCalledTimes(2);

    const logsHost = createHost();
    logsHost.routeId = "logs";
    handleConnected(logsHost as never);
    expect(appRouterStartMock).toHaveBeenCalledTimes(3);
  });

  it("keeps realtime Talk turns pinned in the chat flow", () => {
    const host = createHost();
    host.chatStream = null;

    handleUpdated(
      host as unknown as Parameters<typeof handleUpdated>[0],
      new Map<PropertyKey, unknown>([["realtimeTalkConversation", []]]),
    );

    expect(scheduleChatScrollMock).toHaveBeenCalledWith(host, true);
  });
});
