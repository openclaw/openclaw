import { randomUUID } from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, expect, test, vi, describe } from "vitest";
import { WebSocket } from "../../packages/gateway-client/src/websocket.test-support.js";
import type { PresenceUpdate } from "../../packages/gateway-protocol/src/presence-deltas.js";
import type { HelloOk } from "../../packages/gateway-protocol/src/schema/frames.js";
import type { PresenceQueryResult } from "../../packages/gateway-protocol/src/schema/presence.js";
import {
  type PresenceEntry,
  PresenceEntrySchema,
} from "../../packages/gateway-protocol/src/schema/snapshot.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { makeUserMessage } from "../../test/helpers/user-message.js";
import { writeConfigFile } from "../config/config.js";
import {
  upsertSessionEntryCore,
  persistSessionTranscriptTurn,
} from "../config/sessions/session-accessor.js";
import type { GatewayAuthConfig, GatewayOperatorRolesConfig } from "../config/types.gateway.js";
import type { SystemPresence } from "../infra/system-presence.js";
import { listSystemPresence } from "../infra/system-presence.js";
import { setDisplayName, setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
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
  NODE_CLIENT,
  testState,
  waitForWsClose,
} from "./server.auth.test-helpers.js";
import type { SessionsListResult } from "./session-utils.types.js";

