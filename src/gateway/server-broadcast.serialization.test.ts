// Covers broadcast frame-serialization failure: an unserializable payload must
// not consume per-client seqs (which would fire every client's gap detector and
// cause a synchronized reconnect storm) and must leave a server-side record.
import { once } from "node:events";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { resolveSessionStorePathCore } from "../config/sessions.js";
import {
  deleteSessionEntryLifecycle,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setVerbose } from "../global-state.js";
import type { SystemPresence } from "../infra/system-presence.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPresenceRecipientProjection } from "./presence-projection.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { createSessionRowProjection } from "./session-row-projection.js";

const warnSpy = vi.hoisted(() => vi.fn());

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      if (subsystem !== "gateway/broadcast") {
        return logger;
      }
      return { ...logger, error: warnSpy };
    },
  };
});

type RecordingSocket = {
  readyState: number;
  bufferedAmount: number;
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  frames: Array<{ event: string; seq: number }>;
};

function makeClient(connId: string): { client: GatewayWsClient; socket: RecordingSocket } {
  const frames: Array<{ event: string; seq: number }> = [];
  const socket: RecordingSocket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    close: vi.fn(),
    send: vi.fn((payload: string) => {
      const frame = JSON.parse(payload) as { event: string; seq: number };
      frames.push({ event: frame.event, seq: frame.seq });
    }),
    frames,
  };
  return {
    client: {
      socket: socket as unknown as GatewayWsClient["socket"],
      connect: { role: "operator", scopes: ["operator.read"] } as GatewayWsClient["connect"],
      connId,
      usesSharedGatewayAuth: false,
    },
    socket,
  };
}

afterEach(() => {
  setVerbose(false);
  setLoggerOverride(null);
  resetLogger();
});

