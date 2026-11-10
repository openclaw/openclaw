import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterEach, expect, test, vi } from "vitest";
import type { WebSocket } from "../../packages/gateway-client/src/websocket.test-support.js";
import type { PresenceUpdate } from "../../packages/gateway-protocol/src/presence-deltas.js";
import type { PresenceEntry } from "../../packages/gateway-protocol/src/schema/snapshot.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { listSystemPresence } from "../infra/system-presence.js";
import {
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
// The web connect plan advertises these capabilities for browser-owned device identities.
const webCapabilities = [
  "agent-kind",
  "approvals",
  "task-suggestions",
  "terminal-offset-seq",
  "terminal-session-metadata",
  "terminal-upload-path-style",
  "tool-events",
  "chat-only-assistant-text",
  "hello-health-on-demand",
  "health-summary",
  "hello-presence-self",
  "session-scoped-events",
  "presence-deltas",
  "session-row-deltas",
  "inline-widgets",
  "model-selection-policy",
  "model-wait-status",
  "ui-commands",
  "ultrafast",
  "usage-refreshing",
];

type Frame = {
  type: "event";
  event: "presence";
  payload: PresenceUpdate | { presence: PresenceEntry[] };
  stateVersion: { presence: number };
};
type Observation = {
  version: number;
  mode: "delta" | "reset" | "legacy";
  bytes: number;
  rows: PresenceEntry[];
};

function observePresence(ws: WebSocket) {
  const observations: Observation[] = [];
  let entries = new Map<string, PresenceEntry>();
  let previousVersion: number | undefined;
  ws.on("message", (data) => {
    const serialized = rawDataToString(data);
    const frame = JSON.parse(serialized) as Frame;
    if (frame.type !== "event" || frame.event !== "presence") {
      return;
    }
    const payload = frame.payload;
    const mode = "reset" in payload ? "reset" : "upsert" in payload ? "delta" : "legacy";
    if ("presence" in payload) {
      entries = new Map(
        payload.presence.map((row, index) => [
          ("keys" in payload ? payload.keys[index] : undefined) ??
            row.connectionId ??
            row.instanceId ??
            "gateway",
          row,
        ]),
      );
    } else {
      expect(payload.base, "deltas chain from the last delivered frame").toBe(previousVersion);
      for (const key of payload.remove) {
        entries.delete(key);
      }
      for (const update of payload.upsert) {
        if ("presence" in update) {
          entries.set(update.key, update.presence);
        } else {
          const existing = entries.get(update.key);
          expect(existing, "field patches require a previously delivered row").toBeDefined();
          const next = { ...existing!, ...update.set };
          for (const field of update.unset) {
            delete next[field as keyof PresenceEntry];
          }
          entries.set(update.key, next);
        }
      }
    }
    const rows =
      "order" in payload ? payload.order.map((key) => entries.get(key)!) : [...entries.values()];
    previousVersion = frame.stateVersion.presence;
    observations.push({
      version: frame.stateVersion.presence,
      mode,
      bytes: Buffer.byteLength(serialized),
      rows,
    });
  });
  return observations;
}

test("keeps multi-client presence compact through heartbeat, activity, and watched-session churn", async () => {
  const identityDir = tempDirs.make("presence-modes-");
  await withGatewayServer(async ({ port }) => {
    const clients: Array<{ ws: WebSocket; observations: Observation[]; capable: boolean }> = [];
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      const origin = `http://127.0.0.1:${port}`;
      for (let index = 0; index < 8; index += 1) {
        const ws = await openWs(port, { origin });
        const observations = observePresence(ws);
        const capable = index >= 2;
        clients.push({ ws, observations, capable });
        const result = await connectReq(ws, {
          client: {
            ...CONTROL_UI_CLIENT,
            instanceId: `presence-browser-${index}`,
            deviceFamily: "Laptop",
            modelIdentifier: "presence-test-device",
            timeZone: "Europe/Paris",
          },
          caps: capable ? webCapabilities : [],
          deviceIdentityPath: path.join(
            identityDir,
            `browser-${index}`,
            "client",
            "credentials.sqlite",
          ),
          browserOrigin: origin,
          prePairDevice: true,
        });
        expect(result.ok, JSON.stringify(result.error)).toBe(true);
      }
      const sessionKey = "agent:main:presence-modes-watched";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        { sessionId: "presence-modes-session", updatedAt: Date.now(), visibility: "shared" },
      );
      const publication = async (
        run: () => Promise<void>,
        matches: (observation: Observation) => boolean,
      ) => {
        const received = clients.map(({ ws, observations }) =>
          onceMessage<Frame>(
            ws,
            (frame) =>
              frame.type === "event" && frame.event === "presence" && matches(observations.at(-1)!),
          ),
        );
        await run();
        await Promise.all(received);
        const latest = clients.map(({ observations }) => observations.at(-1)!);
        for (const observation of latest) {
          expect(observation.version).toBe(latest[0]!.version);
          expect(observation.rows).toEqual(latest[0]!.rows);
        }
        return latest;
      };
      // Establish a delivered baseline before touching every live browser row.
      await publication(
        async () => {
          expect(
            (await rpcReq(clients[0]!.ws, "sessions.viewers.set", { sessionKeys: [sessionKey] }))
              .ok,
          ).toBe(true);
        },
        ({ rows }) =>
          rows.some(
            (row) =>
              row.instanceId === "presence-browser-0" && row.watchedSessions?.includes(sessionKey),
          ),
      );
      const beforeEviction = clients[0]!.observations
        .at(-1)!
        .rows.filter((row) => row.instanceId?.startsWith("presence-browser-"));
      expect(beforeEviction).toHaveLength(clients.length);
      const identities = new Map(
        beforeEviction.map((row) => [
          row.connectionId,
          { instanceId: row.instanceId, deviceId: row.deviceId },
        ]),
      );
      for (const { deviceId } of identities.values()) {
        expect(deviceId).toMatch(/^[a-f0-9]{64}$/);
      }
      // Expire the cached rows without introducing peers outside the live-client projection.
      clock.mockReturnValue(Date.now() + 5 * 60_000 + 1);
      const recoveredAt = Date.now();
      expect(
        listSystemPresence().filter((row) => row.instanceId?.startsWith("presence-browser-")),
      ).toEqual([]);
      const recovered = await publication(
        async () => {
          await Promise.all(
            clients.map(async ({ ws }) => {
              ws.pong();
              expect((await rpcReq(ws, "presence.activity", {})).ok).toBe(true);
            }),
          );
        },
        ({ rows }) => {
          const browsers = rows.filter((row) => identities.has(row.connectionId));
          return (
            browsers.length === clients.length &&
            browsers.every((row) => row.connectionLastActivityAt === recoveredAt)
          );
        },
      );
      for (const observation of recovered) {
        for (const row of observation.rows.filter((entry) => identities.has(entry.connectionId))) {
          expect(row).toMatchObject({
            ...identities.get(row.connectionId),
            version: "1.0.0",
            platform: "web",
            deviceFamily: "Laptop",
            modelIdentifier: "presence-test-device",
            timeZone: "Europe/Paris",
          });
          expect(row.ip).toBeUndefined();
          expect(row.watchedSessions ?? []).toEqual(
            row.instanceId === "presence-browser-0" ? [sessionKey] : [],
          );
        }
      }
      const rounds: Observation[][] = [];
      for (let round = 0; round < 3; round += 1) {
        clock.mockReturnValue(Date.now() + 31_000);
        const now = Date.now();
        const watched = round % 2 === 0 ? [] : [sessionKey];
        rounds.push(
          await publication(
            async () => {
              await Promise.all(
                clients.map(async ({ ws }) => {
                  // A pong is the real socket liveness boundary that renews stored presence.ts.
                  ws.pong();
                  expect((await rpcReq(ws, "presence.activity", {})).ok).toBe(true);
                  expect(
                    (
                      await rpcReq(ws, "sessions.viewers.set", {
                        sessionKeys: watched,
                      })
                    ).ok,
                  ).toBe(true);
                }),
              );
            },
            ({ rows }) => {
              const browsers = rows.filter((row) =>
                row.instanceId?.startsWith("presence-browser-"),
              );
              return (
                browsers.length === clients.length &&
                browsers.every(
                  (row) =>
                    row.ts === now &&
                    row.lastActivityAt === now &&
                    row.connectionLastActivityAt === now &&
                    JSON.stringify(row.watchedSessions ?? []) === JSON.stringify(watched),
                )
              );
            },
          ),
        );
      }
      for (const round of rounds) {
        for (const [index, observation] of round.entries()) {
          expect(observation.mode).toBe(clients[index]!.capable ? "delta" : "legacy");
          if (clients[index]!.capable) {
            expect(observation.bytes).toBeLessThan(round[0]!.bytes / 2);
          }
        }
      }
    } finally {
      clock.mockRestore();
      for (const { ws } of clients) {
        ws.close();
      }
    }
  });
});
