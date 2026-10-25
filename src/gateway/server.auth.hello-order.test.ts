import { once } from "node:events";
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { WebSocket } from "../../packages/gateway-client/src/websocket.test-support.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { issueDevicePairSetupBootstrapToken } from "../infra/device-bootstrap.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { upsertPresence, type SystemPresence } from "../infra/system-presence.js";
import { NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE } from "../shared/device-bootstrap-profile.js";
import {
  connectReq,
  BROWSER_ORIGIN as origin,
  configureBrowserAuth,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
  openWs,
  onceMessage,
  withGatewayServer,
} from "./server.auth.test-helpers.js";
import { connectWatchNode } from "./watch-node-http.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type ObservedFrame = {
  type?: string;
  id?: string;
  event?: string;
  payload?: {
    type?: string;
    presence?: SystemPresence[];
    snapshot?: { presence?: SystemPresence[] };
  };
};

beforeEach(() => configureBrowserAuth());

async function openBrowser(port: number, instanceId: string, caps: string[] = []) {
  const identityPath = path.join(tempDirs.make("hello-browser-"), "client", "credentials.sqlite");
  const socket = await openWs(port, {
    origin,
    "x-forwarded-for": "203.0.113.50",
    "x-forwarded-proto": "https",
    "x-forwarded-user": `${instanceId}@example.com`,
  });
  const frames: ObservedFrame[] = [];
  socket.on("message", (data) => frames.push(JSON.parse(rawDataToString(data))));
  return {
    socket,
    frames,
    connect: () =>
      connectReq(socket, {
        skipDefaultAuth: true,
        prePairDevice: true,
        deviceIdentityPath: identityPath,
        client: { ...CONTROL_UI_CLIENT, instanceId },
        scopes: ["operator.read"],
        caps,
        browserOrigin: origin,
      }),
  };
}

function presenceReasons(frames: ObservedFrame[], instanceId: string) {
  return frames
    .filter((frame) => frame.event === "presence")
    .flatMap((frame) => frame.payload?.presence ?? [])
    .filter((entry) => entry.instanceId === instanceId)
    .map((entry) => entry.reason);
}

function waitForPresence(socket: WebSocket, matches: (entry: SystemPresence) => boolean) {
  return onceMessage<ObservedFrame>(
    socket,
    (frame) => frame.event === "presence" && frame.payload?.presence?.some(matches) === true,
  );
}

// withGatewayServer closes admitted and pending sockets in its shutdown owner.
test("publishes an HTTP node replacing an undelivered WebSocket presence row", async () => {
  await withGatewayServer(async ({ port }) => {
    const reader = await openBrowser(port, "http-presence-reader");
    expect((await reader.connect()).ok).toBe(true);
    const identity = loadOrCreateDeviceIdentity({ identityKey: "hello-http-node" });
    const issued = await issueDevicePairSetupBootstrapToken({
      profile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    });
    upsertPresence(
      identity.deviceId,
      { connectionId: "undelivered-ws", deviceId: identity.deviceId, reason: "connect" },
      { pending: true },
    );
    const published = waitForPresence(reader.socket, (row) => row.deviceId === identity.deviceId);
    const response = await connectWatchNode({
      baseUrl: `http://127.0.0.1:${port}/api/nodes/watch`,
      identity,
      bootstrapToken: issued.token,
    });
    expect(response.status).toBe(200);
    const entry = (await published).payload?.presence?.find(
      (row) => row.deviceId === identity.deviceId,
    );
    expect(entry).toMatchObject({ reason: "connect", connectionId: expect.any(String) });
    expect(entry?.connectionId).not.toBe("undelivered-ws");
  });
});

test.each([false, true])(
  "sends hello before the roster with self-only presence=%s",
  async (selfOnly) => {
    await withGatewayServer(async ({ port }) => {
      const reader = await openBrowser(port, "established-reader");
      const joining = await openBrowser(
        port,
        "joining-browser",
        selfOnly ? ["hello-presence-self"] : [],
      );
      expect((await reader.connect()).ok).toBe(true);
      const notified = waitForPresence(
        reader.socket,
        (entry) => entry.instanceId === "joining-browser" && entry.reason === "connect",
      );
      const roster = waitForPresence(
        joining.socket,
        (entry) => entry.instanceId === "established-reader",
      );
      const [result] = await Promise.all([joining.connect(), notified, roster]);
      expect(result.ok, JSON.stringify(result.error)).toBe(true);
      const firstFrame = joining.frames.find((frame) => frame.event !== "connect.challenge");
      expect(firstFrame?.payload?.type ?? firstFrame?.event).toBe("hello-ok");
      expect(firstFrame?.payload?.snapshot?.presence?.map((entry) => entry.instanceId)).toContain(
        "joining-browser",
      );
      const helloPresence = firstFrame?.payload?.snapshot?.presence ?? [];
      if (selfOnly) {
        expect(helloPresence).toHaveLength(1);
        expect(helloPresence[0]?.user).toMatchObject({ id: expect.any(String) });
      } else {
        expect(helloPresence.map((entry) => entry.instanceId)).toContain("established-reader");
      }
      expect(presenceReasons(reader.frames, "joining-browser")).toContain("connect");
    });
  },
);