describe("broadcast serialization failures", () => {
  it.each(["operator.sessions.read", "operator.sessions.write"])(
    "requires current session authorization for content delivered with %s",
    (scope) => {
      const scoped = makeClient("scoped");
      scoped.client.connect.scopes = [scope];
      const staff = makeClient("staff");
      const clients = new GatewayClientRegistry([scoped.client, staff.client]);
      const { broadcast } = createGatewayBroadcaster({
        clients,
        canReceiveSessionEvent: (client, keys) =>
          client === staff.client || keys.every((key) => key === "agent:main:visible"),
      });
      for (const event of ["agent", "chat", "session.message", "session.tool"]) {
        broadcast(event, { text: "Unscoped content" });
        broadcast(event, { sessionKey: "agent:main:hidden", text: "Hidden content" });
      }
      expect(scoped.socket.send).not.toHaveBeenCalled();
      expect(staff.socket.send).toHaveBeenCalledTimes(8);
      broadcast("chat", { sessionKey: "agent:main:visible", text: "Visible content" });
      expect(scoped.socket.frames).toEqual([{ event: "chat", seq: 1 }]);

      const unbound = createGatewayBroadcaster({ clients });
      unbound.broadcast("chat", { sessionKey: "agent:main:visible", text: "No read owner" });
      expect(scoped.socket.send).toHaveBeenCalledTimes(1);
    },
  );

  it("limits keyless session delivery to redacted and targeted personal invalidations", () => {
    const scoped = makeClient("scoped");
    scoped.client.connect.scopes = ["operator.sessions.read"];
    const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([scoped.client]),
    });
    const recipients = new Set([scoped.client.connId]);
    const getter = vi.fn(() => "Hidden content");
    const dynamic = Object.defineProperty({ reason: "delete" }, "content", {
      enumerable: true,
      get: getter,
    });
    broadcast("sessions.changed", { reason: "delete" });
    broadcast("users.prefs.changed", { profileId: "other", keys: ["ui.theme"] });
    broadcast("chat.metadata.changed", { content: "Hidden content" });
    broadcastToConnIds("sessions.changed", dynamic, recipients);
    expect(scoped.socket.send).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
    broadcast("chat.metadata.changed", {});
    broadcastToConnIds("sessions.changed", { reason: "delete", ts: 1 }, recipients);
    broadcastToConnIds(
      "users.prefs.changed",
      { profileId: "owner", keys: ["ui.theme"] },
      recipients,
    );
    expect(scoped.socket.frames).toEqual([
      { event: "chat.metadata.changed", seq: 1 },
      { event: "sessions.changed", seq: 2 },
      { event: "users.prefs.changed", seq: 3 },
    ]);
  });

  it("keeps recipient session permissions separate at the same sequence and profile", () => {
    const first = makeClient("first");
    const second = makeClient("second");
    const origin = { label: "Control UI", provider: "webchat", chatType: "direct" };
    const snapshotToJSON = vi.fn(() => origin);
    const session = {
      key: "agent:main:chat",
      sessionId: "session-chat",
      kind: "direct",
      label: "Release planning",
      updatedAt: 1_800_000_000_000,
      snapshotAt: 1_800_000_000_001,
      modelProvider: "openai",
      model: "gpt-5",
      totalTokens: 2048,
      totalTokensFresh: true,
      origin: { ...origin, toJSON: snapshotToJSON },
    };
    const source = { sessionKey: session.key, reason: "update", session };
    const stateVersion = { presence: 3 };
    for (const peer of [first, second]) {
      peer.client.preparedRecipientProfileId = "same-profile";
    }
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([first.client, second.client]),
      prepareSessionEventProjection: () => (client) => ({
        payload: {
          ...source,
          session: {
            ...session,
            sharingRole: client === first.client ? "owner" : "viewer",
          },
        },
      }),
    });

    broadcast("sessions.changed", source, { stateVersion });

    for (const [peer, sharingRole] of [
      [first, "owner"],
      [second, "viewer"],
    ] as const) {
      expect(peer.socket.send).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify({
          type: "event",
          event: "sessions.changed",
          payload: { ...source, session: { ...session, origin, sharingRole } },
          seq: 1,
          stateVersion,
          recipientProfileId: "same-profile",
        }),
        expect.any(Function),
      );
    }
    expect(snapshotToJSON).toHaveBeenCalledTimes(2);
  });

  it("does not serialize suppressed session snapshots or consume their sequences", () => {
    const peers = [makeClient("first"), makeClient("second")];
    const snapshotToJSON = vi.fn(() => ({ label: "Private session", provider: "webchat" }));
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry(peers.map(({ client }) => client)),
      prepareSessionEventProjection: (event) =>
        event === "sessions.changed" ? () => undefined : undefined,
    });

    broadcast("sessions.changed", {
      sessionKey: "agent:main:hidden",
      session: {
        key: "agent:main:hidden",
        updatedAt: 1_800_000_000_000,
        origin: { toJSON: snapshotToJSON },
      },
    });

    for (const peer of peers) {
      expect(peer.socket.send).not.toHaveBeenCalled();
    }
    broadcast("skills.changed", { reason: "visible" });
    for (const peer of peers) {
      expect(peer.socket.frames).toEqual([{ event: "skills.changed", seq: 1 }]);
    }
    expect(snapshotToJSON).not.toHaveBeenCalled();
  });

  it.each([
    [
      "first",
      {
        message: {
          text: '"🦞"\n\\\ud800'.repeat(256),
          items: [undefined, Symbol("omitted")],
        },
      },
    ],
    ["middle", { sessionKey: "agent:main:chat", message: null, omitted: undefined }],
    ["last", { sessionKey: "agent:main:chat", omitted: undefined, message: undefined }],
    ["native property key", { message: { toJSON: (key: string) => ({ key }) } }],
    ["absent", { sessionKey: "agent:main:chat", ["__proto__"]: { text: "ordinary field" } }],
  ])("preserves projected envelope bytes with the message %s", (position, source) => {
    const peers = [makeClient("owner"), makeClient("viewer")];
    const project = (client: GatewayWsClient) => {
      const session = { key: "agent:main:chat", sharingRole: client.connId };
      return position === "last" ? { session, ...source } : { ...source, session };
    };
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry(peers.map(({ client }) => client)),
      prepareSessionEventProjection: () => (client) => ({ payload: project(client) }),
    });
    const stateVersion = { presence: 3 };
    for (const peer of peers) {
      peer.client.preparedRecipientProfileId = "same-profile";
    }

    broadcast("session.message", source, { stateVersion });

    for (const peer of peers) {
      expect(peer.socket.send.mock.calls[0]?.[0]).toBe(
        JSON.stringify({
          type: "event",
          event: "session.message",
          payload: project(peer.client),
          seq: 1,
          stateVersion,
          recipientProfileId: "same-profile",
        }),
      );
    }
  });

  it.each(["getter", "toJSON", "proxy"])(
    "observes %s message mutations between recipients when long strings repeat",
    (publisher) => {
      const peers = [makeClient("first"), makeClient("second"), makeClient("third")];
      const initial = '"🦞"\n\\\ud800'.repeat(256);
      let current = initial;
      const reads: string[] = [];
      const read = () => {
        reads.push(current);
        return current;
      };
      const message =
        publisher === "getter"
          ? {
              get text() {
                return read();
              },
            }
          : publisher === "toJSON"
            ? {
                toJSON(key: string) {
                  expect(key).toBe("message");
                  return { text: read() };
                },
              }
            : new Proxy(
                { text: initial },
                {
                  get(target, key, receiver) {
                    return key === "text" ? read() : Reflect.get(target, key, receiver);
                  },
                },
              );
      const source = { message };
      const { broadcast } = createGatewayBroadcaster({
        clients: new GatewayClientRegistry(peers.map(({ client }) => client)),
        prepareSessionEventProjection: () => (client) => ({
          payload: { ...source, session: { sharingRole: client.connId } },
        }),
      });
      peers[0]!.socket.send.mockImplementationOnce(() => {
        current = initial + " changed";
      });
      peers[1]!.socket.send.mockImplementationOnce(() => {
        current = initial;
      });

      broadcast("session.message", source);

      expect(reads).toEqual([initial, initial + " changed", initial]);
      for (const [index, peer] of peers.entries()) {
        expect(peer.socket.send.mock.calls[0]?.[0]).toBe(
          JSON.stringify({
            type: "event",
            event: "session.message",
            payload: {
              message: { text: reads[index] },
              session: { sharingRole: peer.client.connId },
            },
            seq: 1,
          }),
        );
      }
    },
  );

  it.each(["message", "first recipient", "second recipient", "source toJSON", "recipient profile"])(
    "records only delivered projections and sequences when %s cannot serialize",
    (failure) => {
      warnSpy.mockClear();
      const first = makeClient("first");
      const second = makeClient("second");
      const delivered = vi.fn();
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const source = { message: failure === "message" ? circular : { content: "visible" } };
      if (failure === "source toJSON") {
        Object.defineProperty(source, "toJSON", {
          value: () => {
            throw new Error("source toJSON failed");
          },
        });
      }
      if (failure === "recipient profile") {
        Object.defineProperty(first.client, "preparedRecipientProfileId", {
          configurable: true,
          get: () => {
            throw new Error("recipient profile failed");
          },
        });
      }
      const { broadcast } = createGatewayBroadcaster({
        clients: new GatewayClientRegistry([first.client, second.client]),
        prepareSessionEventProjection: (event) =>
          event === "session.message"
            ? (client) => ({
                payload: {
                  ...source,
                  session:
                    failure === `${client.connId} recipient`
                      ? circular
                      : { sharingRole: client.connId },
                },
                delivered: () => delivered(client.connId),
              })
            : undefined,
      });

      broadcast("session.message", source);
      expect(first.socket.send).toHaveBeenCalledTimes(failure === "second recipient" ? 1 : 0);
      expect(second.socket.send).not.toHaveBeenCalled();
      expect(delivered.mock.calls).toEqual(failure === "second recipient" ? [["first"]] : []);
      expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("broadcast serialization failed for event session.message"),
      );
      delete first.client.preparedRecipientProfileId;
      broadcast("skills.changed", { reason: "recovered" });
      expect(first.socket.frames.at(-1)).toEqual({
        event: "skills.changed",
        seq: failure === "second recipient" ? 2 : 1,
      });
      expect(second.socket.frames).toEqual([{ event: "skills.changed", seq: 1 }]);
    },
  );

  it("preserves projected message delivery through reentrant sends and later broadcasts", () => {
    const first = makeClient("first");
    const second = makeClient("second");
    const lastDelivered = new Map<string, string>();
    let message = { content: "outer" };
    const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([first.client, second.client]),
      prepareSessionEventProjection: () => {
        const current = message;
        return (client) => ({
          payload: {
            message: current,
            session: { sharingRole: client.connId },
            previousMessage: lastDelivered.get(client.connId),
          },
          delivered: () => lastDelivered.set(client.connId, current.content),
        });
      },
    });
    first.socket.send.mockImplementationOnce(() => {
      message = { content: "inner" };
      broadcastToConnIds("session.message", { message }, new Set(["first"]));
    });

    broadcast("session.message", { message });
    message = { content: "later" };
    broadcast("session.message", { message });

    const delivered = (peer: ReturnType<typeof makeClient>) =>
      peer.socket.send.mock.calls.map(([frame]) => {
        const parsed = JSON.parse(frame);
        return [
          parsed.payload.message.content,
          parsed.seq,
          parsed.payload.session.sharingRole,
          parsed.payload.previousMessage,
        ];
      });
    expect(delivered(first)).toEqual([
      ["outer", 1, "first", undefined],
      ["inner", 2, "first", "outer"],
      ["later", 3, "first", "inner"],
    ]);
    expect(delivered(second)).toEqual([
      ["outer", 1, "second", undefined],
      ["later", 2, "second", "outer"],
    ]);
  });

  it.each(
    ["session.message", "sessions.changed"].flatMap((event) =>
      ["own accessor", "inherited accessor", "proxy"].map((publisher) => ({ event, publisher })),
    ),
  )(
    "keeps native $event source serialization and stateVersion ordering for $publisher publishers",
    ({ event, publisher }) => {
      for (const throwOnRepeat of [false, true]) {
        const peer = makeClient("native-hook");
        const stateVersion = { presence: 1 };
        const projected = {
          sessionKey: "agent:main:hook",
          ...(event === "session.message"
            ? { message: { content: "projected" } }
            : { session: { key: "agent:main:hook", label: "Projected session" } }),
        };
        const source = { sessionKey: projected.sessionKey };
        let read = false;
        const readToJSON = () => {
          if (read && throwOnRepeat) {
            throw new Error("repeated source hook lookup");
          }
          read = true;
          stateVersion.presence = 9;
          return () => ({ source: "serialized" });
        };
        let payload = source;
        if (publisher === "proxy") {
          payload = new Proxy(source, {
            get(target, property, receiver) {
              return property === "toJSON" ? readToJSON() : Reflect.get(target, property, receiver);
            },
            getPrototypeOf() {
              throw new Error("unexpected source prototype lookup");
            },
            has() {
              throw new Error("unexpected source property lookup");
            },
          });
        } else {
          const owner = publisher === "own accessor" ? source : {};
          Object.defineProperty(owner, "toJSON", { get: readToJSON });
          if (publisher === "inherited accessor") {
            Object.setPrototypeOf(source, owner);
          }
        }
        const { broadcast } = createGatewayBroadcaster({
          clients: new GatewayClientRegistry([peer.client]),
          prepareSessionEventProjection: () => () => ({ payload: projected }),
        });

        broadcast(event, payload, { stateVersion });

        expect.soft(peer.socket.send).toHaveBeenCalledExactlyOnceWith(
          JSON.stringify({
            type: "event",
            event,
            payload: projected,
            seq: 1,
            stateVersion: { presence: 1 },
          }),
          expect.any(Function),
        );
      }
    },
  );

  it("keeps reentrant targeted frames separate from an in-progress fanout at the same sequence", () => {
    const first = makeClient("first");
    const second = makeClient("second");
    const third = makeClient("third");
    const peers = [first, second, third];
    const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry(peers.map((peer) => peer.client)),
    });
    broadcastToConnIds("skills.changed", { reason: "prime" }, new Set(["second", "third"]));
    peers.forEach((peer) => peer.socket.send.mockClear());
    first.socket.send.mockImplementationOnce(() => {
      broadcastToConnIds("skills.changed", { reason: "inner" }, new Set(["first"]));
    });

    broadcast("skills.changed", { reason: "outer" });

    const encode = (reason: string, seq: number) =>
      JSON.stringify({ type: "event", event: "skills.changed", payload: { reason }, seq });
    expect(first.socket.send.mock.calls.map(([frame]) => frame)).toEqual([
      encode("outer", 1),
      encode("inner", 2),
    ]);
    for (const peer of [second, third]) {
      expect(peer.socket.send.mock.calls.map(([frame]) => frame)).toEqual([encode("outer", 2)]);
    }
  });

  it.each([
    ["undefined", undefined],
    ["escaped values", { text: '"🦞"\n\\\ud800', items: [undefined, Symbol("omitted")] }],
    ["date", new Date("2026-01-01T00:00:00Z")],
    [
      "inherited toJSON",
      new (class {
        toJSON(key: string) {
          return `field:${key}`;
        }
      })(),
    ],
    ["omitted toJSON", { toJSON: () => undefined }],
  ])("preserves complete envelope bytes for %s payloads", (_name, payload) => {
    const peer = makeClient("json-reader");
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([peer.client]),
    });
    const stateVersion = {
      presence: 7,
      toJSON: (key: string) => ({ presence: key.length }),
    };

    broadcast("skills.changed", payload, { stateVersion });

    expect(peer.socket.send.mock.calls[0]?.[0]).toBe(
      JSON.stringify({ type: "event", event: "skills.changed", payload, seq: 1, stateVersion }),
    );
  });

  it("delivers public suspension state to connected operators without read scope", () => {
    const peer = makeClient("suspension-viewer");
    peer.client.connect.scopes = [];
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([peer.client]),
    });
    broadcast("gateway.suspension", { phase: "prepared" });
    expect(peer.socket.send).toHaveBeenCalledOnce();
    expect(JSON.parse(peer.socket.send.mock.calls[0]![0])).toMatchObject({
      type: "event",
      event: "gateway.suspension",
      seq: 1,
      payload: { phase: "prepared" },
    });
  });

  it("never sends raw presence when its owner projection is missing", () => {
    const peer = makeClient("unprepared");
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([peer.client]),
    });
    warnSpy.mockClear();
    broadcast("presence", {
      presence: [{ text: "watcher", ts: 1, watchedSessions: ["agent:main:hidden"] }],
    });
    expect(peer.socket.send).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("presence recipient projection unavailable"),
    );
    broadcast("skills.changed", {});
    expect(peer.socket.frames).toEqual([{ event: "skills.changed", seq: 1 }]);
  });
  it("skips closed sockets without disrupting healthy broadcast sequences", () => {
    const retired = makeClient("retired");
    const healthy = makeClient("healthy");
    const clients = new GatewayClientRegistry([retired.client, healthy.client]);
    const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({ clients });

    retired.socket.readyState = WebSocket.CLOSED;
    broadcast("skills.changed", { reason: "first" });
    broadcastToConnIds("skills.changed", { reason: "second" }, new Set(["healthy", "retired"]));

    expect(retired.socket.send).not.toHaveBeenCalled();
    expect(clients.has(retired.client)).toBe(true);
    expect(healthy.socket.frames).toEqual([
      { event: "skills.changed", seq: 1 },
      { event: "skills.changed", seq: 2 },
    ]);
  });

  it("keeps a real healthy peer delivering while rejecting closing and failed peers", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    const connectPeer = async () => {
      const accepted = once(server, "connection");
      const peer = new WebSocket(`ws://127.0.0.1:${address.port}`);
      await once(peer, "open");
      const [socket] = (await accepted) as [WebSocket];
      return { peer, socket };
    };
    const retired = await connectPeer();
    const broken = await connectPeer();
    const healthy = await connectPeer();
    const delivered: Array<{ event: string; seq: number }> = [];
    healthy.peer.on("message", (data: RawData) => {
      delivered.push(JSON.parse(rawDataToString(data)) as { event: string; seq: number });
    });
    const makeRealClient = (connId: string, socket: WebSocket): GatewayWsClient => ({
      connId,
      socket,
      connect: { role: "operator", scopes: ["operator.read"] } as GatewayWsClient["connect"],
      usesSharedGatewayAuth: false,
    });
    const retiredClient = makeRealClient("real-retired", retired.socket);
    const brokenClient = makeRealClient("real-broken", broken.socket);
    const healthyClient = makeRealClient("real-healthy", healthy.socket);
    const clients = new GatewayClientRegistry([retiredClient, brokenClient, healthyClient]);
    const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({ clients });

    try {
      warnSpy.mockClear();
      const brokenPeerClosed = vi.fn();
      broken.peer.once("close", brokenPeerClosed);
      vi.spyOn(broken.socket, "send").mockImplementationOnce(() => {
        throw new Error("injected synchronous send failure");
      });
      retired.socket.close(1000, "retiring peer");
      expect(retired.socket.readyState).toBe(WebSocket.CLOSING);
      const bufferedAtClose = retired.socket.bufferedAmount;

      broadcast("chat", {
        state: "final",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      });
      broadcastToConnIds("skills.changed", { reason: "targeted" }, new Set(["real-healthy"]));
      await vi.waitFor(() => expect(delivered).toHaveLength(2));
      await vi.waitFor(() => expect(brokenPeerClosed).toHaveBeenCalledOnce());

      expect(retired.socket.bufferedAmount).toBe(bufferedAtClose);
      expect(clients.has(retiredClient)).toBe(true);
      expect(delivered.map(({ event, seq }) => ({ event, seq }))).toEqual([
        { event: "chat", seq: 1 },
        { event: "skills.changed", seq: 2 },
      ]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("real-broken: injected synchronous send failure"),
        { event: "chat" },
      );

      let callbackError: Error | undefined;
      retired.socket.send("dependency-callback-proof", (error) => {
        callbackError = error;
      });
      expect(callbackError).toBeUndefined();
      await vi.waitFor(() => expect(callbackError).toBeInstanceOf(Error));
    } finally {
      retired.peer.terminate();
      broken.peer.terminate();
      healthy.peer.terminate();
      for (const activeSocket of server.clients) {
        activeSocket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it.each(["skills.changed", "session.message", "sessions.changed"])(
    "drops %s without consuming seqs when an unprojected payload cannot serialize",
    (event) => {
      warnSpy.mockClear();
      const first = makeClient("first");
      const second = makeClient("second");
      const clients = new GatewayClientRegistry([first.client, second.client]);
      const { broadcast } = createGatewayBroadcaster({ clients });

      const circular: Record<string, unknown> = {};
      circular.self = circular;
      broadcast(event, circular);

      // Neither socket saw the bad frame, and the failure is recorded once.
      expect(first.socket.send).not.toHaveBeenCalled();
      expect(second.socket.send).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain(event);

      // The next good broadcast starts at seq 1 for every client: the dropped
      // event consumed no seq, so no gap detector fires.
      broadcast("skills.changed", { reason: "recovered" });
      expect(first.socket.frames).toEqual([{ event: "skills.changed", seq: 1 }]);
      expect(second.socket.frames).toEqual([{ event: "skills.changed", seq: 1 }]);
    },
  );

  it("does not inspect agent log summaries for an ineligible outbound broadcast", () => {
    setVerbose(true);
    setLoggerOverride({ level: "silent", consoleLevel: "info" });
    const filtered = makeClient("filtered");
    filtered.client.connect.scopes = [];
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([filtered.client]),
    });
    let dataReads = 0;
    const payload = {
      runId: "run-1",
      stream: "assistant",
      get data() {
        dataReads += 1;
        return { text: "not delivered" };
      },
    };

    broadcast("agent", payload);

    expect(filtered.socket.send).not.toHaveBeenCalled();
    expect(dataReads).toBe(0);
  });
});

