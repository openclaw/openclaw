import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterEach, expect, test, vi } from "vitest";
import type { WebSocket } from "../../packages/gateway-client/src/websocket.test-support.js";
import type { PresenceUpdate } from "../../packages/gateway-protocol/src/presence-deltas.js";
import type { PresenceEntry } from "../../packages/gateway-protocol/src/schema/snapshot.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
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
  rowsUpserted: number;
  changed: Array<{ row: string; fields: string[] }>;
  rows: PresenceEntry[];
};

function observePresence(ws: WebSocket) {
  const observations: Observation[] = [];
  let entries = new Map<string, PresenceEntry>();
  let previousRows = new Map<string, PresenceEntry>();
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
    const transmitted =
      "upsert" in payload ? payload.upsert.map(({ key }) => entries.get(key)!) : rows;
    const changed = transmitted.map((row) => {
      const identity = row.connectionId ?? row.instanceId ?? "gateway";
      const previous = previousRows.get(identity);
      const fields = [...new Set([...Object.keys(previous ?? {}), ...Object.keys(row)])].filter(
        (field) =>
          JSON.stringify(previous?.[field as keyof PresenceEntry]) !==
          JSON.stringify(row[field as keyof PresenceEntry]),
      );
      return { row: row.mode === "gateway" ? "gateway" : (row.instanceId ?? "unknown"), fields };
    });
    previousVersion = frame.stateVersion.presence;
    previousRows = new Map(
      rows.map((row) => [row.connectionId ?? row.instanceId ?? "gateway", row]),
    );
    observations.push({
      version: frame.stateVersion.presence,
      mode,
      bytes: Buffer.byteLength(serialized),
      rowsUpserted: transmitted.length,
      changed,
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
          client: { ...CONTROL_UI_CLIENT, instanceId: `presence-browser-${index}` },
          caps: capable ? webCapabilities : [],
          deviceIdentityPath: path.join(identityDir, `browser-${index}.sqlite`),
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
            ({ rows }) =>
              rows
                .filter((row) => row.instanceId?.startsWith("presence-browser-"))
                .every(
                  (row) =>
                    row.ts === now &&
                    row.lastActivityAt === now &&
                    row.connectionLastActivityAt === now &&
                    JSON.stringify(row.watchedSessions ?? []) === JSON.stringify(watched),
                ),
          ),
        );
      }
      console.log(
        "presence-mode-observations",
        JSON.stringify(
          rounds.map((round, publicationIndex) =>
            round.map(({ rows: _rows, ...observation }, socket) => ({
              publication: publicationIndex + 1,
              socket,
              ...observation,
            })),
          ),
        ),
      );
      for (const round of rounds) {
        for (const [index, observation] of round.entries()) {
          expect(observation.mode).toBe(clients[index]!.capable ? "delta" : "legacy");
          if (clients[index]!.capable) {
            expect(observation.bytes).toBeLessThan(round[0]!.bytes / 2);
          }
        }
      }
    } finally {
      console.log(
        "presence-frame-trace",
        JSON.stringify(
          clients.map(({ capable, observations }, socket) => ({
            socket,
            capable,
            frames: observations.map(({ rows: _rows, ...frame }) => frame),
          })),
        ),
      );
      clock.mockRestore();
      for (const { ws } of clients) {
        ws.close();
      }
    }
  });
});
