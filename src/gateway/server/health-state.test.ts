import { afterEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.hoisted(() => vi.fn());
const createConfigIOMock = vi.hoisted(() => vi.fn());
const resolveDefaultAgentIdMock = vi.hoisted(() => vi.fn());
const resolveMainSessionKeyMock = vi.hoisted(() => vi.fn());
const resolveStorePathMock = vi.hoisted(() => vi.fn());
const loadSessionStoreMock = vi.hoisted(() => vi.fn());
const normalizeMainKeyMock = vi.hoisted(() => vi.fn());
const listSystemPresenceMock = vi.hoisted(() => vi.fn());
const resolveGatewayAuthMock = vi.hoisted(() => vi.fn());
const getUpdateAvailableMock = vi.hoisted(() => vi.fn());
const resolveAgentCortexConfigMock = vi.hoisted(() => vi.fn());
const resolveCortexChannelTargetMock = vi.hoisted(() => vi.fn());
const getCachedLatestCortexCaptureHistoryEntryMock = vi.hoisted(() => vi.fn());

vi.mock("../../config/config.js", () => ({
  STATE_DIR: "/tmp/openclaw-state",
  createConfigIO: createConfigIOMock,
  loadConfig: loadConfigMock,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: resolveDefaultAgentIdMock,
}));

vi.mock("../../config/sessions.js", () => ({
  loadSessionStore: loadSessionStoreMock,
  resolveMainSessionKey: resolveMainSessionKeyMock,
  resolveStorePath: resolveStorePathMock,
}));

vi.mock("../../routing/session-key.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../routing/session-key.js")>();
  return {
    ...actual,
    DEFAULT_ACCOUNT_ID: "default",
    normalizeMainKey: normalizeMainKeyMock,
  };
});

vi.mock("../../infra/system-presence.js", () => ({
  listSystemPresence: listSystemPresenceMock,
}));

vi.mock("../auth.js", () => ({
  resolveGatewayAuth: resolveGatewayAuthMock,
}));

vi.mock("../../infra/update-startup.js", () => ({
  getUpdateAvailable: getUpdateAvailableMock,
}));

vi.mock("../../agents/cortex.js", () => ({
  resolveAgentCortexConfig: resolveAgentCortexConfigMock,
  resolveCortexChannelTarget: resolveCortexChannelTargetMock,
}));

vi.mock("../../agents/cortex-history.js", () => ({
  getCachedLatestCortexCaptureHistoryEntry: getCachedLatestCortexCaptureHistoryEntryMock,
}));

import { buildGatewaySnapshot } from "./health-state.js";

describe("buildGatewaySnapshot", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("includes Cortex snapshot details when the prompt bridge is enabled", () => {
    loadConfigMock.mockReturnValue({
      session: { mainKey: "main", scope: "per-sender" },
    });
    createConfigIOMock.mockReturnValue({ configPath: "/tmp/openclaw/openclaw.json" });
    resolveDefaultAgentIdMock.mockReturnValue("main");
    resolveMainSessionKeyMock.mockReturnValue("agent:main:main");
    resolveStorePathMock.mockReturnValue("/tmp/openclaw-state/sessions/main/sessions.json");
    loadSessionStoreMock.mockReturnValue({
      "agent:main:main": {
        sessionId: "session-1",
        updatedAt: 1234,
        lastChannel: "telegram",
        lastTo: "telegram:user-123",
        deliveryContext: {
          channel: "telegram",
          to: "telegram:user-123",
        },
      },
    });
    normalizeMainKeyMock.mockReturnValue("main");
    listSystemPresenceMock.mockReturnValue([]);
    resolveGatewayAuthMock.mockReturnValue({ mode: "token" });
    getUpdateAvailableMock.mockReturnValue(undefined);
    resolveAgentCortexConfigMock.mockReturnValue({
      enabled: true,
      mode: "technical",
      maxChars: 1500,
      graphPath: ".cortex/context.json",
    });
    resolveCortexChannelTargetMock.mockReturnValue("telegram:user-123");
    getCachedLatestCortexCaptureHistoryEntryMock.mockReturnValue({
      agentId: "main",
      sessionId: "session-1",
      channelId: "telegram:user-123",
      captured: true,
      score: 0.7,
      reason: "high-signal memory candidate",
      syncPlatforms: ["claude-code", "cursor", "copilot"],
      timestamp: 1234,
    });

    const snapshot = buildGatewaySnapshot();

    expect(resolveStorePathMock).toHaveBeenCalledWith(undefined, { agentId: "main" });
    expect(loadSessionStoreMock).toHaveBeenCalledWith(
      "/tmp/openclaw-state/sessions/main/sessions.json",
    );
    expect(resolveCortexChannelTargetMock).toHaveBeenCalledWith({
      channel: "telegram",
      originatingChannel: "telegram",
      originatingTo: "telegram:user-123",
      nativeChannelId: "telegram:user-123",
      to: "telegram:user-123",
    });
    expect(getCachedLatestCortexCaptureHistoryEntryMock).toHaveBeenCalledWith({
      agentId: "main",
      sessionId: "session-1",
      channelId: "telegram:user-123",
    });

    expect(snapshot.cortex).toEqual({
      enabled: true,
      mode: "technical",
      graphPath: ".cortex/context.json",
      lastCaptureAtMs: 1234,
      lastCaptureReason: "high-signal memory candidate",
      lastCaptureStored: true,
      lastSyncPlatforms: ["claude-code", "cursor", "copilot"],
    });
  });
});
