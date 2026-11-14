// Gateway miscellaneous tests cover shared utility edges around control UI,
// proxy state, node command policy, and server helper behavior.
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
    url: unknown;
    opts: unknown;
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

    constructor(url: unknown, opts: unknown) {
      wsMockState.last = {
        url,
        opts,
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

  function startGatewayClient(params: { url: string; tlsFingerprint?: string }) {
    const client = new GatewayClient({ ...params, deviceIdentity: null });
    client.start();
    return wsMockState.last;
  }

  function setCorporateNoProxy() {
    process.env["NO_PROXY"] = "corp.example.com";
    process.env["no_proxy"] = "corp.example.com";
  }

  function setGatewayOnlyProxyEnv() {
    process.env["HTTP_PROXY"] = "http://127.0.0.1:3128";
    process.env["HTTPS_PROXY"] = "http://127.0.0.1:3128";
  }

  function registerGatewayOnlyProxy() {
    return registerActiveManagedProxyUrl(new URL("http://127.0.0.1:3128"));
  }

  test("uses the admitted pairing identity for shared-auth connect failures", async () => {
    const source = await fs.readFile(
      new URL("./server/ws-connection/connect-session.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("deviceId: admittedNodePairing.identity.nodeId");
    expect(source).not.toContain("deviceId: authenticatedNodePairing.nodeId");
  });

  test("scopes IPv6 loopback bypass during Gateway-only proxy mode connection setup", () => {
    setCorporateNoProxy();
    setGatewayOnlyProxyEnv();
    const registration = registerGatewayOnlyProxy();

    try {
      const last = startGatewayClient({ url: "ws://[::1]:18789" }) as {
        noProxyDuringConstruction: unknown;
        httpProxyDuringConstruction: unknown;
        httpsProxyDuringConstruction: unknown;
      } | null;

      expect(last?.noProxyDuringConstruction).toBe("corp.example.com");
      expect(last?.httpProxyDuringConstruction).toBe("http://127.0.0.1:3128");
      expect(last?.httpsProxyDuringConstruction).toBe("http://127.0.0.1:3128");
      expect(process.env["NO_PROXY"]).toBe("corp.example.com");
      expect(process.env["no_proxy"]).toBe("corp.example.com");
      expect(process.env["HTTP_PROXY"]).toBe("http://127.0.0.1:3128");
      expect(process.env["HTTPS_PROXY"]).toBe("http://127.0.0.1:3128");
    } finally {
      stopActiveManagedProxyRegistration(registration);
    }
  });
});

type TestSocket = {
  readyState: number;
  bufferedAmount: number;
  send: (payload: string) => void;
  close: (code: number, reason: string) => void;
  terminate: () => void;
};

type EventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
};

type RecordingSocket = TestSocket & { sent: EventFrame[] };

function makeRecordingSocket(): RecordingSocket {
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

function makeGatewayWsClient(
  connId: string,
  socket: TestSocket,
  connect: GatewayWsClient["connect"],
): GatewayWsClient {
  return {
    socket: socket as unknown as GatewayWsClient["socket"],
    connect,
    connId,
    usesSharedGatewayAuth: false,
  };
}

function makeOperatorWsClient(connId: string, socket: TestSocket, scopes: string[]) {
  return makeGatewayWsClient(connId, socket, {
    role: "operator",
    scopes,
  } as GatewayWsClient["connect"]);
}

function makeOperatorWsClients(
  entries: Array<{ connId: string; socket: TestSocket; scopes: string[] }>,
) {
  return new GatewayClientRegistry(
    entries.map(({ connId, socket, scopes }) => makeOperatorWsClient(connId, socket, scopes)),
  );
}

function makeReadPairClients(
  first: { connId: string; socket: TestSocket; scopes: string[] },
  readSocket: TestSocket,
) {
  return makeOperatorWsClients([
    first,
    { connId: "c-read", socket: readSocket, scopes: ["operator.read"] },
  ]);
}

function makeScopedBroadcastClients() {
  const pairingSocket = makeRecordingSocket();
  const questionSocket = makeRecordingSocket();
  const nodeSocket = makeRecordingSocket();
  const readSocket = makeRecordingSocket();
  const talkSocket = makeRecordingSocket();
  const writeSocket = makeRecordingSocket();
  const adminSocket = makeRecordingSocket();
  const clients = new GatewayClientRegistry([
    makeOperatorWsClient("c-pairing", pairingSocket, ["operator.pairing"]),
    makeOperatorWsClient("c-questions", questionSocket, ["operator.questions"]),
    makeGatewayWsClient("c-node", nodeSocket, {
      role: "node",
      scopes: ["operator.read"],
    } as GatewayWsClient["connect"]),
    makeOperatorWsClient("c-read", readSocket, ["operator.read"]),
    makeOperatorWsClient("c-talk", talkSocket, ["operator.talk"]),
    makeOperatorWsClient("c-write", writeSocket, ["operator.write"]),
    makeOperatorWsClient("c-admin", adminSocket, ["operator.admin"]),
  ]);

  return {
    pairingSocket,
    questionSocket,
    nodeSocket,
    readSocket,
    talkSocket,
    writeSocket,
    adminSocket,
    clients,
  };
}

function makeScopedBroadcastContext() {
  const scoped = makeScopedBroadcastClients();
  const broadcaster = createGatewayBroadcaster({
    clients: scoped.clients,
    preparePresenceProjection: (presence) => () => presence,
  });
  return { ...scoped, ...broadcaster };
}

function sentEvents(socket: RecordingSocket) {
  return socket.sent.map((frame) => frame.event);
}

function expectSentEvents(socket: RecordingSocket, events: string[]) {
  expect(sentEvents(socket)).toEqual(events);
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
  it("keeps diagnostic health details on demand only for negotiated summary clients", () => {
    const sockets = Array.from({ length: 4 }, () => makeRecordingSocket());
    const clients = new GatewayClientRegistry(
      sockets.map((socket, index) => {
        const client = makeOperatorWsClient(`health-${index}`, socket, ["operator.read"]);
        client.connect.caps = index % 2 === 0 ? ["health-summary"] : [];
        return client;
      }),
    );
    const { broadcast } = createGatewayBroadcaster({ clients });
    const summary = {
      ok: true,
      ts: 123,
      channels: { telegram: { connected: false, lastError: "Synthetic disconnect" } },
      channelLabels: { telegram: "Telegram" },
      configReload: { hotReloadStatus: "active" },
    };
    const full = {
      ...summary,
      agents: [{ agentId: "main", heartbeat: { prompt: "Synthetic heartbeat instructions" } }],
      sessions: { path: "", count: 5000, recent: [] },
    };
    broadcast("health", full, { stateVersion: { health: 7 } });
    for (const [index, socket] of sockets.entries()) {
      expect(socket.sent).toEqual([
        expect.objectContaining({
          event: "health",
          seq: 1,
          stateVersion: { health: 7 },
          payload: index % 2 === 0 ? summary : full,
        }),
      ]);
    }
    expect(full.agents).toHaveLength(1);
    expect(full.sessions.count).toBe(5000);
  });

  it("exposes current buffered bytes for a targeted connection", () => {
    const socket = makeRecordingSocket();
    socket.bufferedAmount = 1234;
    const client = makeOperatorWsClient("c-admin", socket, ["operator.admin"]);
    const clients = new GatewayClientRegistry([client]);
    const { getBufferedAmount } = createGatewayBroadcaster({ clients });

    expect(getBufferedAmount("c-admin")).toBe(1234);
    clients.delete(client);
    expect(getBufferedAmount("c-admin")).toBeUndefined();
  });

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

  const readRecipients = ["readSocket", "writeSocket", "adminSocket"];
  const writeRecipients = ["writeSocket", "adminSocket"];
  const allRecipients = [
    "pairingSocket",
    "questionSocket",
    "nodeSocket",
    "readSocket",
    "talkSocket",
    "writeSocket",
    "adminSocket",
  ] as const;
  const eventCases: Array<{
    name: string;
    events: Array<[string, unknown]>;
    recipients: readonly string[];
    pluginScope?: "operator.read";
  }> = [
    {
      name: "requires operator.read for chat-class broadcast events",
      events: [
        ["chat", chatPayload()],
        ["agent", { type: "status", sessionKey: "agent:main:main" }],
        ["chat.send_timing", { phase: "dispatch-started", runId: "run-1" }],
        ["chat.side_result", chatSideResultPayload()],
      ],
      recipients: readRecipients,
    },
    {
      name: "requires operator.questions for question broadcasts",
      events: [
        ["question.requested", { id: "question-1" }],
        ["question.resolved", { id: "question-1", status: "expired" }],
      ],
      recipients: ["questionSocket", "adminSocket"],
    },
    {
      name: "allows plugin.* broadcast events for operator.write and operator.admin",
      events: [
        ["plugin.myplugin.custom", { data: "test" }],
        ["plugin.otherplugin.state", { state: "updated" }],
      ],
      recipients: writeRecipients,
    },
    {
      name: "honors explicit read scope for plugin lifecycle events",
      events: [["plugin.workboard.changed", { revision: 1 }]],
      recipients: readRecipients,
      pluginScope: "operator.read" as const,
    },
  ];
  it.each(eventCases)("$name", ({ events, recipients, ...options }) => {
    const context = makeScopedBroadcastContext();
    for (const [event, payload] of events) {
      if (options.pluginScope) {
        context.broadcastPluginEvent(event, payload, options.pluginScope);
      } else {
        context.broadcast(event, payload);
      }
    }
    for (const key of allRecipients) {
      expectSentEvents(
        context[key],
        recipients.includes(key) ? events.map(([event]) => event) : [],
      );
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
    const context = makeScopedBroadcastContext();
    const events: Array<[string, unknown, readonly string[]]> = [
      ["cron", { jobId: "job-1" }, readRecipients],
      ["talk.mode", { enabled: true }, ["talkSocket", ...writeRecipients]],
      ["voicewake.changed", { triggers: ["hello"] }, readRecipients],
      ["voicewake.routing.changed", { config: { routes: [] } }, readRecipients],
      ["heartbeat", { ts: 1 }, allRecipients],
      ["presence", { presence: [] }, readRecipients],
      ["health", { ok: true }, allRecipients],
      ["tick", { ts: 2 }, allRecipients],
      ["shutdown", { reason: "restart" }, allRecipients],
      [
        "update.available",
        {
          updateAvailable: {
            currentVersion: "2026.4.19",
            latestVersion: "2026.4.20",
            channel: "stable",
          },
        },
        allRecipients,
      ],
      ["unknown.future.event", { hidden: true }, []],
    ];
    for (const [event, payload] of events) {
      context.broadcast(event, payload);
    }
    for (const key of allRecipients) {
      expectSentEvents(
        context[key],
        events.filter(([, , recipients]) => recipients.includes(key)).map(([event]) => event),
      );
    }
  });

  it("keeps event seq contiguous per receiving client when scoped events are filtered", () => {
    const pairingSocket = makeRecordingSocket();
    const readSocket = makeRecordingSocket();

    const clients = makeReadPairClients(
      { connId: "c-pairing", socket: pairingSocket, scopes: ["operator.pairing"] },
      readSocket,
    );

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
    expect(firstSocket.sent.at(-1)?.payload).toEqual({ foo: "payload" });
    expect(secondSocket.sent.at(-1)?.payload).toEqual({ foo: "payload" });
    expect(thirdSocket.sent.at(-1)?.payload).toEqual({ foo: "payload" });
    expect([
      firstSocket.sent.at(-1)?.seq,
      secondSocket.sent.at(-1)?.seq,
      thirdSocket.sent.at(-1)?.seq,
    ]).toEqual([1, 2, 2]);
  });
});

describe("chat run registry", () => {
  test("queues and removes runs per session", () => {
    const registry = createChatRunState().registry;

    registry.add("s1", { sessionKey: "main", clientRunId: "c1" });
    registry.add("s1", { sessionKey: "main", clientRunId: "c2" });

    expect(registry.peek("s1")?.clientRunId).toBe("c1");
    expect(registry.shift("s1")?.clientRunId).toBe("c1");
    expect(registry.peek("s1")?.clientRunId).toBe("c2");

    expect(registry.remove("s1", "c2")?.clientRunId).toBe("c2");
    expect(registry.peek("s1")).toBeUndefined();
  });
});

describe("late-arriving invoke results", () => {
  test("returns success for unknown invoke ids for both success and error payloads", async () => {
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

      const [ok, rawPayload, error] = respond.mock.lastCall ?? [];
      const payload = rawPayload as { ok?: boolean; ignored?: boolean } | undefined;

      // Late-arriving results return success instead of error to reduce log noise.
      expect(ok).toBe(true);
      expect(error).toBeUndefined();
      expect(payload?.ok).toBe(true);
      expect(payload?.ignored).toBe(true);
    }
  });
});

describe("resolveNodeCommandAllowlist", () => {
  function expectAllowed(allow: { has: (cmd: string) => boolean }, commands: string[]) {
    for (const cmd of commands) {
      expect(allow.has(cmd)).toBe(true);
    }
  }

  function expectDenied(allow: { has: (cmd: string) => boolean }, commands: string[]) {
    for (const cmd of commands) {
      expect(allow.has(cmd)).toBe(false);
    }
  }

  function expectDangerousCommandsDenied(allow: { has: (cmd: string) => boolean }) {
    expectDenied(allow, DEFAULT_DANGEROUS_NODE_COMMANDS);
  }

  it("includes Android notifications and device diagnostics commands by default", () => {
    const allow = resolveNodeCommandAllowlist(
      {},
      {
        platform: "Android 16",
        deviceFamily: "Android",
      },
    );

    expectAllowed(allow, [
      "notifications.list",
      "notifications.actions",
      "device.permissions",
      "device.health",
      "device.apps",
      "callLog.search",
      "system.notify",
    ]);
    expectDenied(allow, ["sms.search"]);
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
    expect(DEFAULT_DANGEROUS_NODE_COMMANDS).toContain("screen.record");
    expect(DEFAULT_DANGEROUS_NODE_COMMANDS).toContain("health.summary");
    expect(allow.has("screen.snapshot")).toBe(true);
    expect(allow.has("screen.record")).toBe(false);
  });

  it("allows safe Windows companion commands by default but keeps dangerous media gated", () => {
    const allow = resolveNodeCommandAllowlist(
      {},
      {
        platform: "windows",
        deviceFamily: "Windows",
        approvedCommands: ["screen.snapshot", "system.run", "system.which"],
      },
    );

    expectDenied(allow, ["canvas.present"]);
    expectAllowed(allow, [
      "camera.list",
      "location.get",
      "device.info",
      "device.status",
      "screen.snapshot",
      "system.run",
      "system.which",
      "system.notify",
    ]);
    expectDangerousCommandsDenied(allow);
  });

  it("can explicitly allow dangerous commands via commands.allow", () => {
    const allow = resolveNodeCommandAllowlist(
      {
        gateway: {
          nodes: {
            commands: { allow: ["camera.snap", "screen.record"] },
          },
        },
      },
      { platform: "ios", deviceFamily: "iPhone" },
    );
    expect(allow.has("camera.snap")).toBe(true);
    expect(allow.has("screen.record")).toBe(true);
    expect(allow.has("camera.clip")).toBe(false);
  });

  it("treats unknown/confusable metadata as fail-safe for system.run defaults", () => {
    const allow = resolveNodeCommandAllowlist(
      {},
      {
        platform: "iPhοne",
        deviceFamily: "iPhοne",
      },
    );

    expectDenied(allow, ["system.run", "system.which"]);
    expectAllowed(allow, ["system.notify"]);
  });

  it("normalizes dotted-I platform values to iOS classification", () => {
    const allow = resolveNodeCommandAllowlist(
      {},
      {
        platform: "İOS",
        deviceFamily: "iPhone",
      },
    );

    expectDenied(allow, ["system.run", "system.which"]);
    expectAllowed(allow, ["device.info"]);
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
