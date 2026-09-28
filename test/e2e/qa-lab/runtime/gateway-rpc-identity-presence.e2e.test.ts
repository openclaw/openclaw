import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import { installGatewayTestHooks } from "../../../../src/gateway/test-helpers.js";
import { prepareDeviceAuthStore } from "../../../../src/infra/device-auth-store.js";
import { loadOrCreateProcessDeviceIdentityAsync } from "../../../../src/infra/device-identity-async.js";
import { withTimeout } from "../../../../src/infra/fs-safe.js";

installGatewayTestHooks({ scope: "suite" });

const TOKEN = `rpc-identity-presence-${process.pid}`;
let started: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
let observer: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
let stateDir = "";
type ObserverEvent = {
  event?: string;
  payload?: unknown;
  stateVersion?: { presence?: number };
};
let resolvePresenceEvent: ((event: ObserverEvent) => void) | undefined;

function nextCatalogPresenceEvent(): Promise<ObserverEvent> {
  if (resolvePresenceEvent) {
    throw new Error("presence event waiter is already armed");
  }
  return new Promise((resolve) => {
    resolvePresenceEvent = resolve;
  });
}

beforeAll(async () => {
  stateDir = process.env.OPENCLAW_STATE_DIR ?? "";
  if (!stateDir) {
    throw new Error("OPENCLAW_STATE_DIR is required");
  }
  await prepareDeviceAuthStore({});
  await loadOrCreateProcessDeviceIdentityAsync();
  started = await startGatewayWithClient({
    cfg: { gateway: { auth: { mode: "token", token: TOKEN } } },
    configPath: path.join(stateDir, "openclaw.json"),
    token: TOKEN,
    clientDisplayName: "rpc-identity-presence-bootstrap",
  });
  observer = await connectGatewayClient({
    url: `ws://127.0.0.1:${started.port}`,
    token: TOKEN,
    clientDisplayName: "rpc-identity-presence-observer",
    deviceFamily: "observer",
    onEvent: (event) => {
      if (
        resolvePresenceEvent &&
        event.event === "presence" &&
        Array.isArray((event.payload as { presence?: unknown } | undefined)?.presence) &&
        (event.payload as { presence: Array<{ deviceId?: string }> }).presence.some(
          (entry) => entry.deviceId === "rpc-catalog-device",
        )
      ) {
        const resolve = resolvePresenceEvent;
        resolvePresenceEvent = undefined;
        resolve(event);
      }
    },
  });
});

afterAll(async () => {
  if (!started) {
    return;
  }
  await (observer ? disconnectGatewayClient(observer).catch(() => undefined) : undefined);
  await disconnectGatewayClient(started.client).catch(() => undefined);
  await started.server.close({ reason: "gateway RPC identity and presence proof complete" });
});

describe("gateway RPC identity and presence", () => {
  it("exposes stable identity, host information, presence broadcasts, and heartbeat controls", async () => {
    if (!started || !observer) {
      throw new Error("Gateway clients did not start");
    }
    const writer = started.client;
    const writerIdentity = (await writer.request("gateway.identity.get", {})) as {
      deviceId: string;
      publicKey: string;
    };
    const observerIdentity = (await observer.request("gateway.identity.get", {})) as {
      deviceId: string;
      publicKey: string;
    };
    expect(observerIdentity).toEqual(writerIdentity);
    expect(writerIdentity).toEqual({
      deviceId: expect.any(String),
      publicKey: expect.any(String),
    });

    const systemInfo = (await writer.request("system.info", {})) as {
      arch: string;
      cpuCount: number;
      hostname: string;
      memoryTotalBytes: number;
      nodeVersion: string;
      platform: string;
      processInstanceId: string;
    };
    expect(systemInfo).toMatchObject({
      arch: expect.any(String),
      cpuCount: expect.any(Number),
      hostname: expect.any(String),
      memoryTotalBytes: expect.any(Number),
      nodeVersion: expect.any(String),
      platform: expect.any(String),
      processInstanceId: expect.any(String),
    });
    expect(systemInfo.cpuCount).toBeGreaterThan(0);
    expect(systemInfo.memoryTotalBytes).toBeGreaterThan(0);

    const before = await observer.request("system-presence", {});
    expect(Array.isArray(before)).toBe(true);

    const presenceEvent = nextCatalogPresenceEvent();
    const systemEvent = await writer.request("system-event", {
      text: "Node: rpc-catalog-host (127.0.0.2) · app 1.0.0 · last input 2s ago · mode qa · reason catalog-proof",
      deviceId: "rpc-catalog-device",
      instanceId: "rpc-catalog-instance",
      host: "rpc-catalog-host",
      ip: "127.0.0.2",
      mode: "qa",
      reason: "catalog-proof",
      version: "1.0.0",
    });
    expect(systemEvent).toMatchObject({ ok: true });
    await expect(
      withTimeout(presenceEvent, 5_000, "observer presence broadcast"),
    ).resolves.toMatchObject({
      event: "presence",
      stateVersion: { presence: expect.any(Number) },
    });

    const after = await observer.request("system-presence", {});
    expect(after).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deviceId: "rpc-catalog-device",
          host: "rpc-catalog-host",
          mode: "qa",
          reason: "catalog-proof",
        }),
      ]),
    );

    const lastHeartbeat = await writer.request("last-heartbeat", {});
    expect(lastHeartbeat === null || typeof lastHeartbeat === "object").toBe(true);

    try {
      expect(await writer.request("set-heartbeats", { enabled: false })).toMatchObject({
        enabled: false,
        ok: true,
      });
    } finally {
      expect(await writer.request("set-heartbeats", { enabled: true })).toMatchObject({
        enabled: true,
        ok: true,
      });
    }
  });
});
