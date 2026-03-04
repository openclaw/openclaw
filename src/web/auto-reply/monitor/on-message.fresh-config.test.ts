import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks – vi.hoisted() makes these available inside vi.mock factories
// which are hoisted to the top of the file by vitest.
// ---------------------------------------------------------------------------

const {
  loadConfigMock,
  buildWhatsAppAccountConfigMock,
  resolveAgentRouteMock,
  processMessageMock,
  updateLastRouteInBackgroundMock,
  applyGroupGatingMock,
  maybeBroadcastMessageMock,
} = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  // Pass-through: return the cfg from params so the tagged config propagates.
  buildWhatsAppAccountConfigMock: vi.fn((p: { cfg: unknown }) => p.cfg),
  resolveAgentRouteMock: vi.fn(),
  processMessageMock: vi.fn(async () => true),
  updateLastRouteInBackgroundMock: vi.fn(),
  applyGroupGatingMock: vi.fn(() => ({ shouldProcess: true })),
  maybeBroadcastMessageMock: vi.fn(async () => false),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("../../../config/config.js", () => ({ loadConfig: loadConfigMock }));

vi.mock("./config.js", () => ({
  buildWhatsAppAccountConfig: buildWhatsAppAccountConfigMock,
}));

vi.mock("../../../routing/resolve-route.js", () => ({
  resolveAgentRoute: resolveAgentRouteMock,
}));

vi.mock("../../../routing/session-key.js", () => ({
  buildGroupHistoryKey: vi.fn(() => "group-history-key"),
}));

vi.mock("../../../globals.js", () => ({ logVerbose: vi.fn() }));
vi.mock("../../../utils.js", () => ({ normalizeE164: vi.fn((v: string) => v) }));

vi.mock("./process-message.js", () => ({ processMessage: processMessageMock }));

vi.mock("./last-route.js", () => ({
  updateLastRouteInBackground: updateLastRouteInBackgroundMock,
}));

vi.mock("./group-gating.js", () => ({ applyGroupGating: applyGroupGatingMock }));

vi.mock("./broadcast.js", () => ({
  maybeBroadcastMessage: maybeBroadcastMessageMock,
}));

vi.mock("./peer.js", () => ({ resolvePeerId: vi.fn(() => "+1234567890") }));

// ---------------------------------------------------------------------------
// Import unit under test AFTER mocks are established.
// ---------------------------------------------------------------------------

import { createWebOnMessageHandler } from "./on-message.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal config stub – `_tag` marker lets us assert identity. */
function makeConfig(tag: string) {
  return {
    _tag: tag,
    channels: { whatsapp: {} },
    agents: { list: [] },
    session: {},
  } as ReturnType<typeof loadConfigMock>;
}

function makeBaseParams(overrideCfg?: unknown) {
  const noop = vi.fn();
  return {
    cfg: overrideCfg ?? makeConfig("creation-time"),
    verbose: false,
    connectionId: "conn-1",
    maxMediaBytes: 10_000_000,
    groupHistoryLimit: 50,
    groupHistories: new Map(),
    groupMemberNames: new Map(),
    echoTracker: {
      has: vi.fn(() => false),
      forget: vi.fn(),
      rememberText: vi.fn(),
      buildCombinedKey: vi.fn(() => "echo-key"),
    },
    backgroundTasks: new Set<Promise<unknown>>(),
    replyResolver: noop as never,
    replyLogger: {
      warn: { bind: vi.fn(() => noop) },
      debug: noop,
      info: noop,
    } as never,
    baseMentionConfig: { patterns: [] } as never,
    account: { authDir: "/tmp/auth", accountId: "acct-1" },
  };
}

const baseRoute = {
  agentId: "main",
  channel: "whatsapp" as const,
  accountId: "default",
  sessionKey: "agent:main:whatsapp:dm:+1234567890",
  mainSessionKey: "agent:main:main",
};

function makeDmMsg(body = "hello"): Parameters<ReturnType<typeof createWebOnMessageHandler>>[0] {
  return {
    from: "+1234567890",
    to: "+0987654321",
    body,
    chatType: "direct" as const,
  } as never;
}

