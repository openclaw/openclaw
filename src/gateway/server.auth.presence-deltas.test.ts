import { once } from "node:events";
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterEach, expect, test, vi } from "vitest";
import { WebSocket } from "../../packages/gateway-client/src/websocket.test-support.js";
import type { PresenceUpdate } from "../../packages/gateway-protocol/src/presence-deltas.js";
import type { HelloOk } from "../../packages/gateway-protocol/src/schema/frames.js";
import type { PresenceEntry } from "../../packages/gateway-protocol/src/schema/snapshot.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { MAX_BUFFERED_BYTES } from "./server-constants.js";
import {
  BACKEND_GATEWAY_CLIENT,
  connectReq,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
  onceMessage,
  openWs,
  rpcReq,
  withGatewayServer,
} from "./server.auth.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type LegacyPresence = { presence: PresenceEntry[] };
type PresenceFrame = {
  type: "event";
  event: "presence";
  payload: PresenceUpdate | LegacyPresence;
  stateVersion: { presence: number };
};

function observePresence(socket: WebSocket) {
  const frames: PresenceFrame[] = [];
  socket.on("message", (data) => {
    const frame = JSON.parse(rawDataToString(data)) as PresenceFrame;
    if (frame.type === "event" && frame.event === "presence") {
      frames.push(frame);
    }
  });
  return frames;
}

function rowsInUpdate(payload: PresenceFrame["payload"]): PresenceEntry[] {
  return "presence" in payload
    ? payload.presence
    : payload.upsert.flatMap((row) => ("presence" in row ? [row.presence] : []));
}

function nextPresence(socket: WebSocket, matches: (row: PresenceEntry) => boolean) {
  return onceMessage<PresenceFrame>(
    socket,
    (frame) =>
      frame.type === "event" &&
      frame.event === "presence" &&
      // Field patches omit unchanged row identity; wait for this publication via the legacy peer.
      (!("presence" in frame.payload) || rowsInUpdate(frame.payload).some(matches)),
  );
}

function reconstruct(hello: HelloOk, frames: PresenceFrame[]): PresenceEntry[] {
  let version = hello.snapshot.stateVersion?.presence;
  let rows = hello.snapshot.presence;
  let entries = new Map<string, PresenceEntry>();
  for (const { payload, stateVersion } of frames) {
    expect(payload, "capable connections receive versioned presence payloads").toHaveProperty(
      "version",
    );
    if (!("version" in payload)) {
      throw new Error("capable connection received legacy presence");
    }
    expect(payload.version).toBe(stateVersion.presence);
    if ("reset" in payload) {
      expect(payload.keys).toHaveLength(payload.presence.length);
      entries = new Map(payload.keys.map((key, index) => [key, payload.presence[index]!]));
      rows = payload.presence;
    } else {
      expect(payload.base, "every delivered delta chains from the previous version").toBe(version);
      for (const key of payload.remove) {
        entries.delete(key);
      }
      for (const entry of payload.upsert) {
        if ("presence" in entry) {
          entries.set(entry.key, entry.presence);
        } else {
          const before = entries.get(entry.key);
          expect(before).toBeDefined();
          const row: PresenceEntry & Record<string, unknown> = { ...before!, ...entry.set };
          for (const field of entry.unset) {
            delete row[field];
          }
          entries.set(entry.key, row);
        }
      }
      expect(new Set(payload.order)).toEqual(new Set(entries.keys()));
      rows = payload.order.map((key) => entries.get(key)!);
    }
    version = payload.version;
  }
  return rows;
}

