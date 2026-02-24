import fs from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { getChannelPlugin } from "../channels/plugins/index.js";
import type { ChannelOutboundAdapter } from "../channels/plugins/types.js";
import { clearConfigCache } from "../config/config.js";
import { resolveCanvasHostUrl } from "../infra/canvas-host-url.js";
import { GatewayLockError } from "../infra/gateway-lock.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { createOutboundTestPlugin } from "../test-utils/channel-plugins.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createTempHomeEnv } from "../test-utils/temp-home.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { createRegistry } from "./server.e2e-registry-helpers.js";
import {
  connectOk,
  getFreePort,
  installGatewayTestHooks,
  occupyPort,
  onceMessage,
  piSdkMock,
  rpcReq,
  startConnectedServerWithClient,
  startGatewayServer,
  startServerWithClient,
  testState,
  testTailnetIPv4,
  trackConnectChallengeNonce,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let server: Awaited<ReturnType<typeof startServerWithClient>>["server"];
let ws: WebSocket;
let port: number;

afterAll(async () => {
  ws.close();
  await server.close();
});

beforeAll(async () => {
  const started = await startConnectedServerWithClient();
  server = started.server;
  ws = started.ws;
  port = started.port;
});

const whatsappOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async ({ deps, to, text }) => {
    if (!deps?.sendWhatsApp) {
      throw new Error("Missing sendWhatsApp dep");
    }
    return { channel: "whatsapp", ...(await deps.sendWhatsApp(to, text, { verbose: false })) };
  },
  sendMedia: async ({ deps, to, text, mediaUrl }) => {
    if (!deps?.sendWhatsApp) {
      throw new Error("Missing sendWhatsApp dep");
    }
    return {
      channel: "whatsapp",
      ...(await deps.sendWhatsApp(to, text, { verbose: false, mediaUrl })),
    };
  },
};

const whatsappPlugin = createOutboundTestPlugin({
  id: "whatsapp",
  outbound: whatsappOutbound,
  label: "WhatsApp",
});

const whatsappRegistry = createRegistry([
  {
    pluginId: "whatsapp",
    source: "test",
    plugin: whatsappPlugin,
  },
]);
const emptyRegistry = createRegistry([]);

type ModelCatalogRpcEntry = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
};

type PiCatalogFixtureEntry = {
  id: string;
  provider: string;
  name?: string;
  contextWindow?: number;
};

const buildPiCatalogFixture = (): PiCatalogFixtureEntry[] => [
  { id: "gpt-test-z", provider: "openai", contextWindow: 0 },
  {
    id: "gpt-test-a",
    name: "A-Model",
    provider: "openai",
    contextWindow: 8000,
  },
  {
    id: "claude-test-b",
    name: "B-Model",
    provider: "anthropic",
    contextWindow: 1000,
  },
  {
    id: "claude-test-a",
    name: "A-Model",
    provider: "anthropic",
    contextWindow: 200_000,
  },
];

const expectedSortedCatalog = (): ModelCatalogRpcEntry[] => [
  {
    id: "claude-test-a",
    name: "A-Model",
    provider: "anthropic",
    contextWindow: 200_000,
  },
  {
    id: "claude-test-b",
    name: "B-Model",
    provider: "anthropic",
    contextWindow: 1000,
  },
  {
    id: "gpt-test-a",
    name: "A-Model",
    provider: "openai",
    contextWindow: 8000,
  },
  {
    id: "gpt-test-z",
    name: "gpt-test-z",
    provider: "openai",
  },
];

