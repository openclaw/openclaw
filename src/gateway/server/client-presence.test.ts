import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PresenceEntrySchema } from "../../../packages/gateway-protocol/src/schema/snapshot.js";
import {
  listSystemPresence,
  updateSystemPresence,
  upsertPresence,
} from "../../infra/system-presence.js";
import { buildAuthenticatedPresenceUser } from "../authenticated-presence-user.js";
import { dispatchProfile, gatewayConnect } from "./client-fixtures.test-support.js";
import { startWorkerHumanPresence } from "./client-human-presence.js";
import {
  recordClientPresenceActivity,
  refreshClientPresence,
  snapshotClientPresence,
} from "./client-presence.js";
import { GatewayClientRegistry } from "./client-registry.js";
import { attachGatewayWsConnectionHandler } from "./ws-connection.js";
import {
  attachGatewayWsForTest,
  createGatewayWsTestRequestContext,
} from "./ws-connection.test-helpers.js";
import type { GatewayWsMessageHandlerParams } from "./ws-connection/message-handler.js";
import { invalidateGatewayPolicyClient, registerGatewayPolicyResponse } from "./ws-policy-close.js";
import type { GatewayWsClient } from "./ws-types.js";

const { attachMessageHandler } = vi.hoisted(() => ({
  attachMessageHandler: vi.fn<(params: GatewayWsMessageHandlerParams) => void>(),
}));
vi.mock("./ws-connection/message-handler.js", () => ({
  attachGatewayWsMessageHandler: attachMessageHandler,
}));

