import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it, test, vi } from "vitest";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { RequestFrame } from "../../packages/gateway-protocol/src/index.js";
import {
  registerActiveManagedProxyUrl,
  stopActiveManagedProxyRegistration,
} from "../infra/net/proxy/active-proxy-state.js";
import { defaultVoiceWakeTriggers } from "../infra/voicewake.js";
import {
  DEFAULT_DANGEROUS_NODE_COMMANDS,
  resolveNodeCommandAllowlist,
} from "./node-command-policy.js";
import type { GatewayPluginEventScope } from "./server-broadcast-types.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { createChatRunState, createSessionMessageSubscriberRegistry } from "./server-chat-state.js";
import { MAX_BUFFERED_BYTES, WEBSOCKET_CLOSE_GRACE_MS } from "./server-constants.js";
import { handleNodeInvokeResult } from "./server-methods/nodes.handlers.invoke-result.js";
import type * as GatewayMethodTypes from "./server-methods/types.js";
import { normalizeVoiceWakeTriggers } from "./server-utils.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";

const wsMockState = vi.hoisted(() => ({
  last: null as {
    noProxyDuringConstruction: unknown;
    httpProxyDuringConstruction: unknown;
    httpsProxyDuringConstruction: unknown;
  } | null,
}));

vi.mock("../../packages/gateway-client/src/websocket.js", () => ({
  WebSocket: class MockWebSocket {
    static readonly OPEN = 1;
    on = vi.fn();
    close = vi.fn();
    send = vi.fn();

    constructor() {
      wsMockState.last = {
        noProxyDuringConstruction: process.env["NO_PROXY"],
        httpProxyDuringConstruction: process.env["HTTP_PROXY"],
        httpsProxyDuringConstruction: process.env["HTTPS_PROXY"],
      };
    }
  },
}));

let GatewayClient: typeof import("./client.js").GatewayClient;