describe("gateway server models + voicewake", () => {
  const listModels = async () => rpcReq<{ models: ModelCatalogRpcEntry[] }>(ws, "models.list");

  const seedPiCatalog = () => {
    piSdkMock.enabled = true;
    piSdkMock.models = buildPiCatalogFixture();
  };

  const withModelsConfig = async <T>(config: unknown, run: () => Promise<T>): Promise<T> => {
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      throw new Error("Missing OPENCLAW_CONFIG_PATH");
    }
    let previousConfig: string | undefined;
    try {
      previousConfig = await fs.readFile(configPath, "utf-8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") {
        throw err;
      }
    }

    try {
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
      clearConfigCache();
      return await run();
    } finally {
      if (previousConfig === undefined) {
        await fs.rm(configPath, { force: true });
      } else {
        await fs.writeFile(configPath, previousConfig, "utf-8");
      }
      clearConfigCache();
    }
  };

  const withTempHome = async <T>(fn: (homeDir: string) => Promise<T>): Promise<T> => {
    const tempHome = await createTempHomeEnv("openclaw-home-");
    try {
      return await fn(tempHome.home);
    } finally {
      await tempHome.restore();
    }
  };

  test(
    "voicewake.get returns defaults and voicewake.set broadcasts",
    { timeout: 20_000 },
    async () => {
      await withTempHome(async (homeDir) => {
        const initial = await rpcReq<{ triggers: string[] }>(ws, "voicewake.get");
        expect(initial.ok).toBe(true);
        expect(initial.payload?.triggers).toEqual(["openclaw", "claude", "computer"]);

        const changedP = onceMessage(
          ws,
          (o) => o.type === "event" && o.event === "voicewake.changed",
        );

        const setRes = await rpcReq<{ triggers: string[] }>(ws, "voicewake.set", {
          triggers: ["  hi  ", "", "there"],
        });
        expect(setRes.ok).toBe(true);
        expect(setRes.payload?.triggers).toEqual(["hi", "there"]);

        const changed = (await changedP) as { event?: string; payload?: unknown };
        expect(changed.event).toBe("voicewake.changed");
        expect((changed.payload as { triggers?: unknown } | undefined)?.triggers).toEqual([
          "hi",
          "there",
        ]);

        const after = await rpcReq<{ triggers: string[] }>(ws, "voicewake.get");
        expect(after.ok).toBe(true);
        expect(after.payload?.triggers).toEqual(["hi", "there"]);

        const onDisk = JSON.parse(
          await fs.readFile(path.join(homeDir, ".openclaw", "settings", "voicewake.json"), "utf8"),
        ) as { triggers?: unknown; updatedAtMs?: unknown };
        expect(onDisk.triggers).toEqual(["hi", "there"]);
        expect(typeof onDisk.updatedAtMs).toBe("number");
      });
    },
  );

  test("pushes voicewake.changed to nodes on connect and on updates", async () => {
    await withTempHome(async () => {
      const nodeWs = new WebSocket(`ws://127.0.0.1:${port}`);
      trackConnectChallengeNonce(nodeWs);
      await new Promise<void>((resolve) => nodeWs.once("open", resolve));
      const firstEventP = onceMessage(
        nodeWs,
        (o) => o.type === "event" && o.event === "voicewake.changed",
      );
      await connectOk(nodeWs, {
        role: "node",
        client: {
          id: GATEWAY_CLIENT_NAMES.NODE_HOST,
          version: "1.0.0",
          platform: "ios",
          mode: GATEWAY_CLIENT_MODES.NODE,
        },
      });

      const first = (await firstEventP) as { event?: string; payload?: unknown };
      expect(first.event).toBe("voicewake.changed");
      expect((first.payload as { triggers?: unknown } | undefined)?.triggers).toEqual([
        "openclaw",
        "claude",
        "computer",
      ]);

      const broadcastP = onceMessage(
        nodeWs,
        (o) => o.type === "event" && o.event === "voicewake.changed",
      );
      const setRes = await rpcReq<{ triggers: string[] }>(ws, "voicewake.set", {
        triggers: ["openclaw", "computer"],
      });
      expect(setRes.ok).toBe(true);

      const broadcast = (await broadcastP) as { event?: string; payload?: unknown };
      expect(broadcast.event).toBe("voicewake.changed");
      expect((broadcast.payload as { triggers?: unknown } | undefined)?.triggers).toEqual([
        "openclaw",
        "computer",
      ]);

      nodeWs.close();
    });
  });

  test("models.list returns model catalog", async () => {
    seedPiCatalog();

    const res1 = await listModels();
    const res2 = await listModels();

    expect(res1.ok).toBe(true);
    expect(res2.ok).toBe(true);

    const models = res1.payload?.models ?? [];
    expect(models).toEqual(expectedSortedCatalog());

    expect(piSdkMock.discoverCalls).toBe(1);
  });

  test("models.list filters to allowlisted configured models by default", async () => {
    await withModelsConfig(
      {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-test-z" },
            models: {
              "openai/gpt-test-z": {},
              "anthropic/claude-test-a": {},
            },
          },
        },
      },
      async () => {
        seedPiCatalog();
        const res = await listModels();

        expect(res.ok).toBe(true);
        expect(res.payload?.models).toEqual([
          {
            id: "claude-test-a",
            name: "A-Model",
            provider: "anthropic",
            contextWindow: 200_000,
          },
          {
            id: "gpt-test-z",
            name: "gpt-test-z",
            provider: "openai",
          },
        ]);
      },
    );
  });

  test("models.list falls back to full catalog when allowlist has no catalog match", async () => {
    await withModelsConfig(
      {
        agents: {
          defaults: {
            model: { primary: "openai/not-in-catalog" },
            models: {
              "openai/not-in-catalog": {},
            },
          },
        },
      },
      async () => {
        seedPiCatalog();
        const res = await listModels();

        expect(res.ok).toBe(true);
        expect(res.payload?.models).toEqual(expectedSortedCatalog());
      },
    );
  });

  test("models.list rejects unknown params", async () => {
    piSdkMock.enabled = true;
    piSdkMock.models = [{ id: "gpt-test-a", name: "A", provider: "openai" }];

    const res = await rpcReq(ws, "models.list", { extra: true });
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toMatch(/invalid models\.list params/i);
  });
});