describe("presence recipient projection", () => {
  it.each(["chat.metadata.changed", "node.presence", "node.hostStats"])(
    "delivers %s only to readable operators",
    (event) => {
      const readers = [makeClient("reader"), makeClient("writer"), makeClient("admin")];
      readers[1]!.client.connect.scopes = ["operator.write"];
      readers[2]!.client.connect.scopes = ["operator.admin"];
      const denied = [makeClient("no-scope"), makeClient("node"), makeClient("pairing")];
      denied[0]!.client.connect.scopes = [];
      denied[1]!.client.connect.role = "node";
      denied[2]!.client.connect.scopes = ["operator.pairing"];
      const { broadcast } = createGatewayBroadcaster({
        clients: new GatewayClientRegistry([...readers, ...denied].map(({ client }) => client)),
      });
      broadcast(event, {});
      for (const peer of readers) {
        expect(JSON.parse(peer.socket.send.mock.lastCall![0])).toMatchObject({
          event,
          payload: {},
        });
      }
      for (const peer of denied) {
        expect(peer.socket.send).not.toHaveBeenCalled();
      }
    },
  );

  it("delivers mention invalidations only to targeted readable operators", () => {
    const readers = [makeClient("reader"), makeClient("writer"), makeClient("admin")];
    readers[1]!.client.connect.scopes = ["operator.write"];
    readers[2]!.client.connect.scopes = ["operator.admin"];
    const denied = [makeClient("no-scope"), makeClient("node"), makeClient("unrelated")];
    denied[0]!.client.connect.scopes = [];
    denied[1]!.client.connect.role = "node";
    const { broadcastToConnIds } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([...readers, ...denied].map(({ client }) => client)),
    });
    const payload = { gatewayInstanceId: "mention-gateway", revision: 1 };

    broadcastToConnIds(
      "mentions.changed",
      payload,
      new Set(["reader", "writer", "admin", "no-scope", "node"]),
    );

    for (const peer of readers) {
      expect(JSON.parse(peer.socket.send.mock.lastCall![0])).toMatchObject({
        event: "mentions.changed",
        payload,
        seq: 1,
      });
    }
    for (const peer of denied) {
      expect(peer.socket.send).not.toHaveBeenCalled();
    }
  });

  it("preserves scoped sentinels, recipient ordering, and current visibility without changing the source", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      let cfg: OpenClawConfig = { agents: { entries: { main: {}, work: {} } } };
      const sharedKey = "agent:main:shared";
      const incognitoKey = "agent:main:dashboard:incognito-presence";
      const keys = [
        sharedKey,
        incognitoKey,
        "agent:main:global",
        "agent:work:global",
        "agent:work:unknown",
      ];
      for (const [agentId, sessionKey, visibility] of [
        ["main", sharedKey, "shared"],
        ["main", incognitoKey, "shared"],
        ["main", "global", "draft"],
        ["work", "global", "read-only"],
        ["work", "unknown", "suggest"],
      ] as const) {
        await upsertSessionEntryCore(
          { agentId, sessionKey },
          {
            sessionId: `${agentId}-${sessionKey}`,
            updatedAt: 1,
            visibility,
            createdVia: "operator",
            createdActor: { type: "human", source: "profile", id: "creator" },
          },
        );
      }
      const reader = makeClient("reader");
      reader.client.authenticatedUserProfile = {
        profileId: ensureProfileForEmail("presence-reader@example.test").id,
        displayName: "Reader",
        avatarRevision: "1",
        hasAvatar: false,
        updatedAt: 1,
      };
      const admin = makeClient("admin");
      admin.client.connect.scopes = ["operator.admin"];
      const connection = createGatewayConnectionState({
        scheduler: createTestGatewayScheduler(),
        bootId: "presence-projection",
        cfg,
        getRuntimeConfig: () => cfg,
      });
      const projection = await createSessionRowProjection({
        cfg,
        modelCatalog: [],
        getPolicyConfig: () => cfg,
      });
      onTestFinished(() => projection.dispose());
      onTestFinished(connection.attachSessionRowProjection(projection));
      onTestFinished(() => connection.mentionInbox.dispose());
      const person = {
        text: "watcher",
        ts: 42,
        onlineSince: 30,
        lastActivityAt: 40,
        timeZone: "Europe/Vienna",
        instanceId: "watcher",
        user: { id: "creator", name: "Creator" },
      };
      const watcher = { ...person, watchedSessions: [...keys, "agent:main:deleted"] };
      const presence = [watcher, { ...person, text: "idle", instanceId: "idle", ts: 41 }];
      Object.freeze(watcher.watchedSessions);
      presence.forEach(Object.freeze);
      Object.freeze(presence);
      const payload = { presence };
      const stateVersion = { presence: 7, health: 3 };
      const lastFrame = (peer: ReturnType<typeof makeClient>) =>
        // SAFETY: These sockets record JSON frames emitted by the real presence broadcaster below.
        JSON.parse(peer.socket.send.mock.lastCall![0]) as {
          payload: { presence: SystemPresence[] };
          seq: number;
          stateVersion: typeof stateVersion;
        };
      for (const order of [
        [reader, admin],
        [admin, reader],
      ]) {
        connection.clients.clear();
        order.forEach((peer) => connection.clients.add(peer.client));
        connection.broadcast("presence", payload, { stateVersion });
        expect(lastFrame(reader).payload.presence).toEqual([
          { ...person, watchedSessions: [sharedKey, "agent:work:global", "agent:work:unknown"] },
          presence[1],
        ]);
        expect(lastFrame(admin).payload.presence).toEqual([
          { ...person, watchedSessions: keys },
          presence[1],
        ]);
        expect(lastFrame(reader).stateVersion).toEqual(stateVersion);
      }
      await patchSessionEntryCore({ agentId: "main", sessionKey: sharedKey }, () => ({
        visibility: "draft",
      }));
      await deleteSessionEntryLifecycle({
        agentId: "work",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "work" }),
        target: { canonicalKey: "global", storeKeys: ["global"] },
        archiveTranscript: false,
      });
      connection.broadcast("presence", payload);
      expect(lastFrame(reader).payload.presence).toEqual([
        { ...person, watchedSessions: ["agent:work:unknown"] },
        presence[1],
      ]);
      expect(lastFrame(admin).payload.presence[0]?.watchedSessions).toEqual(
        keys.filter((key) => key !== "agent:work:global"),
      );

      cfg = {
        ...cfg,
        gateway: {
          roles: {
            default: "restricted",
            definitions: {
              restricted: { sessions: { others: "none" }, agents: "*", scopes: ["operator.read"] },
            },
          },
        },
      };
      connection.broadcastToConnIds("presence", payload, new Set([reader.client.connId]), {
        stateVersion,
      });
      expect(lastFrame(reader)).toEqual({
        type: "event",
        event: "presence",
        payload: { presence: [person, presence[1]] },
        seq: 4,
        stateVersion,
      });
      expect(lastFrame(admin).seq).toBe(3);
      expect(watcher.watchedSessions).toEqual([...keys, "agent:main:deleted"]);
    });
  });

  it("keeps solo and system authority without treating pending identity or missing read scope as solo", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const key = "agent:main:private";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: key },
        {
          sessionId: "private",
          updatedAt: 1,
          visibility: "draft",
          createdVia: "operator",
          createdActor: { type: "human", source: "profile", id: "creator" },
        },
      );
      const person = {
        text: "watcher",
        ts: 3,
        onlineSince: 1,
        lastActivityAt: 2,
        timeZone: "Europe/Vienna",
        user: { id: "creator" },
      };
      const idle = { ...person, text: "idle" };
      const presence = [{ ...person, watchedSessions: [key] }, idle];
      const solo = makeClient("solo").client;
      solo.connect.scopes = ["operator.write"];
      const pending = makeClient("pending").client;
      pending.authenticatedGitHubIdentitySync = async () => ({
        profileId: "creator",
        updatedAt: 1,
      });
      const node = makeClient("node").client;
      node.connect.role = "node";
      node.connect.scopes = ["operator.admin"];
      const noRead = makeClient("no-read").client;
      noRead.connect.scopes = [];
      const worker = makeClient("worker").client;
      worker.connect.role = "worker";
      worker.connect.scopes = [];
      worker.connectionKind = "worker";
      let policy: OpenClawConfig = {};
      const projection = await createSessionRowProjection({
        cfg: policy,
        modelCatalog: [],
        getPolicyConfig: () => policy,
      });
      onTestFinished(() => projection.dispose());
      const project = createPresenceRecipientProjection({ cfg: policy, presence, projection });
      expect(project(solo)).toEqual(presence);
      solo.connect.scopes = [];
      expect(project(solo)).toEqual([]);
      solo.connect.scopes = ["operator.write"];
      expect(project(solo)).toEqual(presence);
      expect(project(pending)).toEqual([person, idle]);
      for (const client of [node, worker, noRead, null]) {
        expect(project(client)).toEqual([]);
      }
      pending.connect.scopes = ["operator.admin"];
      expect(project(pending)).toEqual(presence);
      const cfg: OpenClawConfig = { gateway: { roles: { definitions: {} } } };
      policy = cfg;
      const restrictedProject = createPresenceRecipientProjection({ cfg, presence, projection });
      expect(restrictedProject(solo)).toEqual([person, idle]);
      solo.internal = { operatorRoleActor: { kind: "system" } };
      expect(restrictedProject(solo)).toEqual(presence);
      pending.authenticatedUserProfile = {
        profileId: "creator",
        displayName: null,
        avatarRevision: "1",
        hasAvatar: false,
        updatedAt: 1,
      };
      pending.connect.scopes = ["operator.read"];
      expect(project(pending)).toEqual(presence);
    });
  });

  it("omits obsolete watches without creating missing agent stores or omission metadata", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const person = { text: "watcher", ts: 1 };
      const params = {
        cfg: { agents: { entries: { uncreated: {} } } },
        presence: [
          { ...person, watchedSessions: ["agent:uncreated:missing"] },
          { ...person, watchedSessions: [] },
          person,
        ],
      };
      const project = createPresenceRecipientProjection(params);
      const admin = makeClient("admin").client;
      admin.connect.scopes = ["operator.admin"];
      expect(project(admin)).toEqual([person, person, person]);
      expect(existsSync(state.agentDir("uncreated"))).toBe(false);
    });
  });
});