describe("GatewayClient", () => {
  beforeAll(async () => {
    ({ GatewayClient } = await import("./client.js"));
  });

  beforeEach(() => {
    wsMockState.last = null;
    delete process.env["NO_PROXY"];
    delete process.env["no_proxy"];
    delete process.env["HTTP_PROXY"];
    delete process.env["HTTPS_PROXY"];
  });

  test("uses the admitted pairing identity for shared-auth connect failures", async () => {
    const source = await fs.readFile(
      new URL("./server/ws-connection/connect-session.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("deviceId: admittedNodePairing.identity.nodeId");
    expect(source).not.toContain("deviceId: authenticatedNodePairing.nodeId");
  });

  test("scopes IPv6 loopback bypass during Gateway-only proxy mode connection setup", () => {
    process.env["NO_PROXY"] = process.env["no_proxy"] = "corp.example.com";
    process.env["HTTP_PROXY"] = process.env["HTTPS_PROXY"] = "http://127.0.0.1:3128";
    const registration = registerActiveManagedProxyUrl(
      new URL("http://127.0.0.1:3128"),
      "gateway-only",
    );

    try {
      new GatewayClient({ url: "ws://[::1]:18789", deviceIdentity: null }).start();
      expect(wsMockState.last).toMatchObject({
        noProxyDuringConstruction: "corp.example.com",
        httpProxyDuringConstruction: "http://127.0.0.1:3128",
        httpsProxyDuringConstruction: "http://127.0.0.1:3128",
      });
      expect(process.env).toMatchObject({
        NO_PROXY: "corp.example.com",
        no_proxy: "corp.example.com",
        HTTP_PROXY: "http://127.0.0.1:3128",
        HTTPS_PROXY: "http://127.0.0.1:3128",
      });
    } finally {
      stopActiveManagedProxyRegistration(registration);
    }
  });
});

type EventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
};

function makeRecordingSocket() {
  const sent: EventFrame[] = [];
  return Object.assign(new EventEmitter(), {
    readyState: 1,
    bufferedAmount: 0,
    send: vi.fn((payload: string) => {
      sent.push(JSON.parse(payload) as EventFrame);
    }),
    close: vi.fn(),
    terminate: vi.fn(),
    sent,
  });
}

type RecordingSocket = ReturnType<typeof makeRecordingSocket>;

function makeGatewayWsClient(
  connId: string,
  socket: RecordingSocket,
  connect: GatewayWsClient["connect"],
): GatewayWsClient {
  return {
    socket: socket as unknown as GatewayWsClient["socket"],
    connect,
    connId,
    usesSharedGatewayAuth: false,
  };
}

function makeOperatorWsClient(connId: string, socket: RecordingSocket, scopes: string[]) {
  return makeGatewayWsClient(connId, socket, {
    role: "operator",
    scopes,
  } as GatewayWsClient["connect"]);
}

function makeOperatorWsClients(
  entries: Array<{ connId: string; socket: RecordingSocket; scopes: string[] }>,
) {
  return new GatewayClientRegistry(
    entries.map(({ connId, socket, scopes }) => makeOperatorWsClient(connId, socket, scopes)),
  );
}

function makeScopedBroadcastContext() {
  const sockets = {
    pairing: makeRecordingSocket(),
    node: makeRecordingSocket(),
    read: makeRecordingSocket(),
    talk: makeRecordingSocket(),
    write: makeRecordingSocket(),
    admin: makeRecordingSocket(),
    questions: makeRecordingSocket(),
  };
  const clients = new GatewayClientRegistry(
    Object.entries(sockets).map(([scope, socket]) =>
      scope === "node"
        ? makeGatewayWsClient("c-node", socket, {
            role: "node",
            scopes: ["operator.read"],
          } as GatewayWsClient["connect"])
        : makeOperatorWsClient(`c-${scope}`, socket, [`operator.${scope}`]),
    ),
  );
  return {
    sockets,
    ...createGatewayBroadcaster({
      clients,
      preparePresenceProjection: (presence) => () => presence,
    }),
  };
}

function sentEvents(socket: RecordingSocket) {
  return socket.sent.map((frame) => frame.event);
}

function expectSentEvents(events: string[], ...sockets: RecordingSocket[]) {
  for (const socket of sockets) {
    expect(socket.send).toHaveBeenCalledTimes(events.length);
    expect(sentEvents(socket)).toEqual(events);
  }
}

function sentEventSeq(socket: RecordingSocket) {
  return socket.sent.map((frame) => [frame.event, frame.seq]);
}

function chatPayload() {
  return { sessionKey: "agent:main:main", message: "secret" };
}

function chatSideResultPayload() {
  return { sessionKey: "agent:main:main", text: "tool output" };
}

describe("gateway broadcaster", () => {
  it("closes a slow authoritative-session subscriber while delivering to healthy clients", () => {
    vi.useFakeTimers();
    const slowSocket = makeRecordingSocket();
    slowSocket.bufferedAmount = MAX_BUFFERED_BYTES + 1;
    const healthySocket = makeRecordingSocket();
    const clients = makeOperatorWsClients([
      { connId: "slow-session", socket: slowSocket, scopes: ["operator.read"] },
      { connId: "healthy-session", socket: healthySocket, scopes: ["operator.read"] },
    ]);
    const { broadcastToConnIds } = createGatewayBroadcaster({ clients });
    const payload = {
      sessionKey: "agent:main:main",
      messageId: "durable-user-1",
      messageSeq: 1,
      message: {
        role: "user",
        content: [{ type: "text", text: "shared durable prompt" }],
      },
    };

    broadcastToConnIds("session.message", payload, new Set(["slow-session", "healthy-session"]));

    expect(slowSocket.close).toHaveBeenCalledWith(1008, "slow consumer");
    vi.advanceTimersByTime(WEBSOCKET_CLOSE_GRACE_MS);
    expect(slowSocket.terminate).toHaveBeenCalledOnce();
    expect(slowSocket.send).not.toHaveBeenCalled();
    expect(healthySocket.sent).toEqual([
      { type: "event", event: "session.message", payload, seq: 1 },
    ]);
  });

  it("stamps targeted frames on the per-client sequence so drops surface as gaps", () => {
    const socket = makeRecordingSocket();
    const client = makeOperatorWsClient("c-seq", socket, ["operator.read"]);
    const clients = new GatewayClientRegistry([client]);
    const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({ clients });

    broadcastToConnIds("tick", { ts: 1 }, new Set(["c-seq"]));
    broadcast("heartbeat", { ts: 2 });
    // A slow-consumer drop between targeted sends must consume a sequence
    // number: the next delivered frame exposes the loss to gap detection.
    socket.bufferedAmount = MAX_BUFFERED_BYTES + 1;
    broadcastToConnIds("tick", { ts: 3 }, new Set(["c-seq"]), { dropIfSlow: true });
    expect(socket.close).not.toHaveBeenCalled();
    expect(socket.terminate).not.toHaveBeenCalled();
    socket.bufferedAmount = 0;
    broadcastToConnIds("tick", { ts: 4 }, new Set(["c-seq"]));

    expect(socket.sent.map((frame) => frame.seq)).toEqual([1, 2, 4]);
  });

  it("keeps workers outside all generic and targeted gateway broadcasts", () => {
    const workerSocket = makeRecordingSocket();
    const worker = makeGatewayWsClient("c-worker", workerSocket, {
      role: "worker",
      scopes: [],
    } as unknown as GatewayWsClient["connect"]);
    worker.connectionKind = "worker";
    const clients = new GatewayClientRegistry([worker]);
    const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({ clients });

    for (const event of ["heartbeat", "presence", "health", "tick", "shutdown", "chat"]) {
      broadcast(event, { value: event });
    }
    broadcastToConnIds("tick", { ts: 1 }, new Set([worker.connId]));

    expect(workerSocket.send).not.toHaveBeenCalled();
  });

  it("skips locally invalidated clients before generic broadcast delivery", () => {
    const socket = makeRecordingSocket();
    const client = makeOperatorWsClient("c-invalidated", socket, ["operator.read"]);
    client.invalidated = true;
    const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([client]),
    });

    broadcast("heartbeat", { ts: 1 });
    broadcastToConnIds("heartbeat", { ts: 2 }, new Set([client.connId]));

    expect(socket.send).not.toHaveBeenCalled();
  });

  it("delivers scoped client events only for gateway-owned session subscriptions", () => {
    const legacySocket = makeRecordingSocket();
    const firstSocket = makeRecordingSocket();
    const secondSocket = makeRecordingSocket();
    const legacy = makeOperatorWsClient("legacy", legacySocket, ["operator.read"]);
    const first = makeOperatorWsClient("first", firstSocket, ["operator.read"]);
    const second = makeOperatorWsClient("second", secondSocket, ["operator.read"]);
    first.connect.caps = [
      GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS,
      GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
    ];
    second.connect.caps = [];
    second.connect.client = {
      id: GATEWAY_CLIENT_IDS.BROWSER_COPILOT,
      version: "test",
      platform: "chrome",
      mode: GATEWAY_CLIENT_MODES.UI,
    };
    const clients = new GatewayClientRegistry([legacy, first, second]);
    const sessionMessageSubscribers = createSessionMessageSubscriberRegistry();
    sessionMessageSubscribers.subscribe(first.connId, "session-a");
    sessionMessageSubscribers.subscribe(second.connId, "session-b");
    const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({
      clients,
      sessionMessageSubscribers,
    });

    broadcast("chat", { sessionKey: "session-a" }, { sessionKeys: ["session-a"] });
    broadcast("agent", { stream: "lifecycle" });
    broadcastToConnIds("agent", { sessionKey: "session-a" }, new Set([first.connId]), {
      sessionKeys: ["session-a"],
    });
    broadcastToConnIds("agent", { sessionKey: "session-a" }, new Set([second.connId]), {
      sessionKeys: ["session-a"],
    });

    expect(sentEvents(legacySocket)).toEqual(["chat", "agent"]);
    expect(sentEvents(firstSocket)).toEqual(["chat", "agent"]);
    expect(sentEvents(secondSocket)).toEqual([]);
  });

  it("filters approval and pairing events by scope", () => {
    const approvalsSocket = makeRecordingSocket();
    const pairingSocket = makeRecordingSocket();
    const readSocket = makeRecordingSocket();
    const adminSocket = makeRecordingSocket();

    const clients = new GatewayClientRegistry([
      makeOperatorWsClient("c-approvals", approvalsSocket, ["operator.approvals"]),
      makeOperatorWsClient("c-pairing", pairingSocket, ["operator.pairing"]),
      makeOperatorWsClient("c-read", readSocket, ["operator.read"]),
      makeOperatorWsClient("c-admin", adminSocket, ["operator.admin"]),
    ]);

    const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({ clients });

    broadcast("exec.approval.requested", { id: "1" });
    broadcast("device.pair.requested", { requestId: "r1" });
    broadcast("device.pair.changed", {});

    expect(approvalsSocket.send).toHaveBeenCalledTimes(1);
    expect(pairingSocket.send).toHaveBeenCalledTimes(2);
    expect(readSocket.send).toHaveBeenCalledTimes(0);
    expect(adminSocket.send).toHaveBeenCalledTimes(3);

    broadcastToConnIds("tick", { ts: 1 }, new Set(["c-read"]));
    broadcastToConnIds("talk.event", { type: "session.ready" }, new Set(["c-read"]));
    expect(readSocket.send).toHaveBeenCalledTimes(2);
    expect(approvalsSocket.send).toHaveBeenCalledTimes(1);
    expect(pairingSocket.send).toHaveBeenCalledTimes(2);
    expect(adminSocket.send).toHaveBeenCalledTimes(3);
  });

  it.each<{
    name: string;
    events: Record<string, unknown>;
    allowed: string[];
    scope?: GatewayPluginEventScope;
  }>([
    {
      name: "requires operator.read for chat-class broadcast events",
      events: {
        chat: chatPayload(),
        agent: { type: "status", sessionKey: "agent:main:main" },
        "chat.send_timing": { phase: "dispatch-started", runId: "run-1" },
        "chat.side_result": chatSideResultPayload(),
      },
      allowed: ["read", "write", "admin"],
    },
    {
      name: "requires operator.questions for question broadcasts",
      events: {
        "question.requested": { id: "question-1" },
        "question.resolved": { id: "question-1", status: "expired" },
      },
      allowed: ["questions", "admin"],
    },
    {
      name: "allows plugin.* broadcast events for operator.write and operator.admin",
      events: {
        "plugin.myplugin.custom": { data: "test" },
        "plugin.otherplugin.state": { state: "updated" },
      },
      allowed: ["write", "admin"],
    },
    {
      name: "honors explicit read scope for plugin lifecycle events",
      events: { "plugin.workboard.changed": { revision: 1 } },
      allowed: ["read", "write", "admin"],
      scope: "operator.read",
    },
  ])("$name", ({ events, allowed, scope }) => {
    const { sockets, broadcast, broadcastPluginEvent } = makeScopedBroadcastContext();
    for (const [event, payload] of Object.entries(events)) {
      if (scope) {
        broadcastPluginEvent(event, payload, scope);
      } else {
        broadcast(event, payload);
      }
    }
    for (const [role, socket] of Object.entries(sockets)) {
      expectSentEvents(allowed.includes(role) ? Object.keys(events) : [], socket);
    }
  });

  it("rejects invalid or reserved plugin event broadcasts", () => {
    const { broadcastPluginEvent } = makeScopedBroadcastContext();
    const unsafe = broadcastPluginEvent as unknown as (
      event: string,
      payload: unknown,
      scope: string,
    ) => void;

    expect(() => unsafe("workboard.changed", {}, "operator.read")).toThrow(
      "invalid plugin gateway event",
    );
    expect(() => unsafe("plugin.approval.requested", {}, "operator.read")).toThrow(
      "invalid plugin gateway event",
    );
    expect(() => unsafe("plugin.workboard.changed", {}, "operator.approvals")).toThrow(
      "invalid plugin gateway event scope",
    );
  });

  it("defaults unknown events to deny and classifies remaining gateway broadcast events", () => {
    const { sockets: s, broadcast } = makeScopedBroadcastContext();

    broadcast("cron", { jobId: "job-1" });
    broadcast("talk.mode", { enabled: true });
    broadcast("voicewake.changed", { triggers: ["hello"] });
    broadcast("voicewake.routing.changed", { config: { routes: [] } });
    broadcast("heartbeat", { ts: 1 });
    broadcast("presence", { presence: [] });
    broadcast("health", { ok: true });
    broadcast("tick", { ts: 2 });
    broadcast("shutdown", { reason: "restart" });
    broadcast("update.available", {
      updateAvailable: {
        currentVersion: "2026.4.19",
        latestVersion: "2026.4.20",
        channel: "stable",
      },
    });
    broadcast("unknown.future.event", { hidden: true });

    const publicEvents = ["heartbeat", "health", "tick", "shutdown", "update.available"];
    expectSentEvents(publicEvents, s.pairing, s.node);
    expectSentEvents(
      [
        "cron",
        "voicewake.changed",
        "voicewake.routing.changed",
        publicEvents[0]!,
        "presence",
        ...publicEvents.slice(1),
      ],
      s.read,
    );
    expectSentEvents(["talk.mode", ...publicEvents], s.talk);
    const writeVisibleEvents = [
      "cron",
      "talk.mode",
      "voicewake.changed",
      "voicewake.routing.changed",
      "heartbeat",
      "presence",
      "health",
      "tick",
      "shutdown",
      "update.available",
    ];
    expectSentEvents(writeVisibleEvents, s.write, s.admin);
  });

  it("keeps event seq contiguous per receiving client when scoped events are filtered", () => {
    const pairingSocket = makeRecordingSocket();
    const readSocket = makeRecordingSocket();

    const clients = makeOperatorWsClients([
      { connId: "c-pairing", socket: pairingSocket, scopes: ["operator.pairing"] },
      { connId: "c-read", socket: readSocket, scopes: ["operator.read"] },
    ]);

    const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({
      clients,
      preparePresenceProjection: (presence) => () => presence,
    });

    broadcast("chat", chatPayload());
    broadcast("presence", { presence: [] });
    broadcastToConnIds("presence", { presence: [] }, new Set(["c-pairing", "c-read"]));
    broadcast("heartbeat", { ts: 1 });
    broadcast("chat.side_result", chatSideResultPayload());
    broadcast("tick", { ts: 2 });

    expect(sentEventSeq(pairingSocket)).toEqual([
      ["heartbeat", 1],
      ["tick", 2],
    ]);
    expect(sentEventSeq(readSocket)).toEqual([
      ["chat", 1],
      ["presence", 2],
      ["presence", 3],
      ["heartbeat", 4],
      ["chat.side_result", 5],
      ["tick", 6],
    ]);
  });

  it("reuses the same payload shape while assigning per-client seq values", () => {
    const firstSocket = makeRecordingSocket();
    const secondSocket = makeRecordingSocket();
    const thirdSocket = makeRecordingSocket();
    const clients = makeOperatorWsClients([
      { connId: "c-1", socket: firstSocket, scopes: ["operator.read"] },
      { connId: "c-2", socket: secondSocket, scopes: ["operator.write"] },
      { connId: "c-3", socket: thirdSocket, scopes: ["operator.admin"] },
    ]);
    const payloadKeys: string[] = [];
    const payload = {
      toJSON(key: string) {
        payloadKeys.push(key);
        return { foo: key };
      },
    };

    const { broadcast } = createGatewayBroadcaster({ clients });
    broadcast("talk.mode", { enabled: true });
    broadcast("chat", payload);

    expect(payloadKeys).toEqual(["payload"]);
    const lastFrames = [firstSocket, secondSocket, thirdSocket].map((socket) => socket.sent.at(-1));
    expect(lastFrames.map((frame) => frame?.payload)).toEqual([
      { foo: "payload" },
      { foo: "payload" },
      { foo: "payload" },
    ]);
    expect(lastFrames.map((frame) => frame?.seq)).toEqual([1, 2, 2]);
  });
});

