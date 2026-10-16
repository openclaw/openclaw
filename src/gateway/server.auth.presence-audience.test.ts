import { randomUUID } from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, expect, test, vi } from "vitest";
import type { PresenceQueryResult } from "../../packages/gateway-protocol/src/schema/presence.js";
import { PresenceEntrySchema } from "../../packages/gateway-protocol/src/schema/snapshot.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeConfigFile } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { GatewayAuthConfig, GatewayOperatorRolesConfig } from "../config/types.gateway.js";
import { listSystemPresence, type SystemPresence } from "../infra/system-presence.js";
import { setDisplayName, setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  connectReq,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
  NODE_CLIENT,
  onceMessage,
  openWs,
  rpcReq,
  testState,
  withGatewayServer,
} from "./server.auth.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const BROWSER_ORIGIN = "https://control.example.com";
const TRUSTED_PROXY_HEADERS = {
  origin: BROWSER_ORIGIN,
  "x-forwarded-for": "203.0.113.50",
  "x-forwarded-proto": "https",
  "x-forwarded-user": "admin@example.com",
};

function responseScopes(response: Awaited<ReturnType<typeof connectReq>>): string[] | undefined {
  return (response.payload as { auth?: { scopes?: string[] } } | undefined)?.auth?.scopes;
}

type PresenceFrame = { type: string; event: string; payload: { presence: SystemPresence[] } };
type PresenceSocket = Awaited<ReturnType<typeof openWs>>;
const personTiming = {
  onlineSince: expect.any(Number),
  lastActivityAt: expect.any(Number),
  timeZone: "Europe/Vienna",
};
const currentPerson = (instanceId: string) =>
  listSystemPresence().find((entry) => entry.instanceId === instanceId)!;
function nextPresence(ws: PresenceSocket, matches: (rows: SystemPresence[]) => boolean) {
  return onceMessage<PresenceFrame>(
    ws,
    (frame) =>
      frame.type === "event" && frame.event === "presence" && matches(frame.payload.presence),
  );
}
function observePresence(ws: PresenceSocket) {
  const events: SystemPresence[][] = [];
  ws.on("message", (data) => {
    const frame = JSON.parse(rawDataToString(data)) as PresenceFrame;
    if (frame.type === "event" && frame.event === "presence") {
      events.push(frame.payload.presence);
    }
  });
  return events;
}