test.each(["accepted", "denied"] as const)(
  "keeps requests pipelined behind connect subject to %s authentication",
  async (authentication) => {
    await withGatewayServer(async ({ port }) => {
      const accepted = authentication === "accepted";
      const socket = await openWs(port, {
        origin,
        "x-forwarded-for": "203.0.113.50",
        "x-forwarded-proto": "https",
        ...(accepted ? { "x-forwarded-user": "pipeline@example.com" } : {}),
      });
      const frames: ObservedFrame[] = [];
      socket.on("message", (data) => frames.push(JSON.parse(rawDataToString(data))));
      const requests = [
        { type: "req", id: "pipeline-subscribe", method: "sessions.subscribe", params: {} },
        { type: "req", id: "pipeline-health", method: "health", params: {} },
      ];
      const replies = accepted
        ? requests.map((request) =>
            onceMessage(socket, (frame) => frame.type === "res" && frame.id === request.id),
          )
        : [];
      const closed = accepted ? undefined : once(socket, "close");
      const originalSend = Reflect.get(socket, "send");
      let pipelined = false;
      using sendSpy = vi.spyOn(socket, "send");
      sendSpy.mockImplementation(function (
        this: WebSocket,
        ...args: Parameters<WebSocket["send"]>
      ) {
        Reflect.apply(originalSend, this, args);
        if (typeof args[0] === "string" && JSON.parse(args[0]).method === "connect") {
          // Append at the actual connect write, after the helper has prepared device auth.
          expect(frames.some((frame) => frame.payload?.type === "hello-ok")).toBe(false);
          for (const request of requests) {
            Reflect.apply(originalSend, this, [JSON.stringify(request)]);
          }
          pipelined = true;
        }
      });

      const [result, responses] = await Promise.all([
        connectReq(socket, {
          skipDefaultAuth: true,
          prePairDevice: true,
          deviceIdentityPath: path.join(
            tempDirs.make("hello-pipeline-"),
            "client",
            "credentials.sqlite",
          ),
          client: CONTROL_UI_CLIENT,
          scopes: ["operator.read"],
          browserOrigin: origin,
        }),
        Promise.all(replies),
      ]);
      expect(pipelined).toBe(true);
      if (accepted) {
        expect(result).toMatchObject({ ok: true, payload: { type: "hello-ok" } });
        expect(frames.find((frame) => frame.type === "res")?.id).toBe(result.id);
        expect(responses).toMatchObject([
          { id: "pipeline-subscribe", ok: true, payload: { subscribed: true } },
          { id: "pipeline-health", ok: true, payload: { channels: expect.any(Object) } },
        ]);
      } else {
        expect(result).toMatchObject({
          ok: false,
          error: { code: "INVALID_REQUEST", details: { authReason: "trusted_proxy_user_missing" } },
        });
        expect((await closed)?.[0]).toBe(1008);
        expect(
          frames.filter((frame) => requests.some((request) => request.id === frame.id)),
        ).toEqual([]);
      }
    });
  },
);

test.each(["write-error", "closed-before-callback"] as const)(
  "does not publish connect presence after hello %s and retains disconnect cleanup",
  async (failure) => {
    const failedInstanceId = `failed-${failure}`;
    await withGatewayServer(async ({ port }) => {
      const reader = await openBrowser(port, "established-reader");
      const joining = await openBrowser(port, failedInstanceId);
      const publisher = await openBrowser(port, "presence-publisher");
      const pendingHello = createDeferred<() => void>();
      let failNextHello = true;
      expect((await reader.connect()).ok).toBe(true);
      const originalSend = Reflect.get(WebSocket.prototype, "send");
      using sendSpy = vi.spyOn(WebSocket.prototype, "send");
      sendSpy.mockImplementation(function (
        this: WebSocket,
        ...args: Parameters<WebSocket["send"]>
      ) {
        if (failNextHello && typeof args[0] === "string" && args[0].includes('"hello-ok"')) {
          failNextHello = false;
          const callback = args.findLast((arg) => typeof arg === "function");
          if (typeof callback !== "function") {
            throw new Error("hello delivery requires a callback");
          }
          pendingHello.resolve(() => {
            if (failure === "closed-before-callback") {
              this.close(1000, "test close before hello");
            }
            callback(failure === "write-error" ? new Error("test hello write failure") : undefined);
          });
          return;
        }
        Reflect.apply(originalSend, this, args);
      });
      const closed = once(joining.socket, "close");
      const disconnected = waitForPresence(
        reader.socket,
        (entry) => entry.instanceId === failedInstanceId && entry.reason === "disconnect",
      );
      await Promise.all([
        expect(joining.connect()).rejects.toThrow(/closed/),
        closed,
        disconnected,
        pendingHello.promise.then((failHello) =>
          Promise.all([
            waitForPresence(reader.socket, (entry) => entry.instanceId === "presence-publisher"),
            expect(publisher.connect()).resolves.toMatchObject({ ok: true }),
          ]).finally(failHello),
        ),
      ]);
      expect(failNextHello).toBe(false);
      const reasons = presenceReasons(reader.frames, failedInstanceId);
      expect(reasons).not.toContain("connect");
      expect(reasons).toContain("disconnect");
    });
  },
);
