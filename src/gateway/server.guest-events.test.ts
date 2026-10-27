import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { withInvitedGuestGateway } from "./guest-session-access.test-support.js";
import * as connectionState from "./server-connection-state.js";
import type { GatewayConnectionTransport } from "./server/connection-transport.js";

it("filters ancestors and presence, then drops revoked retained text over TLS", async ({
  signal,
}) => {
  let captured: ReturnType<typeof connectionState.createGatewayConnectionState> | undefined;
  const createConnection = connectionState.createGatewayConnectionState;
  using cleanup = new DisposableStack();
  cleanup.use(
    vi
      .spyOn(connectionState, "createGatewayConnectionState")
      .mockImplementation((params) => (captured = createConnection(params))),
  );

  await withInvitedGuestGateway(signal, async ({ gateway, sender, invited, carol, events }) => {
    const connection = captured;
    if (!connection) {
      throw new Error("Gateway connection owner was not captured");
    }
    const create = (params: Record<string, unknown>) =>
      sender.request<{ key: string }>(
        "sessions.create",
        { agentId: "main", visibility: "shared", ...params },
        { signal },
      );
    await create({ key: "agent:main:main" });
    const parent = (await create({ label: "Protected parent" })).key;
    const unrelated = (await create({ label: "Unrelated session" })).key;
    const child = (await create({ parentSessionKey: parent })).key;
    const membership = (action: "add" | "remove", sessionKey: string) =>
      sender.request(
        `session.members.${action}`,
        { sessionKey, agentId: "main", identityId: carol.id },
        { signal },
      );
    await invited.request("sessions.subscribe", {}, { signal });
    await gateway.client.request("sessions.subscribe", {}, { signal });
    await membership("add", child);
    await invited.request(
      "sessions.messages.subscribe",
      { key: child, agentId: "main" },
      { signal },
    );

    const patchChild = async (label: string) => {
      const offset = events.invited.length;
      const find = () =>
        events.invited
          .slice(offset)
          .flatMap(({ event, payload }) =>
            event === "sessions.changed" &&
            isRecord(payload) &&
            payload.sessionKey === child &&
            isRecord(payload.session) &&
            payload.session.label === label
              ? [payload]
              : [],
          )
          .at(-1);
      await sender.request("sessions.patch", { key: child, label }, { signal });
      await expect.poll(find).toBeDefined();
      const payload = find();
      if (!payload) {
        throw new Error("Child publication was not received");
      }
      return payload;
    };
    const ancestorKeys = (payload: Record<string, unknown>) =>
      [payload.ancestorSessions, payload.ancestorSessionRefs].flatMap((rows) =>
        Array.isArray(rows)
          ? rows.flatMap((row) => (isRecord(row) && typeof row.key === "string" ? [row.key] : []))
          : [],
      );
    expect(ancestorKeys(await patchChild("child without parent access"))).not.toContain(parent);
    await membership("add", parent);
    expect(ancestorKeys(await patchChild("child with parent access"))).toContain(parent);

    const declareWatches = async (sessionKeys: string[]) => {
      const offset = events.invited.length;
      const find = () =>
        events.invited
          .slice(offset)
          .flatMap(({ event, payload }) =>
            event === "presence" && isRecord(payload) && Array.isArray(payload.presence)
              ? [payload.presence]
              : [],
          )
          .at(-1);
      await sender.request("sessions.viewers.set", { sessionKeys, agentId: "main" }, { signal });
      await expect.poll(find).toBeDefined();
      return (find() ?? []).flatMap((row) =>
        isRecord(row) && Array.isArray(row.watchedSessions)
          ? row.watchedSessions.filter((key): key is string => typeof key === "string")
          : [],
      );
    };
    expect(await declareWatches([parent, child, unrelated])).toEqual(
      expect.arrayContaining([parent, child]),
    );
    const presence = await invited.request<Array<{ watchedSessions?: string[] }>>(
      "system-presence",
      {},
      { signal },
    );
    expect(presence.flatMap((row) => row.watchedSessions ?? [])).not.toContain(unrelated);
    await membership("remove", parent);
    expect(ancestorKeys(await patchChild("child after parent revocation"))).not.toContain(parent);
    await declareWatches([]);
    const watches = await declareWatches([parent, child, unrelated]);
    expect(watches).toContain(child);
    expect(watches).not.toContain(parent);
    expect(watches).not.toContain(unrelated);

    // A same-socket response fences preceding event writes before negative assertions.
    await gateway.client.request("sessions.list", { agentId: "main" }, { signal });
    expect(events.guest.some(({ event }) => event === "presence")).toBe(false);
    expect(
      events.guest.some(
        ({ event, payload }) =>
          event === "sessions.changed" && isRecord(payload) && payload.sessionKey === child,
      ),
    ).toBe(false);

    const peer = [...connection.clients].find(
      (client) => client.authenticatedUserProfile?.profileId === carol.id,
    );
    if (!peer) {
      throw new Error("Authenticated invited transport was not found");
    }
    const runId = "retained-invited-text";
    const group = new AbortController();
    const written = createDeferred();
    const originalSend = peer.socket.send.bind(peer.socket);
    let armed = true;
    let finishHeldWrite: (() => void) | undefined;
    // The first frame uses real TLS; only broadcaster completion is held to retain the next.
    const send: GatewayConnectionTransport["send"] = (
      frame,
      options?: { binary: false } | ((error?: Error) => void),
      callback?: (error?: Error) => void,
    ) => {
      const done = typeof options === "function" ? options : callback;
      const forward = (complete?: (error?: Error) => void) =>
        typeof frame === "string"
          ? originalSend(frame, complete)
          : originalSend(frame, { binary: false }, complete);
      const wire: unknown = JSON.parse(String(frame));
      if (
        armed &&
        isRecord(wire) &&
        wire.event === "chat" &&
        isRecord(wire.payload) &&
        wire.payload.runId === runId
      ) {
        armed = false;
        return forward((error) => {
          if (error) {
            done?.(error);
            written.reject(error);
            return;
          }
          finishHeldWrite = () => done?.();
          written.resolve();
        });
      }
      return forward(done);
    };
    using _ = vi.spyOn(peer.socket, "send").mockImplementation(send);
    let seq = 0;
    // Synthetic deltas isolate the real broadcaster's queue and authorization owner.
    const publish = (text: string) =>
      connection.broadcast(
        "chat",
        {
          runId,
          sessionKey: child,
          agentId: "main",
          seq: seq++,
          state: "delta",
          deltaText: text,
          message: { role: "assistant", content: [{ type: "text", text }] },
        },
        {
          sessionKeys: [child],
          agentId: "main",
          liveText: {
            group: group.signal,
            coalesce: { key: runId, merge: (_previous, next) => next },
          },
        },
      );
    const deliveredText = () =>
      events.invited.flatMap(({ event, payload }) =>
        event === "chat" && isRecord(payload) && payload.runId === runId ? [payload.deltaText] : [],
      );
    try {
      publish("allowed first text");
      await withinTest(written.promise, signal);
      await expect.poll(deliveredText).toEqual(["allowed first text"]);
      publish("protected queued text");
      expect(connection.getBufferedAmount(peer.connId)).toBeGreaterThan(peer.socket.bufferedAmount);
      await membership("remove", child);
      finishHeldWrite?.();
      finishHeldWrite = undefined;
      expect(connection.getBufferedAmount(peer.connId)).toBe(peer.socket.bufferedAmount);
      await invited.request("sessions.list", { agentId: "main" }, { signal });
      expect(deliveredText()).toEqual(["allowed first text"]);
      expect(
        events.guest.some(
          ({ event, payload }) => event === "chat" && isRecord(payload) && payload.runId === runId,
        ),
      ).toBe(false);
    } finally {
      group.abort();
      finishHeldWrite?.();
    }
  });
});
