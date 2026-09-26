// Core Canvas Gateway route tests cover shipped host-disable switches.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCanvasNodeCapability } from "../canvas/constants.js";
import { createCanvasDocument } from "../canvas/documents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  buildPluginNodeCapabilityScopedHostUrl,
  mintPluginNodeCapabilityToken,
  refreshClientPluginNodeCapability,
  setClientPluginNodeCapability,
} from "./plugin-node-capability.js";
import { createGatewayHttpServer } from "./server-http.js";
import type { GatewayWsClient } from "./server/ws-types.js";

const resolvedAuth: ResolvedGatewayAuth = {
  mode: "token",
  token: "test-token",
  allowTailscale: false,
};
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function requestHostedDocument(params: {
  config: OpenClawConfig;
  skipHost?: string;
}): Promise<Response> {
  return await withHostedDocumentServer(
    params,
    async ({ document, origin }) =>
      await fetch(`${origin}${document.entryUrl}`, {
        headers: { authorization: "Bearer test-token", connection: "close" },
      }),
  );
}

type HostedDocumentContext = {
  clients: Set<GatewayWsClient>;
  document: Awaited<ReturnType<typeof createCanvasDocument>>;
  origin: string;
};

async function withHostedDocumentServer<T>(
  params: {
    config: OpenClawConfig;
    skipHost?: string;
  },
  run: (context: HostedDocumentContext) => Promise<T>,
): Promise<T> {
  const stateDir = await mkdtemp(path.join(tmpdir(), "openclaw-canvas-gateway-"));
  tempDirs.push(stateDir);
  const document = await createCanvasDocument(
    {
      id: "host-switch-test",
      kind: "html_bundle",
      entrypoint: { type: "html", value: "<html><body>hosted</body></html>" },
    },
    { stateDir },
  );
  const clients = new Set<GatewayWsClient>();

  return await withEnvAsync(
    {
      OPENCLAW_SKIP_CANVAS_HOST: params.skipHost,
      OPENCLAW_STATE_DIR: stateDir,
    },
    async () => {
      const server = createGatewayHttpServer({
        clients,
        controlUiEnabled: false,
        controlUiBasePath: "/__control__",
        openAiChatCompletionsEnabled: false,
        openResponsesEnabled: false,
        handleHooksRequest: async () => false,
        handlePluginRequest: async () => false,
        resolvePluginNodeCapabilityRoute: (pathContext) =>
          resolveCanvasNodeCapability(pathContext.candidates),
        resolvedAuth,
        getRuntimeConfig: () => params.config,
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      try {
        return await run({ clients, document, origin: `http://127.0.0.1:${port}` });
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );
}

function connectCanvasClient({ clients, document, origin }: HostedDocumentContext) {
  const client: GatewayWsClient = {
    socket: {} as GatewayWsClient["socket"],
    connect: {
      role: "node",
      client: { mode: "node" },
    } as GatewayWsClient["connect"],
    connId: "canvas-node",
    usesSharedGatewayAuth: false,
  };
  const surface = resolveCanvasNodeCapability([document.entryUrl]);
  if (!surface) {
    throw new Error(`expected Canvas capability surface for ${document.entryUrl}`);
  }
  const capability = mintPluginNodeCapabilityToken();
  const scopedUrl = buildPluginNodeCapabilityScopedHostUrl(origin, capability);
  if (!scopedUrl) {
    throw new Error("expected scoped Canvas host URL");
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
  return { client, capability, surface, scopedUrl };
}

async function expectUnauthorized(response: Response): Promise<void> {
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({
    error: { message: "Unauthorized", type: "unauthorized" },
  });
}

describe("core Canvas Gateway host switches", () => {
  it("serves core widget documents by default", async () => {
    const response = await requestHostedDocument({ config: {} });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("hosted");
  });

  it.each([
    {
      label: "plugins.entries.canvas.config.host.enabled=false",
      config: {
        plugins: { entries: { canvas: { config: { host: { enabled: false } } } } },
      },
    },
    { label: "OPENCLAW_SKIP_CANVAS_HOST", config: {}, skipHost: "1" },
  ])("does not register the core widget route for $label", async ({ config, skipHost }) => {
    const response = await requestHostedDocument({ config, skipHost });
    expect(response.status).toBe(404);
  });
});

describe("core Canvas Gateway capability authorization", () => {
  it("rejects an invalidated client's capability without extending its expiry", async () => {
    await withHostedDocumentServer({ config: {} }, async ({ clients, document, origin }) => {
      const { client, scopedUrl } = connectCanvasClient({ clients, document, origin });

      const activeResponse = await fetch(`${scopedUrl}${document.entryUrl}`);
      expect(activeResponse.status).toBe(200);
      expect(await activeResponse.text()).toContain("hosted");

      client.invalidated = true;
      const expiryBeforeRejectedRequest = client.pluginNodeCapabilities?.canvas?.expiresAtMs;
      await expectUnauthorized(await fetch(`${scopedUrl}${document.entryUrl}`));
      expect(client.pluginNodeCapabilities?.canvas?.expiresAtMs).toBe(expiryBeforeRejectedRequest);
    });
  });

  it("returns the production unauthorized response after the capability expires", async () => {
    await withHostedDocumentServer({ config: {} }, async ({ clients, document, origin }) => {
      const { client, capability, surface, scopedUrl } = connectCanvasClient({
        clients,
        document,
        origin,
      });
      expect((await fetch(`${scopedUrl}${document.entryUrl}`)).status).toBe(200);

      setClientPluginNodeCapability({
        client,
        surface,
        capability,
        expiresAtMs: Date.now() - 1,
      });

      await expectUnauthorized(await fetch(`${scopedUrl}${document.entryUrl}`));
    });
  });

  it("serves a rotated capability URL and rejects the previous URL", async () => {
    await withHostedDocumentServer({ config: {} }, async ({ clients, document, origin }) => {
      const {
        client,
        surface,
        scopedUrl: oldScopedUrl,
      } = connectCanvasClient({
        clients,
        document,
        origin,
      });
      expect((await fetch(`${oldScopedUrl}${document.entryUrl}`)).status).toBe(200);

      const refreshed = refreshClientPluginNodeCapability({ client, surface });
      if (!refreshed) {
        throw new Error("expected refreshed Canvas capability");
      }

      const newResponse = await fetch(`${refreshed.scopedUrl}${document.entryUrl}`);
      expect(newResponse.status).toBe(200);
      expect(await newResponse.text()).toContain("hosted");
      await expectUnauthorized(await fetch(`${oldScopedUrl}${document.entryUrl}`));
    });
  });
});