test("shares people only with readers and filters their session references across hello, RPC, and activity events", async () => {
  const auth: GatewayAuthConfig = {
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
  };
  const roles: GatewayOperatorRolesConfig = {
    default: "reader",
    definitions: {
      reader: { sessions: { others: "view" }, agents: "*", scopes: ["operator.read"] },
      writer: { sessions: { others: "write" }, agents: "*", scopes: ["operator.write"] },
      restricted: { sessions: { others: "none" }, agents: "*", scopes: ["operator.read"] },
      maintainer: { sessions: { others: "write" }, agents: "*", scopes: ["operator.admin"] },
      pairing: { sessions: { others: "none" }, agents: [], scopes: ["operator.pairing"] },
    },
  };
  testState.gatewayAuth = auth;
  testState.gatewayControlUi = { allowedOrigins: [BROWSER_ORIGIN] };
  await writeConfigFile({
    gateway: { auth, roles, trustedProxies: ["127.0.0.1"], controlUi: testState.gatewayControlUi },
  });
  const creator = ensureProfileForEmail("creator@example.com");
  const restricted = ensureProfileForEmail("restricted@example.com");
  setUserProfileRole(restricted.id, "restricted");
  setUserProfileRole(ensureProfileForEmail("admin@example.com").id, "maintainer");
  const watcherProfile = ensureProfileForEmail("watcher@example.com");
  setUserProfileRole(watcherProfile.id, "maintainer");
  setDisplayName(watcherProfile.id, "Presence Watcher");
  setUserProfileRole(ensureProfileForEmail("writer@example.com").id, "writer");
  setUserProfileRole(ensureProfileForEmail("pairing@example.com").id, "pairing");
  const sharedKey = "agent:main:presence-shared";
  const sharedSessionId = randomUUID();
  const draftKey = "agent:main:presence-draft";
  const incognitoKey = "agent:main:dashboard:incognito-presence";
  const restrictedKey = "agent:main:presence-restricted-draft";
  const missingKey = "agent:main:presence-missing";
  const watchedKeys = [sharedKey, draftKey, incognitoKey, restrictedKey, missingKey].toSorted();
  const watcherInstanceId = `presence-watcher-${randomUUID()}`;
  const identityDir = tempDirs.make("openclaw-presence-identities-");

  await withGatewayServer(async ({ port }) => {
    for (const [sessionKey, sessionId, profileId, visibility, incognito] of [
      [sharedKey, sharedSessionId, creator.id, "shared", false],
      [draftKey, randomUUID(), creator.id, "draft", false],
      [incognitoKey, randomUUID(), creator.id, "shared", true],
      [restrictedKey, randomUUID(), restricted.id, "draft", false],
    ] as const) {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId,
          updatedAt: Date.now(),
          createdVia: "operator",
          createdActor: { type: "human", source: "profile", id: profileId },
          visibility,
          ...(incognito ? { incognito: true } : {}),
        },
      );
    }
    const sockets: PresenceSocket[] = [];
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
        deviceIdentityPath: path.join(identityDir, `${name}-${sockets.length}.sqlite`),
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
      const watcher = await openRecipient("watcher", ["operator.admin"]);
      // Join publication itself: an RPC response can precede the coalescing window.
      const firstConnect = nextPresence(watcher.ws, (rows) =>
        rows.some((entry) => entry.instanceId === "presence-idle" && entry.reason === "connect"),
      );
      const [idle] = await Promise.all([openRecipient("idle", ["operator.read"]), firstConnect]);
      expect
        .soft(watcher.events.at(-1), "first connect publishes without activity")
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({ instanceId: "presence-idle", reason: "connect" }),
          ]),
        );
      for (const sessionKeys of [[sharedKey], []]) {
        expect(await rpcReq(idle.ws, "sessions.viewers.set", { sessionKeys })).toMatchObject({
          ok: true,
        });
      }
      const idlePerson = currentPerson("presence-idle");
      expect(idlePerson.watchedSessions).toBeUndefined();
      expect(idlePerson).toMatchObject(personTiming);
      const idleBefore = structuredClone(idlePerson);
      const now = vi.spyOn(Date, "now").mockReturnValue(idleBefore.ts + 1000);
      try {
        for (const email of ["creator@example.com", "presence-unrelated@example.test"]) {
          // No await: committed profile notifications settle synchronously,
          // without a heartbeat interleaving with this unchanged-row check.
          ensureProfileForEmail(email);
          expect(
            currentPerson("presence-idle"),
            `${email} must preserve unrelated presence`,
          ).toEqual(idleBefore);
        }
      } finally {
        now.mockRestore();
      }
      const declared = await rpcReq(watcher.ws, "sessions.viewers.set", {
        sessionKeys: watchedKeys,
      });
      expect(declared).toMatchObject({ ok: true, payload: { sessionKeys: watchedKeys } });
      const rawWatcher = currentPerson(watcherInstanceId);
      expect(rawWatcher?.watchedSessions).toEqual(watchedKeys);
      const { watchedSessions: _watchedSessions, ...person } = rawWatcher!;
      expect(person.user?.id).toBe(ensureProfileForEmail("watcher@example.com").id);
      expect(person.ts).toBeGreaterThan(0);
      expect(person).toMatchObject({
        ...personTiming,
        ip: "203.0.113.50",
        user: { name: "Presence Watcher" },
      });

      const recipients = [];
      for (const { name, scopes, allowed } of [
        { name: "creator", scopes: ["operator.read"], allowed: [sharedKey, draftKey] },
        { name: "reader", scopes: ["operator.read"], allowed: [sharedKey] },
        { name: "writer", scopes: ["operator.write"], allowed: [sharedKey] },
        { name: "restricted", scopes: ["operator.read"], allowed: [restrictedKey] },
        {
          name: "admin",
          scopes: ["operator.admin"],
          allowed: [sharedKey, draftKey, incognitoKey, restrictedKey],
        },
        { name: "pairing", scopes: ["operator.pairing"], allowed: [] },
        { name: "no-read", scopes: [], allowed: [] },
        { name: "node", scopes: [], allowed: [] },
      ]) {
        const recipient = await openRecipient(name, scopes, name === "node" ? "node" : "operator");
        const canRead = !["pairing", "node", "no-read"].includes(name);
        const read = async <T extends Record<string, unknown>>(
          method: string,
          params: unknown = {},
          permitted = canRead,
        ) => {
          const result = await rpcReq<T>(recipient.ws, method, params);
          expect(result.ok, `${name} ${method} scope`).toBe(permitted);
          return result.payload;
        };
        await read("sessions.list", { agentId: "main" });
        if (name === "restricted") {
          for (const method of ["sessions.describe", "sessions.get"]) {
            await read(method, { key: draftKey }, false);
          }
        }
        const presence = await read("system-presence");
        const query = await read<PresenceQueryResult>(
          "presence.query",
          name === "reader" ? { include: ["devices", "network"] } : {},
        );
        if (!canRead) {
          expect(query).toBeUndefined();
        }
        recipients.push({
          ...recipient,
          name,
          allowed,
          canRead,
          rpcPresence: presence,
        });
      }

      const unauthenticated = await openWs(port, { origin: BROWSER_ORIGIN });
      sockets.push(unauthenticated);
      const unauthenticatedEvents = observePresence(unauthenticated);
      const readers = recipients.filter(({ canRead }) => canRead);
      // The viewer declaration already published activity. Typing within its
      // 30-second window updates the store without another full roster event.
      const readNow = Date.now;
      const activityClock = vi.spyOn(Date, "now").mockImplementation(() => readNow() + 30_000);
      const typingStartedAt = Date.now();
      const eventPromises = readers.map(({ ws }) =>
        nextPresence(ws, (rows) =>
          rows.some(
            (entry) =>
              entry.instanceId === watcherInstanceId &&
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
          .then(() =>
            rpcReq(watcher.ws, "session.typing", {
              sessionKey: sharedKey,
              sessionId: sharedSessionId,
              typing: true,
            }),
          )
          .then((response) => expect(response).toMatchObject({ ok: true })),
      ]).finally(() => activityClock.mockRestore());
      const activeWatcher = currentPerson(watcherInstanceId);
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
          const received = rows.find((entry) => entry.instanceId === watcherInstanceId);
          const { watchedSessions, ...receivedPerson } = received ?? {};
          expect
            .soft(
              receivedPerson,
              `${recipient.name} ${surface} preserves the person and timestamp without hidden counts`,
            )
            .toEqual(surface === "presence event" ? activePerson : person);
          expect(rows.find((entry) => entry.instanceId === "presence-idle")).toEqual(idlePerson);
          expect
            .soft(watchedSessions ?? [], `${recipient.name} ${surface} watched session disclosure`)
            .toEqual(recipient.allowed.toSorted());
        }
      }
      for (const recipient of recipients.filter(({ canRead }) => !canRead)) {
        expect(recipient.hello.snapshot.presence, `${recipient.name} hello inventory`).toEqual([]);
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

      const isLiveIdle = (entry: SystemPresence) =>
        entry.user?.id === idlePerson.user?.id && entry.reason !== "disconnect";
      const nextIdleRows = (count: number) =>
        nextPresence(watcher.ws, (rows) => rows.filter(isLiveIdle).length === count).then(
          ({ payload }) => payload.presence.filter(isLiveIdle),
        );
      const [overlappingRows, overlap] = await Promise.all([
        nextIdleRows(2),
        openRecipient("idle", ["operator.read"]),
      ]);
      expect.soft(overlappingRows, "overlapping connect publishes both sockets").toHaveLength(2);
      for (const entry of overlappingRows) {
        expect(entry.onlineSince).toBe(idlePerson.onlineSince);
        expect(entry.lastActivityAt).toBe(idlePerson.lastActivityAt);
      }
      for (const [connection, remaining] of [
        [idle, 1],
        [overlap, 0],
      ] as const) {
        // A different socket's response cannot join this connection's server close.
        const disconnected = nextIdleRows(remaining);
        const closed = once(connection.ws, "close");
        connection.ws.close();
        const [, rows] = await Promise.all([closed, disconnected]);
        expect(rows, "disconnect publishes only the surviving sockets").toHaveLength(remaining);
        if (remaining) {
          expect(rows[0]?.onlineSince).toBe(idlePerson.onlineSince);
        }
      }
      const [reconnectedRows, reconnected] = await Promise.all([
        nextIdleRows(1),
        openRecipient("idle", ["operator.read"]),
      ]);
      const returnedPerson = reconnected.hello.snapshot.presence.find(
        (entry) => entry.user?.id === idlePerson.user?.id && entry.reason === "connect",
      )!;
      expect(returnedPerson.onlineSince).toBeGreaterThan(idlePerson.onlineSince!);
      expect(returnedPerson.lastActivityAt).toBeUndefined();
      expect(returnedPerson.watchedSessions).toBeUndefined();
      expect(reconnectedRows, "reconnect publishes without profile edit or activity").toEqual([
        returnedPerson,
      ]);
      for (const recipient of recipients.filter(({ canRead }) => !canRead)) {
        expect((await rpcReq(recipient.ws, "health")).ok).toBe(true);
        expect(recipient.events, `${recipient.name} connection-driven frames`).toEqual([]);
      }

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
