import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import * as Ws from "../../../packages/gateway-client/src/websocket.test-support.js";
import { captureRuntimeConfigAsyncReader, setRuntimeConfigSnapshot } from "../../config/config.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { listSystemPresence, upsertPresence } from "../../infra/system-presence.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createGatewayConnectionState } from "../server-connection-state.js";
import { createGatewayRequestContext } from "../server-request-context.js";
import { makeContextParams } from "../server-request-context.test-support.js";
import { createGatewayWebSocketTransport } from "../server/ws-transport.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { clearSessionTypingState } from "./session-typing-state.js";
import { initializeSessionReadContext } from "./sessions-read-cache.test-support.js";
import { sessionTypingHandler } from "./sessions-typing.js";

it("delivers expired-beacon drafts over WebSockets without sending to denied or revoked readers", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const cfg = rolePolicyConfig();
    setRuntimeConfigSnapshot(cfg);
    await captureRuntimeConfigAsyncReader()();
    const scheduler = createTestGatewayScheduler();
    const connections = createGatewayConnectionState({ scheduler, bootId: "typing-delivery", cfg });
    const server = new Ws.WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const sockets = new Set<Ws.WebSocket>();
    let detach: (() => void) | undefined;
    const sessionKey = "agent:main:typing-delivery";
    const sessionId = "typing-delivery";
    try {
      const connect = async (name: string, role: "write" | "view" | "none") => {
        const accepted = once(server, "connection");
        const peer = new Ws.WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
        sockets.add(peer);
        const opened = once(peer, "open");
        const [socket, request] = (await accepted) as [Ws.WebSocket, IncomingMessage];
        sockets.add(socket);
        await opened;
        const transport = createGatewayWebSocketTransport(socket, request.socket, undefined);
        const send = vi.spyOn(transport, "send");
        const identified = roleClient(role, `typing-delivery-${name}`);
        const client: GatewayWsClient = Object.assign(identified, {
          authenticatedUserProfile: {
            profileId: identified.authenticatedUserProfile!.profileId,
            displayName: name,
            avatarRevision: "fixture",
            hasAvatar: false,
            updatedAt: 1,
          },
          connId: `typing-delivery-${name}`,
          socket: transport,
          usesSharedGatewayAuth: false,
          watchedSessions: [sessionKey],
          personPresence: { onlineSince: Date.now() },
          presenceKey: `typing-delivery-${name}`,
        });
        connections.clients.add(client);
        connections.sessionMessageSubscribers.subscribe(client.connId, sessionKey);
        return { client, peer, send };
      };
      const writer = await connect("writer", "write");
      const allowed = await connect("allowed", "view");
      const revoked = await connect("revoked", "view");
      const denied = await connect("denied", "none");
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId,
          updatedAt: Date.now(),
          createdActor: {
            type: "human",
            source: "profile",
            id: writer.client.authenticatedUserProfile!.profileId,
          },
          visibility: "shared",
        },
      );
      const context = createGatewayRequestContext(makeContextParams(connections));
      await initializeSessionReadContext(context);
      detach = connections.attachSessionRowProjection(getSessionRowProjection(context)!);
      clearSessionTypingState();
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      for (const { client } of [writer, allowed, revoked, denied]) {
        upsertPresence(client.connId, {
          connectionId: client.connId,
          user: { id: client.authenticatedUserProfile!.profileId },
          watchedSessions: [sessionKey],
        });
      }
      expect(
        listSystemPresence().filter((row) => row.watchedSessions?.includes(sessionKey)),
      ).toHaveLength(4);
      vi.setSystemTime(Date.now() + 5 * 60 * 1_000 + 1);
      expect(listSystemPresence().some((row) => row.watchedSessions?.includes(sessionKey))).toBe(
        false,
      );
      expect(
        context.getPresenceSnapshot().filter((row) => row.watchedSessions?.includes(sessionKey)),
      ).toHaveLength(4);
      const type = async (preview: string) => {
        const params = { sessionKey, sessionId, typing: true, preview };
        const respond = vi.fn();
        await sessionTypingHandler({
          req: { type: "req", id: preview, method: "session.typing", params },
          params,
          client: writer.client,
          context,
          isWebchatConnect: () => true,
          respond,
        });
        return respond;
      };
      const firstAllowed = once(allowed.peer, "message");
      const firstRevoked = once(revoked.peer, "message");
      expect(await type("first draft")).toHaveBeenCalledWith(true, { ok: true, broadcast: true });
      for (const [frame] of await Promise.all([firstAllowed, firstRevoked])) {
        expect(JSON.parse(String(frame))).toMatchObject({
          event: "session.typing",
          payload: { sessionKey, sessionId, preview: "first draft" },
        });
      }
      expect(denied.send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      expect(await type("pending draft")).toHaveBeenCalledWith(true, {
        ok: true,
        broadcast: false,
      });
      expect(allowed.send).toHaveBeenCalledTimes(1);
      setUserProfileRole(revoked.client.authenticatedUserProfile!.profileId, "none");
      expect(revoked.client.preparedSessionProfile?.role).toBe("none");
      expect(connections.sessionMessageSubscribers.get(sessionKey).has(revoked.client.connId)).toBe(
        true,
      );
      const delayedAllowed = once(allowed.peer, "message");
      await vi.advanceTimersByTimeAsync(150);
      const [frame] = await delayedAllowed;
      expect(JSON.parse(String(frame))).toMatchObject({
        event: "session.typing",
        payload: { sessionKey, sessionId, preview: "pending draft" },
      });
      expect(allowed.send).toHaveBeenCalledTimes(2);
      expect(revoked.send).toHaveBeenCalledTimes(1);
      expect(denied.send).not.toHaveBeenCalled();
    } finally {
      clearSessionTypingState();
      vi.useRealTimers();
      detach?.();
      connections.clients.clear();
      for (const socket of sockets) {
        socket.terminate();
      }
      await promisify(server.close.bind(server))();
      await scheduler.stop();
    }
  });
});