describe("live person presence timing", () => {
  it("qualifies presence sender provenance only from an authenticated profile", () => {
    const validUser = (user: unknown) => Value.Check(PresenceEntrySchema, { ts: 1, user });
    const authenticatedUserId = "same-id";
    const fallback = buildAuthenticatedPresenceUser({ authenticatedUserId });
    expect(fallback).toEqual({ id: authenticatedUserId, email: authenticatedUserId });
    expect(buildAuthenticatedPresenceUser({})).toBeUndefined();
    const profile = buildAuthenticatedPresenceUser({
      authenticatedUserId,
      authenticatedUserProfile: dispatchProfile(authenticatedUserId, { displayName: "Person" }),
    });
    expect(profile).toMatchObject({
      id: authenticatedUserId,
      identity: { type: "profile", id: authenticatedUserId },
    });
    expect(validUser(profile)).toBe(true);
    expect(
      validUser({
        ...fallback,
        identity: {
          type: "observation",
          id: authenticatedUserId,
          pluginId: null,
          accountId: null,
          senderKind: "unknown",
        },
      }),
    ).toBe(false);
  });

  const clients = new GatewayClientRegistry();
  const sockets: ReturnType<typeof attachGatewayWsForTest>["socket"][] = [];
  let nextTestTime = new Date("2040-01-01T00:00:00Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(nextTestTime);
    nextTestTime += 24 * 60 * 60 * 1000;
    attachMessageHandler.mockClear();
  });
  afterEach(() => {
    for (const socket of sockets.splice(0)) {
      close(socket);
    }
    clients.clear();
    vi.setSystemTime(Date.now() + 300_001);
    listSystemPresence();
    vi.useRealTimers();
  });

  async function connect(
    email: string | undefined,
    profileId = "timing-person",
    options: {
      raw?: boolean;
      scope?: string;
      nativeClient?: "openclaw-tui" | "openclaw-macos";
      deferAdmission?: boolean;
    } = {},
  ) {
    const { socket } = attachGatewayWsForTest({
      attach: attachGatewayWsConnectionHandler,
      clients,
      options: {
        buildRequestContext: () =>
          createGatewayWsTestRequestContext({
            nodeRegistry: { get: vi.fn(() => undefined), unregister: vi.fn(() => null) } as never,
          }) as never,
      },
    });
    sockets.push(socket);
    await vi.dynamicImportSettled();
    const handler = attachMessageHandler.mock.lastCall?.[0];
    if (!handler) {
      throw new Error("message handler was not attached");
    }
    const client: GatewayWsClient = {
      socket: socket as unknown as GatewayWsClient["socket"],
      connId: handler.connId,
      presenceKey: handler.connId,
      usesSharedGatewayAuth: false,
      connect: gatewayConnect(options.scope ? [options.scope] : undefined, {
        id: options.nativeClient ?? "openclaw-control-ui",
        mode: options.nativeClient ? "ui" : "webchat",
      }),
      internal: options.scope ? { authenticatedControlUi: true } : undefined,
      authenticatedUserId: email,
      authenticatedUserProfile: options.raw
        ? undefined
        : dispatchProfile(profileId, { displayName: "Timing Person" }),
    };
    if (!options.deferAdmission) {
      expect(handler.setClient(client)).toBe(true);
    }
    return { client, handler, socket, email };
  }

  function personTimes(entry: ReturnType<typeof listSystemPresence>[number] | undefined) {
    return [entry?.onlineSince, entry?.lastActivityAt];
  }

  type Connection = Awaited<ReturnType<typeof connect>>;

  function close(socket: (typeof sockets)[number]) {
    socket.readyState = 3;
    socket.emit("close", 1000, Buffer.alloc(0));
  }

  function setClient(connection: Connection) {
    return connection.handler.setClient(connection.client);
  }

  function activity(connection: Connection, at = Date.now()) {
    vi.setSystemTime(at);
    return recordClientPresenceActivity(clients, connection.client);
  }

  function row(connection: Connection) {
    return listSystemPresence().find((entry) => entry.user?.email === connection.email);
  }
  function expectRow(connection: Connection, expected: object) {
    expect(row(connection)).toMatchObject(expected);
  }

  it("projects only authenticated Control UI connections as human pool demand", async () => {
    const changes = vi.fn<(present: boolean) => Promise<void>>(async () => {});
    const sidecars: Array<{ stop: () => void }> = [];
    await startWorkerHumanPresence({
      clients,
      service: { setHumanPresence: changes },
      log: { warn: vi.fn() },
      registerSidecar: (sidecar) => sidecars.push(sidecar),
    });
    expect(changes).toHaveBeenCalledExactlyOnceWith(false);
    expect(sidecars).toHaveLength(1);
    changes.mockClear();
    const browser = await connect("person@presence.test", "presence-person");
    expect(changes).not.toHaveBeenCalled();

    browser.client.internal = { authenticatedControlUi: true };
    close(browser.socket);

    await connect("person@presence.test", "presence-person", { scope: "operator.read" });
    expect(changes).not.toHaveBeenCalled();

    const writer = { scope: "operator.sessions.write" };
    const verified = await connect("person@presence.test", "presence-person", writer);
    expect(changes).toHaveBeenLastCalledWith(true);
    const overlapping = await connect("other@presence.test", "other-person", writer);
    const response = registerGatewayPolicyResponse("config.patch", verified.client, vi.fn())!;
    response.hold();
    const revocation = { reason: "test", code: 1008, message: "revoked" };
    invalidateGatewayPolicyClient(verified.client, revocation);
    expect(changes).toHaveBeenLastCalledWith(true);
    expect(clients.has(verified.client)).toBe(true);
    invalidateGatewayPolicyClient(overlapping.client, revocation);
    expect(changes).toHaveBeenLastCalledWith(false);
    response.finish();
    close(verified.socket);
    expect(changes).toHaveBeenLastCalledWith(false);
    sidecars[0]!.stop();
  });

  it.each(["profile", "raw"] as const)(
    "separates colliding presence namespaces when %s connects first",
    async (firstNamespace) => {
      const id = "synthetic-shared-id";
      const profile = await connect("profile@namespace.test", id, { deferAdmission: true });
      const raw = await connect(id, undefined, { raw: true, deferAdmission: true });
      const [first, second] =
        firstNamespace === "profile" ? ([profile, raw] as const) : ([raw, profile] as const);
      const t = Date.now();
      setClient(first);
      vi.setSystemTime(t + 1_000);
      setClient(second);
      const profileStarted = t + (firstNamespace === "profile" ? 0 : 1_000);
      const rawStarted = t + (firstNamespace === "raw" ? 0 : 1_000);
      expect.soft(row(profile)?.onlineSince).toBe(profileStarted);
      expect.soft(row(raw)?.onlineSince).toBe(rawStarted);

      expect(activity(raw, t + 2_000)).toBe(true);
      expect.soft(row(profile)?.lastActivityAt).toBeUndefined();
      expect(row(profile)?.connectionLastActivityAt).toBeUndefined();
      expect(activity(profile, t + 3_000)).toBe(true);
      expect.soft(personTimes(row(raw))).toEqual([rawStarted, t + 2_000]);

      vi.setSystemTime(t + 4_000);
      const overlap = await connect("overlap@namespace.test", id);
      expect.soft(personTimes(row(overlap))).toEqual([profileStarted, t + 3_000]);
      expect(row(overlap)?.connectionLastActivityAt).toBeUndefined();
      expect(activity(overlap, t + 4_500)).toBe(false);
      expectRow(profile, { lastActivityAt: t + 4_500, connectionLastActivityAt: t + 3_000 });
      expectRow(overlap, {
        connectionId: overlap.client.connId,
        connectionLastActivityAt: t + 4_500,
      });
      close(profile.socket);
      expect(activity(overlap, t + 4_750)).toBe(false);
      expect.soft(personTimes(row(overlap))).toEqual([profileStarted, t + 4_750]);
      close(overlap.socket);

      vi.setSystemTime(t + 5_000);
      const reconnected = await connect("reconnected@namespace.test", id);
      expect.soft(personTimes(row(reconnected))).toEqual([t + 5_000, undefined]);
      expect(row(reconnected)?.connectionLastActivityAt).toBeUndefined();
      expect.soft(personTimes(row(raw))).toEqual([rawStarted, t + 2_000]);
    },
  );

  it.each(["profile", "raw"] as const)(
    "keeps later activity separate after raw tabs qualify (%s acts first)",
    async (firstNamespace) => {
      const id = "qualification-shared-id";
      const raw = await connect(id, id, { raw: true });
      const qualified = await connect(id, id, { deferAdmission: true });
      const profile = qualified.client.authenticatedUserProfile;
      delete qualified.client.authenticatedUserProfile;
      const t = Date.now();
      vi.setSystemTime(t + 1_000);
      setClient(qualified);
      activity(raw, t + 2_000);
      const liveRows = (isProfile: boolean) =>
        listSystemPresence().filter(
          (entry) =>
            entry.reason !== "disconnect" &&
            entry.user?.id === id &&
            Boolean(entry.user.identity) === isProfile,
        );
      expect(liveRows(false)).toHaveLength(2);
      for (const entry of liveRows(false)) {
        expect(personTimes(entry)).toEqual([t, t + 2_000]);
      }

      qualified.client.authenticatedUserProfile = profile;
      const [first, second] =
        firstNamespace === "profile" ? ([qualified, raw] as const) : ([raw, qualified] as const);
      // Activity can be the first presence operation after the profile snapshot changes.
      expect(activity(first, t + 3_000)).toBe(firstNamespace === "profile");
      refreshClientPresence(clients, second.client);
      expect.soft(personTimes(liveRows(firstNamespace !== "profile")[0])).toEqual([t, t + 2_000]);
      expect(activity(second, t + 4_000)).toBe(false);
      refreshClientPresence(clients, first.client);
      expect.soft(personTimes(liveRows(firstNamespace === "profile")[0])).toEqual([t, t + 3_000]);
      expect.soft(personTimes(liveRows(firstNamespace !== "profile")[0])).toEqual([t, t + 4_000]);
    },
  );

  it("keeps heartbeat freshness and cache eviction independent of person timing", async () => {
    const first = await connect("heartbeat@timing.test", "heartbeat-person", {
      nativeClient: "openclaw-tui",
    });
    const t = Date.now();
    activity(first);
    vi.setSystemTime(t + 10_000);
    first.socket.emit("pong");
    updateSystemPresence({
      instanceId: first.client.presenceKey,
      text: "heartbeat",
      lastInputSeconds: 0,
    });
    expectRow(first, {
      ts: t + 10_000,
      onlineSince: t,
      lastActivityAt: t,
      connectionLastActivityAt: t,
    });

    vi.setSystemTime(t + 20_000);
    for (let index = 0; index < 201; index++) {
      upsertPresence(`timing-eviction-${index}`, { text: "cache pressure" });
    }
    expect(row(first)).toBeUndefined();
    expect(snapshotClientPresence(clients)).toMatchObject([
      {
        connectionId: first.client.connId,
        user: { id: "heartbeat-person" },
        connectionLastActivityAt: t,
      },
    ]);
    const overlap = await connect("eviction@timing.test", "heartbeat-person", {
      nativeClient: "openclaw-macos",
    });
    expectRow(first, { connectionLastActivityAt: t });
    expect(personTimes(row(overlap))).toEqual([t, t]);

    vi.setSystemTime(t + 400_000);
    expect(row(overlap)).toBeUndefined();
    expect(activity(overlap)).toBe(true);
    expect(row(first)).toBeDefined();
    expectRow(overlap, {
      onlineSince: t,
      lastActivityAt: t + 400_000,
      connectionLastActivityAt: t + 400_000,
    });
  });

  it("keeps delayed identity timing on its accepted socket without reviving closed clients", async () => {
    const delayed = await connect("pending@timing.test", "delayed-person", {
      deferAdmission: true,
    });
    const profile = delayed.client.authenticatedUserProfile;
    delete delayed.client.authenticatedUserProfile;
    delayed.client.authenticatedGitHubIdentitySync = async () => ({
      profileId: "delayed-person",
      updatedAt: 1,
    });
    const t = Date.now();
    setClient(delayed);
    expect(row(delayed)).toBeUndefined();
    expect(activity(delayed)).toBe(false);
    vi.setSystemTime(t + 1_000);
    delayed.client.authenticatedUserProfile = profile;
    refreshClientPresence(clients, delayed.client);
    expectRow(delayed, { onlineSince: t });
    close(delayed.socket);
    vi.setSystemTime(t + 400_000);
    expect(refreshClientPresence(clients, delayed.client)).toBe(false);
    expect(activity(delayed)).toBe(false);
    expect(row(delayed)).toBeUndefined();
  });

  it("rejects copied, invalidated, closing, and unregistered clients without changing activity", async () => {
    const live = await connect("exact@timing.test", "exact-person");
    expect(recordClientPresenceActivity(clients, { ...live.client })).toBe(false);
    live.client.invalidated = true;
    expect(activity(live)).toBe(false);
    expect(snapshotClientPresence(clients)).toEqual([]);
    live.client.invalidated = false;
    live.socket.readyState = 2;
    expect(activity(live)).toBe(false);
    expect(snapshotClientPresence(clients)).toEqual([]);
    expect(row(live)?.lastActivityAt).toBeUndefined();
    const rejected = await connect("rejected@timing.test", undefined, { deferAdmission: true });
    rejected.socket.emit("close", 1000, Buffer.alloc(0));
    expect(setClient(rejected)).toBe(false);
    expect(rejected.client.personPresence).toBeUndefined();
    expect(row(rejected)).toBeUndefined();
  });

  it.each(["ephemeral", "unidentified", "node"])(
    "does not create person timing for %s clients",
    async (kind) => {
      const connection = await connect(`${kind}@timing.test`, undefined, { deferAdmission: true });
      if (kind === "ephemeral") {
        delete connection.client.presenceKey;
      } else if (kind === "node") {
        connection.client.connect.role = "node";
      } else {
        delete connection.client.authenticatedUserId;
        delete connection.client.authenticatedUserProfile;
      }
      expect(setClient(connection)).toBe(true);
      expect(connection.client.personPresence).toBeUndefined();
      expect(activity(connection)).toBe(false);
    },
  );
});
