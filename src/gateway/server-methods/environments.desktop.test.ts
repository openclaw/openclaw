import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { HostDesktopCredentialsRequiredError } from "../desktop/host-source-errors.js";
import { createHostDesktopService } from "../desktop/host-source.js";
import { NODE_DESKTOP_SERVICE_CONTEXT } from "../desktop/node-source-context.js";
import * as observeBridge from "../desktop/observe-bridge.js";
import {
  resolveDesktopObserveRequester,
  type DesktopObserveRequester,
} from "../desktop/observe-requester.js";
import { createDesktopSessionRegistry } from "../desktop/session-registry.js";
import type { GatewayClient } from "./client-types.js";
import { environmentsHandlers } from "./environments.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.restoreAllMocks();
});

function createRequesterClient(signal: AbortSignal): GatewayClient {
  return {
    connId: "desktop-requester",
    connectionSignal: signal,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: GATEWAY_CLIENT_IDS.CLI, version: "test", platform: "test", mode: "cli" },
    },
  };
}

async function invoke(
  method: "desktop.observe" | "worker.desktop.observe" | "desktop.release",
  params: unknown,
  context: object,
  client: GatewayClient | null = null,
  hasCurrentClientAuthority?: () => boolean,
) {
  const respond = vi.fn();
  await environmentsHandlers[method]?.({
    params,
    respond,
    context,
    client,
    hasCurrentClientAuthority,
  } as never);
  const call = respond.mock.calls.at(0);
  if (!call) {
    throw new Error("expected desktop handler response");
  }
  return call;
}

