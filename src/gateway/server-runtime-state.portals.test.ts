import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { createGatewayRuntimeStateForTest } from "./test-helpers.server-runtime-state.js";

vi.mock("../infra/tailscale.js", () => ({ claimTailscaleServePort: vi.fn() }));

const runtimes: Array<Awaited<ReturnType<typeof createGatewayRuntimeStateForTest>>> = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.portalService.closeAll();
    await Promise.all(
      runtime.httpServers.map(
        (server) =>
          new Promise<void>((resolve) => {
            if (!server.listening) {
              resolve();
              return;
            }
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
    );
    runtime.wss.close();
  }
});

async function status(port: number, host: string, path: string) {
  return await new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode ?? 0));
    });
    req.once("error", reject);
    req.end();
  });
}

describe("Gateway portal ingress startup", () => {
  it("starts one dedicated loopback listener that cannot route Gateway endpoints", async () => {
    const runtime = await createGatewayRuntimeStateForTest(undefined, {
      cfg: {
        gateway: {
          publicOrigin: "https://control.example.net",
          portals: { ingress: { domain: "previews.example.net", port: 0 } },
        },
      },
      getReadiness: () => ({ ready: true, failing: [], uptimeMs: 1 }),
    });
    runtimes.push(runtime);
    const gatewayServers = new Set(runtime.httpServers);
    await runtime.startListening();
    expect(runtime.httpServers).toHaveLength(gatewayServers.size + 1);
    const listener = runtime.httpServers.find((server) => !gatewayServers.has(server));
    const address = listener?.address();
    expect(address).toMatchObject({ address: "127.0.0.1" });
    if (!address || typeof address === "string") {
      throw new Error("Expected dedicated portal listener");
    }
    expect(await status(address.port, "unknown.previews.example.net", "/ready")).toBe(404);
    const portal = await runtime.portalService.open({ targetPort: 3000 });
    expect(portal.listenPort).toBe(address.port);
    expect(await status(address.port, new URL(portal.url).hostname, "/ready")).toBe(401);
    expect(runtime.httpServers).toHaveLength(gatewayServers.size + 1);
    await runtime.portalService.closeAll();
    expect(listener?.listening).toBe(false);
    expect(runtime.httpServer.listening).toBe(true);
  });

  it("fails startup instead of reusing an occupied external ingress listener", async () => {
    await withServer(
      (_req, res) => res.end("unrelated listener"),
      async (url) => {
        const runtime = await createGatewayRuntimeStateForTest(undefined, {
          cfg: {
            gateway: {
              portals: {
                ingress: { domain: "previews.example.net", port: Number(new URL(url).port) },
              },
            },
          },
        });
        runtimes.push(runtime);
        await expect(runtime.startListening()).rejects.toThrow("portal ingress");
        expect(runtime.portalService.list()).toEqual([]);
        expect(await (await fetch(url)).text()).toBe("unrelated listener");
      },
    );
  });

  it("does not claim the live ingress port during updater canary validation", async () => {
    const runtime = await createGatewayRuntimeStateForTest(undefined, {
      updateCanary: true,
      cfg: { gateway: { portals: { ingress: { domain: "previews.example.net", port: 0 } } } },
    });
    runtimes.push(runtime);
    const gatewayServers = [...runtime.httpServers];
    await runtime.startListening();
    expect(runtime.httpServers).toEqual(gatewayServers);
  });
});
