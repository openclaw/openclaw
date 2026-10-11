// Covers broadcast frame-serialization failure: an unserializable payload must
// not consume per-client seqs (which would fire every client's gap detector and
// cause a synchronized reconnect storm) and must leave a server-side record.
import { once } from "node:events";
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
import type { SystemPresence } from "../infra/system-presence.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPresenceRecipientProjection } from "./presence-projection.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { makeClient as makePresenceClient } from "./server-broadcast.test-helpers.js";
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

describe("broadcast serialization failures", () => {
  it("requires current session authorization for session-scoped writers", () => {
    const scope = "operator.sessions.write";
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
  });

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

  it("observes message mutations between recipients when long strings repeat", () => {
    const peers = [makeClient("first"), makeClient("second"), makeClient("third")];
    const initial = '"🦞"\n\\\ud800'.repeat(256);
    let current = initial;
    const reads: string[] = [];
    const read = () => {
      reads.push(current);
      return current;
    };
    const message = {
      get text() {
        return read();
      },
    };
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
    const binaryFrames: boolean[] = [];
    healthy.peer.on("message", (data: RawData, isBinary: boolean) => {
      binaryFrames.push(isBinary);
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
      expect(binaryFrames).toEqual([false, false]);
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

  it("drops unserializable payloads without consuming recipient sequences", () => {
    const event = "skills.changed";
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
  });
});

describe("presence recipient projection", () => {
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
});

describe("presence payload encoding", () => {
  afterEach(() => vi.restoreAllMocks());
  it("encodes each presence audience once while retaining current authority and recipient stamps", () => {
    const peers = ["first", "second", "revoked", "pending"].map((id) =>
      makePresenceClient(id, "operator", ["operator.read"]),
    );
    const visible = [{ text: "watcher", ts: 1, watchedSessions: ["agent:main:shared"] }];
    const hidden = [{ text: "watcher", ts: 1 }];
    let revoked = false;
    const project = vi.fn((client: GatewayWsClient) =>
      client.connId === "pending" || (client.connId === "revoked" && revoked) ? hidden : visible,
    );
    const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry(peers.map(({ client }) => client)),
      preparePresenceProjection: () => project,
    });
    peers.forEach(({ client }) => {
      client.preparedRecipientProfileId = client.connId;
    });
    broadcastToConnIds("tick", {}, new Set(["second"]));
    peers[0]!.socket.send.mockImplementationOnce(() => {
      revoked = true;
    });
    const stringify = vi.spyOn(JSON, "stringify");
    const encode = vi.spyOn(Buffer, "from");
    const stateVersion = { presence: 3 };
    broadcast("presence", { presence: visible }, { stateVersion });
    const encodings = stringify.mock.calls.filter(
      ([value]) => value?.payload?.presence === visible || value?.payload?.presence === hidden,
    );
    const byteEncodings = encode.mock.calls.filter(
      ([value]) => typeof value === "string" && value.includes('"presence":['),
    );
    stringify.mockRestore();
    encode.mockRestore();

    expect(encodings).toHaveLength(2);
    expect(byteEncodings.length).toBeLessThanOrEqual(2);
    expect(project).toHaveBeenCalledTimes(4);
    for (const [index, peer] of peers.entries()) {
      expect(Buffer.isBuffer(peer.socket.send.mock.lastCall![0])).toBe(true);
      expect(String(peer.socket.send.mock.lastCall![0])).toBe(
        JSON.stringify({
          type: "event",
          event: "presence",
          payload: { presence: index < 2 ? visible : hidden },
          seq: index === 1 ? 2 : 1,
          stateVersion,
          recipientProfileId: peer.client.connId,
        }),
      );
    }

    visible[0]!.ts = 2;
    broadcast("presence", { presence: visible });
    expect(JSON.parse(peers[0]!.socket.send.mock.lastCall![0]).payload.presence[0].ts).toBe(2);
  });

  it.each(["getter", "toJSON", "added field"])(
    "preserves presence payload %s changes between recipients",
    (publisher) => {
      const peers = [
        makePresenceClient("first", "operator", ["operator.read"]),
        makePresenceClient("second", "operator", ["operator.read"]),
      ];
      const presence = [{ text: "watcher", ts: 1 }];
      const hidden: SystemPresence[] = [];
      let authorized = true;
      let revision = 1;
      const reads: number[] = [];
      const source = { presence };
      if (publisher === "getter") {
        Object.defineProperty(source, "revision", {
          enumerable: true,
          get: () => {
            authorized = false;
            reads.push(revision);
            return revision;
          },
        });
      } else if (publisher === "toJSON") {
        Object.assign(source, {
          toJSON(key: string) {
            expect(key).toBe("payload");
            reads.push(revision);
            return { presence, revision };
          },
        });
      }
      peers[0]!.socket.send.mockImplementationOnce(() => {
        revision = 2;
        if (publisher === "added field") {
          Object.assign(source, { revision });
        }
      });
      const { broadcast } = createGatewayBroadcaster({
        clients: new GatewayClientRegistry(peers.map(({ client }) => client)),
        preparePresenceProjection: () => () => (authorized ? presence : hidden),
      });
      broadcast("presence", source);

      for (const [index, peer] of peers.entries()) {
        const expected =
          publisher === "added field" && index === 0
            ? { presence }
            : { presence: publisher === "getter" ? hidden : presence, revision: index + 1 };
        expect(JSON.parse(peer.socket.send.mock.lastCall![0]).payload).toEqual(expected);
      }
      expect(reads).toEqual(publisher === "added field" ? [] : [1, 2]);
    },
  );
});