test("chat run registry queues and removes runs per session", () => {
  const registry = createChatRunState().registry;

  registry.add("s1", { sessionKey: "main", clientRunId: "c1" });
  registry.add("s1", { sessionKey: "main", clientRunId: "c2" });

  expect(registry.peek("s1")?.clientRunId).toBe("c1");
  expect(registry.shift("s1")?.clientRunId).toBe("c1");
  expect(registry.peek("s1")?.clientRunId).toBe("c2");

  expect(registry.remove("s1", "c2")?.clientRunId).toBe("c2");
  expect(registry.peek("s1")).toBeUndefined();
});

test("returns success for late unknown invoke ids for both success and error payloads", async () => {
  const nodeId = "node-123";
  const cases = [
    {
      id: "unknown-invoke-id-12345",
      ok: true,
      payloadJSON: JSON.stringify({ result: "late" }),
    },
    {
      id: "another-unknown-invoke-id",
      ok: false,
      error: { code: "FAILED", message: "test error" },
    },
  ] as const;

  for (const params of cases) {
    const respond = vi.fn<GatewayMethodTypes.RespondFn>();
    const context = {
      nodeRegistry: { handleInvokeResult: () => false },
      logGateway: { debug: vi.fn() },
    } as unknown as GatewayMethodTypes.GatewayRequestContext;
    const client = {
      connect: { device: { id: nodeId } },
    } as unknown as GatewayMethodTypes.GatewayClient;

    await handleNodeInvokeResult({
      req: { method: "node.invoke.result" } as unknown as RequestFrame,
      params: { ...params, nodeId } as unknown as Record<string, unknown>,
      client,
      isWebchatConnect: () => false,
      respond,
      context,
    });

    expect(respond.mock.lastCall).toEqual([true, { ok: true, ignored: true }, undefined]);
  }
});