function makeGroupMsg(body = "hello"): Parameters<ReturnType<typeof createWebOnMessageHandler>>[0] {
  return {
    from: "+1234567890",
    to: "+0987654321",
    body,
    chatType: "group" as const,
    conversationId: "group-conv-1",
    groupSubject: "Test Group",
    senderName: "Alice",
    senderJid: "alice@s.whatsapp.net",
    senderE164: "+1234567890",
    accountId: "acct-1",
  } as never;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createWebOnMessageHandler – fresh config per message", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveAgentRouteMock.mockReturnValue(baseRoute);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls loadConfig() per message, not at handler creation time", async () => {
    const creationCfg = makeConfig("creation-time");
    const msgCfg = makeConfig("per-message");

    loadConfigMock.mockReturnValue(msgCfg);

    const handler = createWebOnMessageHandler(makeBaseParams(creationCfg));
    await handler(makeDmMsg());

    // loadConfig must have been called during message handling
    expect(loadConfigMock).toHaveBeenCalledTimes(1);

    // processMessage must receive the per-message config, NOT the creation-time config
    expect(processMessageMock).toHaveBeenCalledTimes(1);
    const pmArgs = (processMessageMock.mock.calls as unknown[][])[0][0] as Record<string, unknown>;
    expect((pmArgs.cfg as Record<string, unknown>)._tag).toBe("per-message");
  });

  it("passes fresh config to resolveAgentRoute", async () => {
    const freshCfg = makeConfig("fresh");
    loadConfigMock.mockReturnValue(freshCfg);

    const handler = createWebOnMessageHandler(makeBaseParams(makeConfig("stale")));
    await handler(makeDmMsg());

    expect(resolveAgentRouteMock).toHaveBeenCalledWith(expect.objectContaining({ cfg: freshCfg }));
  });

  it("passes fresh config to applyGroupGating for group messages", async () => {
    const freshCfg = makeConfig("fresh-group");
    loadConfigMock.mockReturnValue(freshCfg);

    const handler = createWebOnMessageHandler(makeBaseParams(makeConfig("stale")));
    await handler(makeGroupMsg());

    expect(applyGroupGatingMock).toHaveBeenCalledTimes(1);
    const gatingArgs = (applyGroupGatingMock.mock.calls as unknown[][])[0][0] as Record<
      string,
      unknown
    >;
    expect((gatingArgs.cfg as Record<string, unknown>)._tag).toBe("fresh-group");
  });

  it("passes fresh config to updateLastRouteInBackground for group messages", async () => {
    const freshCfg = makeConfig("fresh-route");
    loadConfigMock.mockReturnValue(freshCfg);

    const handler = createWebOnMessageHandler(makeBaseParams(makeConfig("stale")));
    await handler(makeGroupMsg());

    expect(updateLastRouteInBackgroundMock).toHaveBeenCalledTimes(1);
    const routeArgs = (updateLastRouteInBackgroundMock.mock.calls as unknown[][])[0][0] as Record<
      string,
      unknown
    >;
    expect((routeArgs.cfg as Record<string, unknown>)._tag).toBe("fresh-route");
  });

  it("passes fresh config to maybeBroadcastMessage", async () => {
    const freshCfg = makeConfig("fresh-broadcast");
    loadConfigMock.mockReturnValue(freshCfg);

    const handler = createWebOnMessageHandler(makeBaseParams(makeConfig("stale")));
    await handler(makeDmMsg());

    expect(maybeBroadcastMessageMock).toHaveBeenCalledTimes(1);
    const broadcastArgs = (maybeBroadcastMessageMock.mock.calls as unknown[][])[0][0] as Record<
      string,
      unknown
    >;
    expect((broadcastArgs.cfg as Record<string, unknown>)._tag).toBe("fresh-broadcast");
  });

  it("uses different fresh configs across consecutive messages", async () => {
    const cfg1 = makeConfig("msg-1");
    const cfg2 = makeConfig("msg-2");

    loadConfigMock.mockReturnValueOnce(cfg1).mockReturnValueOnce(cfg2);

    const handler = createWebOnMessageHandler(makeBaseParams(makeConfig("stale")));

    await handler(makeDmMsg("first"));
    await handler(makeDmMsg("second"));

    expect(loadConfigMock).toHaveBeenCalledTimes(2);

    // First message gets cfg1
    const pm1 = (processMessageMock.mock.calls as unknown[][])[0][0] as Record<string, unknown>;
    expect((pm1.cfg as Record<string, unknown>)._tag).toBe("msg-1");

    // Second message gets cfg2
    const pm2 = (processMessageMock.mock.calls as unknown[][])[1][0] as Record<string, unknown>;
    expect((pm2.cfg as Record<string, unknown>)._tag).toBe("msg-2");
  });
});
