import { afterEach, describe, expect, it } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { resolveCanvasNodeCapability } from "../canvas/constants.js";
import { createCanvasDocument } from "../canvas/documents.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  buildPluginNodeCapabilityScopedHostUrl,
  mintPluginNodeCapabilityToken,
  refreshClientPluginNodeCapability,
  setClientPluginNodeCapability,
} from "./plugin-node-capability.js";
import { createGatewayHttpServer } from "./server-http.js";
import type { GatewayWsClient } from "./server/ws-types.js";

afterEach(clearRuntimeConfigSnapshot);

type HostedDocumentContext = {
  clients: Set<GatewayWsClient>;
  document: Awaited<ReturnType<typeof createCanvasDocument>>;
  origin: string;
};

async function withHostedDocumentServer<T>(
  params: { config: OpenClawConfig; skipHost?: string },
  run: (context: HostedDocumentContext) => Promise<T>,
): Promise<T> {
  return await withTempDir("openclaw-canvas-gateway-", async (stateDir) => {
    const document = await createCanvasDocument(
      { id: "host-switch-test", html: "<html><body>hosted</body></html>" },
      { stateDir },
    );
    const clients = new Set<GatewayWsClient>();
    return await withEnvAsync(
      { OPENCLAW_SKIP_CANVAS_HOST: params.skipHost, OPENCLAW_STATE_DIR: stateDir },
      async () => {
        setRuntimeConfigSnapshot(params.config);
        const server = createGatewayHttpServer({
          clients,
          controlUiEnabled: false,
          controlUiBasePath: "/__control__",
          handleHooksRequest: async () => false,
          handlePluginRequest: async () => false,
          resolvePluginNodeCapabilityRoute: (pathContext) =>
            resolveCanvasNodeCapability(pathContext.candidates),
          resolvedAuth: { mode: "token", token: "test-token", allowTailscale: false },
          getRuntimeConfig: () => params.config,
        });
        const origin = await listenLoopback(server);
        try {
          return await run({ clients, document, origin });
        } finally {
          await closeHttpServer(server);
        }
      },
    );
  });
}

function connectCanvasClient({ clients, document, origin }: HostedDocumentContext) {
  const client: GatewayWsClient = {
    socket: {} as GatewayWsClient["socket"],
    connect: { role: "node", client: { mode: "node" } } as GatewayWsClient["connect"],
    connId: "canvas-node",
    usesSharedGatewayAuth: false,
  };
  const surface = resolveCanvasNodeCapability([document.entryUrl]);
  const capability = mintPluginNodeCapabilityToken();
  const scopedUrl = buildPluginNodeCapabilityScopedHostUrl(origin, capability);
  if (!surface || !scopedUrl) {
    throw new Error(`expected Canvas capability surface and URL for ${document.entryUrl}`);
  }
  client.pluginSurfaceUrls = { canvas: scopedUrl };
  client.pluginNodeCapabilitySurfaces = { canvas: surface };
  setClientPluginNodeCapability({
    client,
    surface,
    capability,
    expiresAtMs: Date.now() + 60_000,
  });
  clients.add(client);
  return { client, capability, surface, url: `${scopedUrl}${document.entryUrl}` };
}

async function withCanvasClient(
  run: (context: ReturnType<typeof connectCanvasClient> & { entryUrl: string }) => Promise<void>,
) {
  await withHostedDocumentServer({ config: {} }, async (context) => {
    await run({ ...connectCanvasClient(context), entryUrl: context.document.entryUrl });
  });
}

async function expectHosted(url: string) {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("hosted");
}

async function expectUnauthorized(response: Response): Promise<void> {
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({
    error: { message: "Unauthorized", type: "unauthorized" },
  });
}

describe("core Canvas Gateway", () => {
  it.each([
    {
      label: "plugins.entries.canvas.config.host.enabled=false",
      config: { plugins: { entries: { canvas: { config: { host: { enabled: false } } } } } },
    },
    { label: "OPENCLAW_SKIP_CANVAS_HOST", config: {}, skipHost: "1" },
  ])("does not register the core widget route for $label", async ({ config, skipHost }) => {
    await withHostedDocumentServer({ config, skipHost }, async ({ origin, document }) => {
      const response = await fetch(`${origin}${document.entryUrl}`, {
        headers: { authorization: "Bearer test-token", connection: "close" },
      });
      expect(response.status).toBe(404);
    });
  });
  it("rejects an invalidated client's capability without extending its expiry", async () => {
    await withCanvasClient(async ({ client, url }) => {
      await expectHosted(url);
      client.invalidated = true;
      const expiryBeforeRejectedRequest = client.pluginNodeCapabilities?.canvas?.expiresAtMs;
      await expectUnauthorized(await fetch(url));
      expect(client.pluginNodeCapabilities?.canvas?.expiresAtMs).toBe(expiryBeforeRejectedRequest);
    });
  });

  it("returns the production unauthorized response after the capability expires", async () => {
    await withCanvasClient(async ({ client, capability, surface, url }) => {
      expect((await fetch(url)).status).toBe(200);
      setClientPluginNodeCapability({
        client,
        surface,
        capability,
        expiresAtMs: Date.now() - 1,
      });
      await expectUnauthorized(await fetch(url));
    });
  });

  it("serves a rotated capability URL and rejects the previous URL", async () => {
    await withCanvasClient(async ({ client, surface, url, entryUrl }) => {
      expect((await fetch(url)).status).toBe(200);
      const refreshed = refreshClientPluginNodeCapability({ client, surface });
      if (!refreshed) {
        throw new Error("expected refreshed Canvas capability");
      }
      await expectHosted(`${refreshed.scopedUrl}${entryUrl}`);
      await expectUnauthorized(await fetch(url));
    });
  });
});
