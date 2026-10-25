import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterEach, expect, test, vi } from "vitest";
import type { WebSocket } from "../../packages/gateway-client/src/websocket.test-support.js";
import type { PresenceUpdate } from "../../packages/gateway-protocol/src/presence-deltas.js";
import type { PresenceEntry } from "../../packages/gateway-protocol/src/schema/snapshot.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createGatewayPresenceObserver } from "../../ui/src/app/gateway-store.presence.js";
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

async function request(ws: WebSocket, method: string, params: Record<string, unknown>) {
  expect((await rpcReq(ws, method, params)).ok).toBe(true);
}

function observePresence(ws: WebSocket) {
  const observations: Observation[] = [];
  // Independent wire reconstruction lives in server.auth.presence-deltas.test.ts.
  const observer = createGatewayPresenceObserver({
    requestSnapshot: async () => {
      throw new Error("Unexpected presence recovery");
    },
    publish: () => {},
    onError: (error) => {
      throw error;
    },
  });
  observer.synchronize({});
  ws.on("message", (data) => {
    const serialized = rawDataToString(data);
    const frame = JSON.parse(serialized) as Frame;
    if (frame.type !== "event" || frame.event !== "presence") {
      return;
    }
    const payload = frame.payload;
    const mode = "reset" in payload ? "reset" : "upsert" in payload ? "delta" : "legacy";
    const normalized = mode === "legacy" ? frame : observer.receive(frame);
    expect(normalized, "every presence frame is consumable without recovery").toBeDefined();
    const rows = (normalized!.payload as { presence: PresenceEntry[] }).presence;
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
          client: { ...CONTROL_UI_CLIENT, instanceId: `presence-browser-${index}` },
          caps: capable ? ["hello-presence-self", "presence-deltas"] : [],
          deviceIdentityPath: path.join(identityDir, `browser-${index}`, "credentials.sqlite"),
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
        () => request(clients[0]!.ws, "sessions.viewers.set", { sessionKeys: [sessionKey] }),
        ({ rows }) =>
          rows.some(
            (row) =>
              row.instanceId === "presence-browser-0" && row.watchedSessions?.includes(sessionKey),
          ),
      );
      for (let round = 0; round < 3; round += 1) {
        clock.mockReturnValue(Date.now() + 31_000);
        const now = Date.now();
        const watched = round % 2 === 0 ? [] : [sessionKey];
        const latest = await publication(
          async () => {
            await Promise.all(
              clients.map(async ({ ws }) => {
                // A pong is the real socket liveness boundary that renews stored presence.ts.
                ws.pong();
                await request(ws, "presence.activity", {});
                await request(ws, "sessions.viewers.set", { sessionKeys: watched });
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
        );
        for (const [index, observation] of latest.entries()) {
          expect(observation.mode).toBe(clients[index]!.capable ? "delta" : "legacy");
          if (clients[index]!.capable) {
            expect(observation.bytes).toBeLessThan(latest[0]!.bytes / 2);
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