test("delivers equivalent presence through deltas, resets after backpressure, and reconnects from hello", async () => {
  const identityDir = tempDirs.make("presence-deltas-");
  const serverSockets = new Map<string, WebSocket>();
  // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply below preserves the intercepted socket receiver.
  const originalSend = WebSocket.prototype.send;
  const sendSpy = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
    this: WebSocket,
    ...args: Parameters<WebSocket["send"]>
  ) {
    if (typeof args[0] === "string" && args[0].includes('"hello-ok"')) {
      const frame = JSON.parse(args[0]) as { payload: HelloOk };
      serverSockets.set(frame.payload.server.connId, this);
    }
    Reflect.apply(originalSend, this, args);
  });
  try {
    await withGatewayServer(async ({ port }) => {
      const sockets: WebSocket[] = [];
      const openObserver = async (deltas: boolean) => {
        const ws = await openWs(port);
        sockets.push(ws);
        const frames = observePresence(ws);
        const connected = await connectReq(ws, {
          client: {
            ...BACKEND_GATEWAY_CLIENT,
            instanceId: deltas ? "delta-reader" : "legacy-reader",
          },
          caps: deltas ? ["presence-deltas"] : [],
        });
        expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
        return { ws, frames, hello: connected.payload as HelloOk };
      };
      try {
        const legacy = await openObserver(false);
        const capable = await openObserver(true);
        const assertEquivalent = () => {
          const latestLegacy = legacy.frames.at(-1)!;
          expect(Object.keys(latestLegacy.payload)).toEqual(["presence"]);
          expect(reconstruct(capable.hello, capable.frames)).toEqual(
            (latestLegacy.payload as LegacyPresence).presence,
          );
        };
        const publishNode = (index: number, host = `fixture-node-${index}`) =>
          rpcReq(legacy.ws, "system-event", {
            text: `Node: ${host}`,
            instanceId: `fixture-node-${index}`,
            host,
            platform: "synthetic",
            mode: "node",
            roles: ["node"],
            version: "1.0.0",
          }).then((result) => expect(result.ok).toBe(true));
        const padded = (row: PresenceEntry) => row.instanceId === "fixture-node-19";
        await Promise.all([
          nextPresence(legacy.ws, padded),
          nextPresence(capable.ws, padded),
          (async () => {
            for (let index = 0; index < 20; index += 1) {
              await publishNode(index);
            }
          })(),
        ]);
        assertEquivalent();
        expect(capable.frames[0]?.payload).toHaveProperty("reset", true);
        expect(Array.isArray((await rpcReq(capable.ws, "system-presence")).payload)).toBe(true);

        const sessionKey = "agent:main:presence-delta-watched";
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          { sessionId: "presence-delta-session", updatedAt: Date.now(), visibility: "shared" },
        );
        const actor = await openWs(port, { origin: `http://127.0.0.1:${port}` });
        sockets.push(actor);
        const connectedRow = (row: PresenceEntry) =>
          row.instanceId === "presence-delta-actor" && row.reason === "connect";
        const [connected] = await Promise.all([
          connectReq(actor, {
            client: { ...CONTROL_UI_CLIENT, instanceId: "presence-delta-actor" },
            deviceIdentityPath: path.join(identityDir, "actor", "client", "credentials.sqlite"),
            browserOrigin: `http://127.0.0.1:${port}`,
            prePairDevice: true,
          }),
          nextPresence(legacy.ws, connectedRow),
          nextPresence(capable.ws, connectedRow),
        ]);
        expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
        assertEquivalent();
        expect(capable.frames.at(-1)?.payload).toHaveProperty("base");

        const watchedRow = (row: PresenceEntry) =>
          row.instanceId === "presence-delta-actor" &&
          row.watchedSessions?.includes(sessionKey) === true;
        await Promise.all([
          nextPresence(legacy.ws, watchedRow),
          nextPresence(capable.ws, watchedRow),
          rpcReq(actor, "sessions.viewers.set", { sessionKeys: [sessionKey] }).then((result) =>
            expect(result.ok).toBe(true),
          ),
        ]);
        assertEquivalent();
        expect(capable.frames.at(-1)?.payload).toHaveProperty("base");

        const disconnectedRow = (row: PresenceEntry) =>
          row.instanceId === "presence-delta-actor" && row.reason === "disconnect";
        const disconnected = Promise.all([
          nextPresence(legacy.ws, disconnectedRow),
          nextPresence(capable.ws, disconnectedRow),
          once(actor, "close"),
        ]);
        actor.close();
        await disconnected;
        assertEquivalent();
        expect(capable.frames.at(-1)?.payload).toHaveProperty("base");

        const serverSocket = serverSockets.get(capable.hello.server.connId)!;
        expect(serverSocket).toBeDefined();
        const beforeDrop = capable.frames.length;
        const buffered = vi
          .spyOn(serverSocket, "bufferedAmount", "get")
          .mockReturnValue(MAX_BUFFERED_BYTES + 1);
        try {
          await Promise.all([
            nextPresence(legacy.ws, (row) => row.host === "dropped-update"),
            publishNode(0, "dropped-update"),
          ]);
        } finally {
          buffered.mockRestore();
        }
        // After pressure clears, this reply joins prior writes on the same socket.
        expect((await rpcReq(capable.ws, "system-presence")).ok).toBe(true);
        expect(capable.frames).toHaveLength(beforeDrop);
        const [, recovered] = await Promise.all([
          nextPresence(legacy.ws, (row) => row.host === "recovered-update"),
          nextPresence(capable.ws, (row) => row.host === "recovered-update"),
          publishNode(1, "recovered-update"),
        ]);
        expect(recovered.payload).toHaveProperty("reset", true);
        assertEquivalent();

        // Each snapshot read refreshes the gateway self row's timestamp.
        const recoveryClock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
        try {
          const legacySnapshot = await rpcReq(legacy.ws, "system-presence");
          const recovery = await rpcReq(capable.ws, "system-presence", { snapshot: true });
          expect(recovery.ok).toBe(true);
          expect(recovery.payload).toHaveProperty("reset", true);
          expect((recovery.payload as LegacyPresence).presence).toEqual(legacySnapshot.payload);
        } finally {
          recoveryClock.mockRestore();
        }
        const [, afterRecovery] = await Promise.all([
          nextPresence(legacy.ws, (row) => row.host === "after-rpc-reset"),
          nextPresence(capable.ws, (row) => row.host === "after-rpc-reset"),
          publishNode(2, "after-rpc-reset"),
        ]);
        expect(afterRecovery.payload).toHaveProperty("reset", true);
        assertEquivalent();

        const oldConnectionId = capable.hello.server.connId;
        const closed = once(capable.ws, "close");
        capable.ws.close();
        await closed;
        const reconnected = await openObserver(true);
        expect(reconnected.hello.server.connId).not.toBe(oldConnectionId);
        expect(reconnected.hello.snapshot.presence).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ instanceId: "fixture-node-0", host: "dropped-update" }),
          ]),
        );
        const [, firstAfterReconnect] = await Promise.all([
          nextPresence(legacy.ws, (row) => row.host === "after-reconnect"),
          nextPresence(reconnected.ws, (row) => row.host === "after-reconnect"),
          publishNode(3, "after-reconnect"),
        ]);
        expect(reconnected.frames[0]?.payload).toHaveProperty("reset", true);
        expect(reconstruct(reconnected.hello, reconnected.frames)).toEqual(
          (legacy.frames.at(-1)!.payload as LegacyPresence).presence,
        );
        expect(firstAfterReconnect.stateVersion.presence).toBeGreaterThan(
          reconnected.hello.snapshot.stateVersion?.presence ?? 0,
        );
      } finally {
        for (const socket of sockets) {
          socket.close();
        }
      }
    });
  } finally {
    sendSpy.mockRestore();
  }
});
