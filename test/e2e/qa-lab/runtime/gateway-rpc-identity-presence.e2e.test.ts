import { expect, it } from "vitest";
import { provisionDefaultProactiveJob } from "../../../../src/cron/default-proactive-job.js";
import { loadGatewayTestConfig } from "../../../../src/gateway/test-helpers.config-runtime.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import {
  getGatewayTestPort,
  installGatewayTestHooks,
  startTestGatewayServer,
} from "../../../../src/gateway/test-helpers.js";
import { loadOrCreateProcessDeviceIdentityAsync } from "../../../../src/infra/device-identity-async.js";
import { withTimeout } from "../../../../src/infra/fs-safe.js";

installGatewayTestHooks({ scope: "suite" });

const TOKEN = `rpc-identity-presence-${process.pid}`;
type ObserverEvent = {
  event?: string;
  payload?: unknown;
  stateVersion?: { presence?: number };
};
it("exposes stable identity, host information, presence broadcasts, and heartbeat controls", async () => {
  if (!process.env.OPENCLAW_STATE_DIR) {
    throw new Error("OPENCLAW_STATE_DIR is required");
  }
  await loadOrCreateProcessDeviceIdentityAsync();
  const proactiveJob = await provisionDefaultProactiveJob(loadGatewayTestConfig(), "main", {
    cadenceMs: 30 * 60 * 1000,
  });
  if (!proactiveJob) {
    throw new Error("Expected setup to provision the default proactive automation");
  }
  const port = await getGatewayTestPort();
  const server = await startTestGatewayServer(port, {
    bind: "loopback",
    auth: { mode: "token", token: TOKEN },
  });
  const clients: Awaited<ReturnType<typeof connectGatewayClient>>[] = [];
  const connect = async (options: Omit<Parameters<typeof connectGatewayClient>[0], "url">) => {
    const client = await connectGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: TOKEN,
      ...options,
    });
    clients.push(client);
    return client;
  };
  try {
    const writer = await connect({ clientDisplayName: "rpc-identity-presence-bootstrap" });
    let resolvePresenceEvent: ((event: ObserverEvent) => void) | undefined;
    const observer = await connect({
      clientDisplayName: "rpc-identity-presence-observer",
      deviceFamily: "observer",
      onEvent: (event) => {
        const presence = (event.payload as { presence?: Array<{ deviceId?: string }> } | undefined)
          ?.presence;
        if (
          event.event === "presence" &&
          Array.isArray(presence) &&
          presence.some((entry) => entry.deviceId === "rpc-catalog-device")
        ) {
          resolvePresenceEvent?.(event);
        }
      },
    });
    const writerIdentity = await writer.request("gateway.identity.get", {});
    const observerIdentity = await observer.request("gateway.identity.get", {});
    expect(observerIdentity).toEqual(writerIdentity);
    expect(writerIdentity).toEqual({
      deviceId: expect.any(String),
      publicKey: expect.any(String),
    });

    const systemInfo = await writer.request<{ cpuCount: number; memoryTotalBytes: number }>(
      "system.info",
      {},
    );
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

    expect(Array.isArray(await observer.request("system-presence", {}))).toBe(true);

    const presenceEvent = new Promise<ObserverEvent>((resolve) => {
      resolvePresenceEvent = resolve;
    });
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

    expect(await observer.request("system-presence", {})).toContainEqual(
      expect.objectContaining({
        deviceId: "rpc-catalog-device",
        host: "rpc-catalog-host",
        mode: "qa",
        reason: "catalog-proof",
      }),
    );

    const lastHeartbeat = await writer.request("last-heartbeat", {});
    expect(lastHeartbeat === null || typeof lastHeartbeat === "object").toBe(true);

    const setHeartbeats = async (enabled: boolean) => {
      expect(await writer.request("set-heartbeats", { enabled })).toMatchObject({
        enabled,
        ok: true,
      });
      expect(await writer.request("cron.get", { id: proactiveJob.id })).toMatchObject({
        id: proactiveJob.id,
        enabled,
      });
    };
    try {
      await setHeartbeats(false);
    } finally {
      await setHeartbeats(true);
    }
  } finally {
    for (const client of clients.toReversed()) {
      await disconnectGatewayClient(client).catch(() => undefined);
    }
    await server.close({ reason: "gateway RPC identity and presence proof complete" });
  }
});