describe("resolveNodeCommandAllowlist", () => {
  it.each<
    [
      name: string,
      metadata: Parameters<typeof resolveNodeCommandAllowlist>[1],
      allowed: string[],
      denied: string[],
      config?: Parameters<typeof resolveNodeCommandAllowlist>[0],
    ]
  >([
    [
      "includes Android notifications and diagnostics by default",
      { platform: "Android 16", deviceFamily: "Android" },
      [
        "notifications.list",
        "notifications.actions",
        "device.permissions",
        "device.health",
        "device.apps",
        "callLog.search",
        "system.notify",
      ],
      ["sms.search"],
    ],
    [
      "allows safe Windows commands but gates dangerous media",
      {
        platform: "windows",
        deviceFamily: "Windows",
        approvedCommands: ["screen.snapshot", "system.run", "system.which"],
      },
      [
        "camera.list",
        "location.get",
        "device.info",
        "device.status",
        "screen.snapshot",
        "system.run",
        "system.which",
        "system.notify",
      ],
      ["canvas.present", "canvas.a2ui.pushJSONL", ...DEFAULT_DANGEROUS_NODE_COMMANDS],
    ],
    [
      "can explicitly allow dangerous commands",
      { platform: "ios", deviceFamily: "iPhone" },
      ["camera.snap", "screen.record"],
      ["camera.clip"],
      { gateway: { nodes: { commands: { allow: ["camera.snap", "screen.record"] } } } },
    ],
    [
      "fails safe for unknown/confusable metadata",
      { platform: "iPhοne", deviceFamily: "iPhοne" },
      ["system.notify"],
      ["system.run", "system.which"],
    ],
    [
      "normalizes dotted-I platform values to iOS",
      { platform: "İOS", deviceFamily: "iPhone" },
      ["device.info"],
      ["system.run", "system.which"],
    ],
  ])("%s", (_name, metadata, allowed, denied, config = {}) => {
    const allow = resolveNodeCommandAllowlist(config, metadata);
    for (const command of allowed) {
      expect(allow.has(command), command).toBe(true);
    }
    for (const command of denied) {
      expect(allow.has(command), command).toBe(false);
    }
  });

  it("allows macOS screen.snapshot by default but keeps screen.record gated", () => {
    const allow = resolveNodeCommandAllowlist(
      {},
      {
        platform: "macOS 26.3.1",
        deviceFamily: "Mac",
        approvedCommands: ["screen.snapshot"],
      },
    );
    expect(DEFAULT_DANGEROUS_NODE_COMMANDS).not.toContain("screen.snapshot");
    expect(DEFAULT_DANGEROUS_NODE_COMMANDS).toEqual(
      expect.arrayContaining(["screen.record", "health.summary"]),
    );
    expect([allow.has("screen.snapshot"), allow.has("screen.record")]).toEqual([true, false]);
  });
});

describe("normalizeVoiceWakeTriggers", () => {
  test("returns defaults when input is empty", () => {
    expect(normalizeVoiceWakeTriggers([])).toEqual(defaultVoiceWakeTriggers());
    expect(normalizeVoiceWakeTriggers(null)).toEqual(defaultVoiceWakeTriggers());
  });

  test("does not split surrogate pairs at the length limit", () => {
    const prefix = "x".repeat(63);
    expect(normalizeVoiceWakeTriggers([`${prefix}\u{1f600}`])).toEqual([prefix]);
  });
});