describe("gateway server misc", () => {
  test("hello-ok advertises the gateway port for canvas host", async () => {
    await withEnvAsync({ OPENCLAW_GATEWAY_TOKEN: "secret" }, async () => {
      testTailnetIPv4.value = "100.64.0.1";
      testState.gatewayBind = "lan";
      const canvasPort = await getFreePort();
      testState.canvasHostPort = canvasPort;
      await withEnvAsync({ OPENCLAW_CANVAS_HOST_PORT: String(canvasPort) }, async () => {
        const testPort = await getFreePort();
        const canvasHostUrl = resolveCanvasHostUrl({
          canvasPort,
          requestHost: `100.64.0.1:${testPort}`,
          localAddress: "127.0.0.1",
        });
        expect(canvasHostUrl).toBe(`http://100.64.0.1:${canvasPort}`);
      });
    });
  });

  test("send dedupes by idempotencyKey", { timeout: 15_000 }, async () => {
    const prevRegistry = getActivePluginRegistry() ?? emptyRegistry;
    try {
      setActivePluginRegistry(whatsappRegistry);
      expect(getChannelPlugin("whatsapp")).toBeDefined();

      const idem = "same-key";
      const res1P = onceMessage(ws, (o) => o.type === "res" && o.id === "a1");
      const res2P = onceMessage(ws, (o) => o.type === "res" && o.id === "a2");
      const sendReq = (id: string) =>
        ws.send(
          JSON.stringify({
            type: "req",
            id,
            method: "send",
            params: {
              to: "+15550000000",
              channel: "whatsapp",
              message: "hi",
              idempotencyKey: idem,
            },
          }),
        );
      sendReq("a1");
      sendReq("a2");

      const res1 = await res1P;
      const res2 = await res2P;
      expect(res1.ok).toBe(true);
      expect(res2.ok).toBe(true);
      expect(res1.payload).toEqual(res2.payload);
    } finally {
      setActivePluginRegistry(prevRegistry);
    }
  });

  test("auto-enables configured channel plugins on startup", async () => {
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      throw new Error("Missing OPENCLAW_CONFIG_PATH");
    }
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          channels: {
            discord: {
              token: "token-123",
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const autoPort = await getFreePort();
    const autoServer = await startGatewayServer(autoPort);
    await autoServer.close();

    const updated = JSON.parse(await fs.readFile(configPath, "utf-8")) as Record<string, unknown>;
    const channels = updated.channels as Record<string, unknown> | undefined;
    const discord = channels?.discord as Record<string, unknown> | undefined;
    expect(discord).toMatchObject({
      token: "token-123",
      enabled: true,
    });
  });

  test("refuses to start when port already bound", async () => {
    const { server: blocker, port: blockedPort } = await occupyPort();
    const startup = startGatewayServer(blockedPort);
    await expect(startup).rejects.toBeInstanceOf(GatewayLockError);
    await expect(startup).rejects.toThrow(/already listening/i);
    blocker.close();
  });

  test("releases port after close", async () => {
    const releasePort = await getFreePort();
    const releaseServer = await startGatewayServer(releasePort);
    await releaseServer.close();

    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(releasePort, "127.0.0.1", () => resolve());
    });
    await new Promise<void>((resolve, reject) =>
      probe.close((err) => (err ? reject(err) : resolve())),
    );
  });
});