describe("desktop gateway methods", () => {
  it("releases only the requesting connection's unclaimed observation once", async () => {
    const controller = new AbortController();
    const client = createRequesterClient(controller.signal);
    let authorityCurrent = true;
    const requester = resolveDesktopObserveRequester({
      client,
      hasCurrentClientAuthority: () => authorityCurrent,
    });
    const onAbandon = vi.fn(async () => {});
    const { token } = observeBridge.mintDesktopObserverToken({
      sourceKey: "desktop-release",
      ownerEpoch: 1,
      control: true,
      attachment: { kind: "tcp", host: "127.0.0.1", port: 5900 },
      requester,
      onAbandon,
    });
    const params = { wsPath: `/desktop/observe?token=${token}` };
    try {
      const other = { ...client, connId: "another-desktop-requester" };
      expect((await invoke("desktop.release", params, {}, other))[1]).toEqual({ released: false });
      authorityCurrent = false;
      expect((await invoke("desktop.release", params, {}, client))[1]).toEqual({ released: false });
      expect(onAbandon).not.toHaveBeenCalled();
      authorityCurrent = true;
      expect((await invoke("desktop.release", params, {}, client))[1]).toEqual({ released: true });
      expect((await invoke("desktop.release", params, {}, client))[1]).toEqual({ released: false });
      expect(onAbandon).toHaveBeenCalledOnce();
    } finally {
      controller.abort();
    }
  });

  it.each([
    {
      source: "node",
      method: "desktop.observe",
      params: {
        source: { kind: "node", nodeId: "node-1" },
        credentials: { password: "memory-only-node-password" },
      },
    },
    {
      source: "environment",
      method: "desktop.observe",
      params: { source: { kind: "environment", environmentId: "worker:one" } },
    },
    {
      source: "worker alias",
      method: "worker.desktop.observe",
      params: { environmentId: "worker:one", control: true },
    },
  ] as const)(
    "binds $source observers to live requester authority",
    async ({ source, method, params }) => {
      const controller = new AbortController();
      const client = createRequesterClient(controller.signal);
      let authorityCurrent = true;
      const observe = vi.fn(
        async (request: { requester?: DesktopObserveRequester; control: boolean }) => ({
          transport: "rfb",
          wsPath: "/desktop/observe?token=fixed",
          expiresAtMs: 42,
          control: request.control,
        }),
      );
      const [ok, result] = await invoke(
        method,
        params,
        {
          [NODE_DESKTOP_SERVICE_CONTEXT]: { observe },
          workerEnvironmentService: { observeDesktop: observe },
        },
        client,
        () => authorityCurrent,
      );
      expect(ok).toBe(true);
      expect(result).toMatchObject({ control: source === "worker alias" });
      expect(result).not.toHaveProperty("vncPassword");
      if (source === "node") {
        expect(observe).toHaveBeenCalledWith(
          expect.objectContaining({
            nodeId: "node-1",
            credentials: { password: "memory-only-node-password" },
          }),
        );
      }
      const requester = observe.mock.calls[0]?.[0].requester;
      expect(requester).toMatchObject({ connId: client.connId, signal: controller.signal });
      expect(requester?.isCurrent()).toBe(true);
      client.invalidated = true;
      expect(controller.signal.aborted).toBe(false);
      expect(requester?.isCurrent()).toBe(false);
      client.invalidated = false;
      authorityCurrent = false;
      expect(requester?.isCurrent()).toBe(false);
      authorityCurrent = true;
      expect(requester?.isCurrent()).toBe(true);
      controller.abort();
      expect(requester?.isCurrent()).toBe(false);
    },
  );

  it("returns a host observer token and auth from a real loopback RFB server", async () => {
    const mint = vi.spyOn(observeBridge, "mintDesktopObserverToken");
    const controller = new AbortController();
    const client = createRequesterClient(controller.signal);
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.write(Buffer.from("RFB 003.008\n", "ascii"));
      socket.once("data", () => socket.write(Buffer.from([1, 2])));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected RFB address");
    }
    cleanups.push(
      async () =>
        await new Promise<void>((resolve) => {
          for (const socket of sockets) {
            socket.destroy();
          }
          server.close(() => resolve());
        }),
    );
    const registry = createDesktopSessionRegistry({ lingerMs: 10 });
    cleanups.push(async () => registry.stopAll());
    const config = { enabled: true, port: address.port };
    const [ok, result] = await invoke(
      "desktop.observe",
      { source: { kind: "host" }, control: true },
      {
        getRuntimeConfig: () => ({ desktop: { host: config } }),
        hostDesktopService: createHostDesktopService({ getConfig: () => config, registry }),
      },
      client,
    );
    expect(ok).toBe(true);
    expect(result).toMatchObject({
      transport: "rfb",
      control: true,
      auth: "vnc-password",
    });
    expect(result.wsPath).toMatch(/^\/desktop\/observe\?token=[a-f0-9]{48}$/u);
    const requester = mint.mock.calls[0]?.[0].requester;
    expect(requester?.signal?.aborted).toBe(false);
    expect(requester?.isCurrent()).toBe(true);
    client.invalidated = true;
    expect(requester?.isCurrent()).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  });

  it("reports ARD credentials as required and forwards an in-memory retry", async () => {
    const observe = vi.fn(
      async (params: { credentials?: { username?: string; password?: string } }) => {
        if (!params.credentials) {
          throw new HostDesktopCredentialsRequiredError();
        }
        return {
          transport: "rfb" as const,
          wsPath: "/desktop/observe?token=fixed",
          expiresAtMs: 42,
          control: false,
          auth: "ard-account" as const,
        };
      },
    );
    const context = {
      getRuntimeConfig: () => ({ desktop: { host: { enabled: true } } }),
      hostDesktopService: { observe },
    };
    const [firstOk, , firstError] = await invoke(
      "desktop.observe",
      { source: { kind: "host" } },
      context,
    );
    expect(firstOk).toBe(false);
    expect(firstError).toMatchObject({
      code: ErrorCodes.INVALID_REQUEST,
      details: {
        code: "DESKTOP_CREDENTIALS_REQUIRED",
        auth: "ard-account",
      },
    });

    const credentials = { username: "operator", password: "account-password" };
    const [retryOk, result] = await invoke(
      "desktop.observe",
      { source: { kind: "host" }, credentials },
      context,
    );
    expect(retryOk).toBe(true);
    expect(result).toMatchObject({ auth: "ard-account" });
    expect(result).not.toHaveProperty("vncPassword");
    expect(observe).toHaveBeenLastCalledWith({ control: false, credentials });
  });
});