describe("presence audience existing coverage", () => {
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
        expect(payload.base, "every delivered delta chains from the previous version").toBe(
          version,
        );
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
          const assertEquivalent = async (peer = capable) => {
            // This same-socket reply drains publications already observed by the legacy peer.
            expect((await rpcReq(peer.ws, "system-presence")).ok).toBe(true);
            const latestLegacy = legacy.frames.at(-1)!;
            expect(peer.frames.at(-1)?.stateVersion.presence).toBe(
              latestLegacy.stateVersion.presence,
            );
            expect(Object.keys(latestLegacy.payload)).toEqual(["presence"]);
            expect(reconstruct(peer.hello, peer.frames)).toEqual(
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
          await assertEquivalent();
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
          await assertEquivalent();
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
          await assertEquivalent();
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
          await assertEquivalent();
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
          await assertEquivalent();

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
          await assertEquivalent();

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
          await assertEquivalent(reconnected);
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
});

describe("presence audience retained boundaries", () => {
  installGatewayTestHooks({ scope: "suite" });

  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  const BROWSER_ORIGIN = "https://control.example.com";
  const TRUSTED_PROXY_HEADERS = {
    origin: BROWSER_ORIGIN,
    "x-forwarded-for": "203.0.113.50",
    "x-forwarded-proto": "https",
    "x-forwarded-user": "admin@example.com",
  };

  async function configureGatewayAuth(
    auth: GatewayAuthConfig,
    roles: GatewayOperatorRolesConfig,
  ): Promise<void> {
    testState.gatewayAuth = auth;
    testState.gatewayControlUi = { allowedOrigins: [BROWSER_ORIGIN] };
    await writeConfigFile({
      gateway: {
        auth,
        trustedProxies: ["127.0.0.1"],
        roles,
        controlUi: { allowedOrigins: [BROWSER_ORIGIN] },
      },
    });
  }

  function responseScopes(response: Awaited<ReturnType<typeof connectReq>>): string[] | undefined {
    return (response.payload as { auth?: { scopes?: string[] } } | undefined)?.auth?.scopes;
  }

  const GUEST_PRESENCE_FIELDS = new Set([
    "ts",
    "text",
    "reason",
    "lastActivityAt",
    "user",
    "watchedSessions",
  ]);

  function personOnlyViolations(row: Partial<SystemPresence>): string[] {
    return [
      ...Object.keys(row).filter((field) => !GUEST_PRESENCE_FIELDS.has(field)),
      ...(row.user?.email ? ["user.email"] : []),
    ];
  }

  function guestPresenceView(row: Omit<SystemPresence, "watchedSessions">) {
    const { email: _email, ...user } = row.user!;
    return { ts: row.ts, text: "", lastActivityAt: row.lastActivityAt, user };
  }

  describe("gateway presence audience", () => {
    test("shares people only with readers and filters their session references across hello, RPC, and activity events", async ({
      onTestFailed,
    }) => {
      await configureGatewayAuth(
        {
          mode: "trusted-proxy",
          identityScopes: {
            "admin@example.com": ["operator.admin"],
            "watcher@example.com": ["operator.admin"],
          },
          trustedProxy: {
            userHeader: "x-forwarded-user",
            requiredHeaders: ["x-forwarded-proto"],
            allowLoopback: true,
          },
        },
        {
          default: "reader",
          definitions: {
            reader: { sessions: { others: "view" }, agents: "*", scopes: ["operator.read"] },
            writer: { sessions: { others: "write" }, agents: "*", scopes: ["operator.write"] },
            restricted: { sessions: { others: "none" }, agents: "*", scopes: ["operator.read"] },
            maintainer: { sessions: { others: "write" }, agents: "*", scopes: ["operator.admin"] },
            pairing: { sessions: { others: "none" }, agents: [], scopes: ["operator.pairing"] },
            guest: {
              sessions: { others: "view" },
              agents: "*",
              scopes: ["operator.sessions.write"],
            },
            visitor: {
              sessions: { others: "view" },
              agents: "*",
              scopes: ["operator.sessions.write"],
            },
          },
        },
      );
      const creator = ensureProfileForEmail("creator@example.com");
      const restricted = ensureProfileForEmail("restricted@example.com");
      setUserProfileRole(restricted.id, "restricted");
      setUserProfileRole(ensureProfileForEmail("admin@example.com").id, "maintainer");
      const watcherProfile = ensureProfileForEmail("watcher@example.com");
      setUserProfileRole(watcherProfile.id, "maintainer");
      setDisplayName(watcherProfile.id, "Presence Watcher");
      setUserProfileRole(ensureProfileForEmail("writer@example.com").id, "writer");
      setUserProfileRole(ensureProfileForEmail("pairing@example.com").id, "pairing");
      const guestProfile = ensureProfileForEmail("guest@example.com");
      setUserProfileRole(guestProfile.id, "writer");
      setUserProfileRole(ensureProfileForEmail("visitor@example.com").id, "visitor");
      const sharedKey = "agent:main:presence-shared";
      const guestKey = "agent:main:presence-guest";
      const sharedSessionId = randomUUID();
      const draftKey = "agent:main:presence-draft";
      const draftSessionId = randomUUID();
      const incognitoKey = "agent:main:dashboard:incognito-presence";
      const restrictedKey = "agent:main:presence-restricted-draft";
      const missingKey = "agent:main:presence-missing";
      const watchedKeys = [sharedKey, draftKey, incognitoKey, restrictedKey, missingKey].toSorted();
      const watcherInstanceId = `presence-watcher-${randomUUID()}`;
      const identityDir = tempDirs.make("openclaw-presence-identities-");

      await withGatewayServer(async ({ port }) => {
        for (const [sessionKey, profileId, visibility, incognito] of [
          [sharedKey, creator.id, "shared", false],
          [guestKey, guestProfile.id, "shared", false],
          [draftKey, creator.id, "draft", false],
          [incognitoKey, creator.id, "shared", true],
          [restrictedKey, restricted.id, "draft", false],
        ] as const) {
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey },
            {
              sessionId:
                sessionKey === sharedKey
                  ? sharedSessionId
                  : sessionKey === draftKey
                    ? draftSessionId
                    : randomUUID(),
              updatedAt: Date.now(),
              createdVia: "operator",
              createdActor: { type: "human", source: "profile", id: profileId },
              visibility,
              ...(incognito ? { incognito: true } : {}),
            },
          );
        }
        await persistSessionTranscriptTurn(
          { agentId: "main", sessionId: draftSessionId, sessionKey: draftKey },
          {
            updateMode: "none",
            messages: [
              {
                message: makeUserMessage("foreign draft transcript", 1),
                now: Date.parse("2026-09-04T08:00:00.000Z"),
              },
            ],
          },
        );
        const sockets: Awaited<ReturnType<typeof openWs>>[] = [];
        const observePresence = (ws: Awaited<ReturnType<typeof openWs>>) => {
          const events: SystemPresence[][] = [];
          ws.on("message", (data) => {
            const frame = JSON.parse(rawDataToString(data)) as {
              type: string;
              event?: string;
              payload: { presence: SystemPresence[] };
            };
            if (frame.type === "event" && frame.event === "presence") {
              events.push(frame.payload.presence);
            }
          });
          return events;
        };
        const openRecipient = async (
          name: string,
          scopes: string[],
          role: "operator" | "node" = "operator",
        ) => {
          const ws = await openWs(port, {
            ...TRUSTED_PROXY_HEADERS,
            "x-forwarded-user": `${name}@example.com`,
          });
          sockets.push(ws);
          const events = observePresence(ws);
          const client = {
            ...(role === "node" ? NODE_CLIENT : CONTROL_UI_CLIENT),
            instanceId: name === "watcher" ? watcherInstanceId : `presence-${name}`,
            timeZone: "Europe/Vienna",
          };
          const connected = await connectReq(ws, {
            skipDefaultAuth: true,
            prePairDevice: true,
            scopes,
            role,
            client,
            deviceIdentityPath: path.join(
              identityDir,
              `${name}-${sockets.length}`,
              "client",
              "credentials.sqlite",
            ),
            browserOrigin: BROWSER_ORIGIN,
          });
          expect(connected.ok, `${name} connect: ${JSON.stringify(connected.error)}`).toBe(true);
          expect(responseScopes(connected), `${name} effective scopes`).toEqual(scopes);
          return {
            ws,
            events,
            hello: connected.payload as { snapshot: { presence: SystemPresence[] } },
          };
        };
        try {
          let guest = await openRecipient("guest", ["operator.sessions.write"]);
          const activity = {
            source: "activity",
            includePeople: true,
            includeOwnerSessionCounts: true,
          };
          const personActivity = { ...activity, involvingProfileId: creator.id };
          expect(await rpcReq(guest.ws, "sessions.list", personActivity)).toMatchObject({
            ok: true,
            payload: { sessions: [{ key: sharedKey }] },
          });
          expect(await rpcReq(guest.ws, "sessions.list", activity)).toMatchObject({
            ok: true,
            payload: {
              people: expect.arrayContaining([
                expect.objectContaining({ identity: { type: "profile", id: creator.id } }),
              ]),
            },
          });
          // A changed current-role presentation claim retires the warmed connection.
          const demoted = waitForWsClose(guest.ws, 1_000);
          setUserProfileRole(guestProfile.id, "guest");
          expect(await demoted).toBe(true);
          guest = await openRecipient("guest", ["operator.sessions.write"]);
          for (const method of ["users.list", "presence.query"]) {
            expect(await rpcReq(guest.ws, method, {})).toMatchObject({
              ok: false,
              error: { code: "FORBIDDEN" },
            });
          }
          // Online status stays visible to session readers, without device or activity detail.
          const guestPresence = await rpcReq(guest.ws, "system-presence", {});
          expect(guestPresence.ok).toBe(true);
          if (!Value.Check(Type.Array(PresenceEntrySchema), guestPresence.payload)) {
            throw new Error("demoted guest system-presence returned invalid presence rows");
          }
          for (const rows of [guest.hello.snapshot.presence, guestPresence.payload]) {
            expect(rows.flatMap((row) => personOnlyViolations(row))).toEqual([]);
          }
          expect(await rpcReq(guest.ws, "sessions.describe", { key: sharedKey })).toMatchObject({
            ok: true,
            payload: { session: { sessionId: sharedSessionId } },
          });
          expect(await rpcReq(guest.ws, "sessions.list", personActivity)).toMatchObject({
            ok: true,
            payload: { sessions: [{ key: sharedKey }] },
          });
          const afterDemotion = await rpcReq<SessionsListResult>(
            guest.ws,
            "sessions.list",
            activity,
          );
          expect(afterDemotion).toMatchObject({
            ok: true,
            payload: {
              totalCount: 2,
              people: expect.arrayContaining([
                expect.objectContaining({ identity: { type: "profile", id: guestProfile.id } }),
                expect.objectContaining({ identity: { type: "profile", id: creator.id } }),
              ]),
              owners: expect.arrayContaining([
                expect.objectContaining({ id: guestProfile.id }),
                expect.objectContaining({ id: creator.id }),
              ]),
              ownerSessionCounts: expect.arrayContaining([
                expect.objectContaining({ profileId: guestProfile.id, open: 1 }),
                expect.objectContaining({ profileId: creator.id, open: 1 }),
              ]),
              peopleSessionCount: 2,
            },
          });
          expect(afterDemotion.payload?.sessions.map((session) => session.key)).toEqual(
            expect.arrayContaining([guestKey, sharedKey]),
          );
          const watcher = await openRecipient("watcher", ["operator.admin"]);
          const declared = await rpcReq(watcher.ws, "sessions.viewers.set", {
            sessionKeys: watchedKeys,
          });
          expect(declared).toMatchObject({ ok: true, payload: { sessionKeys: watchedKeys } });
          const rawWatcher = listSystemPresence().find(
            (entry) => entry.instanceId === watcherInstanceId,
          );
          expect(rawWatcher?.watchedSessions).toEqual(watchedKeys);
          const { watchedSessions: _watchedSessions, ...person } = rawWatcher!;
          expect(person.user?.id).toBe(ensureProfileForEmail("watcher@example.com").id);
          expect(person.ts).toBeGreaterThan(0);
          expect(person).toMatchObject({
            onlineSince: expect.any(Number),
            lastActivityAt: expect.any(Number),
            timeZone: "Europe/Vienna",
          });

          const recipients = [];
          for (const scenario of [
            { name: "creator", scopes: ["operator.read"], allowed: [sharedKey, draftKey] },
            { name: "reader", scopes: ["operator.read"], allowed: [sharedKey] },
            { name: "writer", scopes: ["operator.write"], allowed: [sharedKey] },
            { name: "restricted", scopes: ["operator.read"], allowed: [restrictedKey] },
            {
              name: "admin",
              scopes: ["operator.admin"],
              allowed: [sharedKey, draftKey, incognitoKey, restrictedKey],
            },
            { name: "visitor", scopes: ["operator.sessions.write"], allowed: [sharedKey] },
            { name: "pairing", scopes: ["operator.pairing"], allowed: [] },
            { name: "no-read", scopes: [], allowed: [] },
            { name: "node", scopes: [], allowed: [] },
          ]) {
            const recipient = await openRecipient(
              scenario.name,
              scenario.scopes,
              scenario.name === "node" ? "node" : "operator",
            );
            const canRead = !["pairing", "node", "no-read"].includes(scenario.name);
            const listed = await rpcReq<{ sessions: Array<{ key: string }> }>(
              recipient.ws,
              "sessions.list",
              { agentId: "main" },
            );
            expect(listed.ok, `${scenario.name} sessions.list scope`).toBe(canRead);
            if (canRead) {
              expect(
                listed.payload?.sessions
                  .map((entry) => entry.key)
                  .filter((key) => watchedKeys.includes(key))
                  .toSorted(),
                `${scenario.name} canonical sessions.list visibility`,
              ).toEqual(scenario.allowed.filter((key) => key !== incognitoKey).toSorted());
              const canReadDraft = scenario.allowed.includes(draftKey);
              const described = await rpcReq<{ session: { sessionId?: string } | null }>(
                recipient.ws,
                "sessions.describe",
                { key: draftKey },
              );
              if (scenario.name === "restricted") {
                expect(described.ok, `${scenario.name} sessions.describe scope`).toBe(false);
              } else {
                expect(described, `${scenario.name} sessions.describe visibility`).toMatchObject({
                  ok: true,
                  payload: {
                    session: canReadDraft ? { sessionId: draftSessionId } : null,
                  },
                });
              }
              const transcript = await rpcReq<{ messages: Array<{ content?: unknown }> }>(
                recipient.ws,
                "sessions.get",
                { key: draftKey },
              );
              if (scenario.name === "restricted") {
                expect(transcript.ok, `${scenario.name} sessions.get scope`).toBe(false);
              } else {
                expect(transcript.ok, `${scenario.name} sessions.get visibility`).toBe(true);
                expect(
                  transcript.payload?.messages.map((message) => message.content),
                  `${scenario.name} sessions.get transcript`,
                ).toEqual(canReadDraft ? ["foreign draft transcript"] : []);
              }
            }
            const presence = await rpcReq(recipient.ws, "system-presence");
            expect(presence.ok, `${scenario.name} system-presence scope`).toBe(canRead);
            const query = await rpcReq<PresenceQueryResult>(
              recipient.ws,
              "presence.query",
              scenario.name === "reader" ? { include: ["devices", "network"] } : {},
            );
            if (scenario.name === "visitor") {
              expect(
                (await rpcReq(recipient.ws, "presence.activity", {})).ok,
                "guest reports its own activity",
              ).toBe(true);
            }
            // Device and network inventory stays an operator.read surface.
            const canQuery = canRead && scenario.name !== "visitor";
            expect(query.ok, `${scenario.name} presence.query scope`).toBe(canQuery);
            if (canQuery) {
              expect(query.payload).toMatchObject({
                status: "ok",
                observedAt: expect.any(Number),
                truncated: false,
              });
              const watcherPeople = query.payload?.people.filter(
                (entry) => entry.profileId === watcherProfile.id,
              );
              expect(watcherPeople, `${scenario.name} reads one named person`).toEqual([
                expect.objectContaining({ name: "Presence Watcher", online: true }),
              ]);
            } else {
              expect(query.payload).toBeUndefined();
            }
            recipients.push({ ...recipient, ...scenario, canRead, rpcPresence: presence.payload });
          }

          const unauthenticated = await openWs(port, { origin: BROWSER_ORIGIN });
          sockets.push(unauthenticated);
          const unauthenticatedEvents = observePresence(unauthenticated);
          const readers = recipients.filter(({ canRead }) => canRead);
          let activityPhase = "late-reader-connect";
          onTestFailed(() => console.error("[presence-activity-phase]", activityPhase));
          // The viewer declaration already published activity. Typing within its
          // 30-second window updates the store without another full roster event.
          const readNow = Date.now;
          const activityClock = vi.spyOn(Date, "now").mockImplementation(() => readNow() + 30_000);
          const typingStartedAt = Date.now();
          const eventPromises = readers.map(({ ws }) =>
            onceMessage<{ type: string; event: string; payload: { presence: SystemPresence[] } }>(
              ws,
              (frame) =>
                frame.type === "event" &&
                frame.event === "presence" &&
                frame.payload.presence.some(
                  (entry) =>
                    entry.user?.id === watcherProfile.id &&
                    entry.lastActivityAt !== undefined &&
                    entry.lastActivityAt >= typingStartedAt,
                ),
            ),
          );
          // Own event rejections before the typing request can fail or time out.
          const [events] = await Promise.all([
            Promise.all(eventPromises),
            // A late connection publishes an older snapshot before the typing activity.
            openRecipient("late-reader", ["operator.read"])
              .then(() => {
                activityPhase = "typing-rpc";
                return rpcReq(watcher.ws, "session.typing", {
                  sessionKey: sharedKey,
                  sessionId: sharedSessionId,
                  typing: true,
                });
              })
              .then((response) => {
                expect(response).toMatchObject({ ok: true });
                activityPhase = "presence-event";
              }),
          ]).finally(() => activityClock.mockRestore());
          activityPhase = "activity-complete";
          const activeWatcher = listSystemPresence().find(
            (entry) => entry.instanceId === watcherInstanceId,
          )!;
          const { watchedSessions: _activeWatches, ...activePerson } = activeWatcher;
          expect(activePerson.lastActivityAt).toBeGreaterThanOrEqual(person.lastActivityAt!);
          expect(activeWatcher.watchedSessions).toEqual(watchedKeys);
          for (const [index, recipient] of readers.entries()) {
            for (const [surface, rows] of [
              ["hello", recipient.hello.snapshot.presence],
              ["system-presence", recipient.rpcPresence],
              ["presence event", events[index]!.payload.presence],
            ] as const) {
              if (!Value.Check(Type.Array(PresenceEntrySchema), rows)) {
                throw new Error(`${recipient.name} ${surface} returned invalid presence rows`);
              }
              const personOnly = recipient.name === "visitor";
              const received = rows.find((entry) =>
                personOnly
                  ? entry.user?.id === watcherProfile.id
                  : entry.instanceId === watcherInstanceId,
              );
              const { watchedSessions, ...receivedPerson } = received ?? {};
              const expected = surface === "presence event" ? activePerson : person;
              expect
                .soft(
                  receivedPerson,
                  `${recipient.name} ${surface} preserves the person and timestamp without hidden counts`,
                )
                .toEqual(personOnly ? guestPresenceView(expected) : expected);
              if (personOnly) {
                expect(
                  rows.flatMap((row) => personOnlyViolations(row)),
                  `${surface} hides device, network, connection, and email fields from guests`,
                ).toEqual([]);
              }
              expect
                .soft(
                  watchedSessions ?? [],
                  `${recipient.name} ${surface} watched session disclosure`,
                )
                .toEqual(recipient.allowed.toSorted());
            }
          }
          for (const recipient of recipients.filter(({ canRead }) => !canRead)) {
            expect(recipient.hello.snapshot.presence, `${recipient.name} hello inventory`).toEqual(
              [],
            );
            expect(recipient.rpcPresence).toBeUndefined();
            // The activity fanout is synchronous. A later response on this socket
            // is a transport barrier, so absence does not depend on sleeping.
            expect((await rpcReq(recipient.ws, "health")).ok).toBe(true);
            expect(recipient.events, `${recipient.name} activity-driven frames`).toEqual([]);
          }
          const preauthRead = await rpcReq(unauthenticated, "system-presence");
          expect(preauthRead.ok).toBe(false);
          expect(preauthRead.payload).toBeUndefined();
          expect(unauthenticatedEvents).toEqual([]);

          const rejected = await openWs(port, { origin: BROWSER_ORIGIN });
          sockets.push(rejected);
          const rejectedEvents = observePresence(rejected);
          const connect = await connectReq(rejected, {
            skipDefaultAuth: true,
            device: null,
            scopes: ["operator.read", "operator.admin"],
            client: CONTROL_UI_CLIENT,
          });
          expect(connect.ok).toBe(false);
          expect(connect.payload).toBeUndefined();
          expect(rejectedEvents).toEqual([]);
        } finally {
          for (const ws of sockets) {
            ws.close();
          }
        }
      });
    });
  });
});
