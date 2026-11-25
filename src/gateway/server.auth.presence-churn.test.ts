import { once } from "node:events";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { SystemPresence } from "../infra/system-presence.js";
import {
  BACKEND_GATEWAY_CLIENT,
  connectReq,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
  onceMessage,
  openWs,
  withGatewayServer,
} from "./server.auth.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

test("replaces offline rows across signed Control UI reconnects in hello and presence events", async () => {
  const identityPath = path.join(
    tempDirs.make("presence-reconnect-"),
    "client",
    "credentials.sqlite",
  );
  const instanceId = "presence-reconnect";
  await withGatewayServer(async ({ port }) => {
    const origin = `http://127.0.0.1:${port}`;
    const observer = await openWs(port);
    let current: Awaited<ReturnType<typeof openWs>> | undefined;
    const nextPresence = (reason: "connect" | "disconnect") =>
      onceMessage<{
        type: string;
        event: string;
        payload: { presence: SystemPresence[] };
      }>(
        observer,
        (frame) =>
          frame.type === "event" &&
          frame.event === "presence" &&
          frame.payload.presence.some(
            (row) => row.instanceId === instanceId && row.reason === reason,
          ),
      );
    try {
      expect((await connectReq(observer, { client: BACKEND_GATEWAY_CLIENT })).ok).toBe(true);
      for (let connect = 0; connect < 3; connect += 1) {
        if (current) {
          const disconnected = nextPresence("disconnect");
          const closed = once(current, "close");
          current.close();
          await Promise.all([closed, disconnected]);
        }
        current = await openWs(port, { origin });
        const published = nextPresence("connect");
        const response = await connectReq(current, {
          client: { ...CONTROL_UI_CLIENT, instanceId },
          deviceIdentityPath: identityPath,
          browserOrigin: origin,
          prePairDevice: true,
        });
        expect(response.ok, JSON.stringify(response.error)).toBe(true);
        const hello = response.payload as {
          snapshot: { presence: SystemPresence[] };
          server: { connId: string };
        };
        const event = await published;
        for (const rows of [hello.snapshot.presence, event.payload.presence]) {
          expect(rows.filter((row) => row.instanceId === instanceId)).toMatchObject([
            { connectionId: hello.server.connId, reason: "connect" },
          ]);
        }
      }
    } finally {
      current?.close();
      observer.close();
    }
  });
});
