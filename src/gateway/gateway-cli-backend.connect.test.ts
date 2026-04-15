import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store.js";
import { captureEnv } from "../test-utils/env.js";
import {
  connectTestGatewayClient,
  ensurePairedTestGatewayClientIdentity,
  getFreeGatewayPort,
} from "./gateway-cli-backend.live-helpers.js";
import { startGatewayServer } from "./server.js";

const GATEWAY_CONNECT_TIMEOUT_MS = 90_000;

describe("gateway cli backend connect", () => {
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    clearSessionStoreCacheForTest();
  });

  it(
    "connects a same-process test gateway client in minimal mode",
    async () => {
      const envSnapshot = captureEnv([
        "HOME",
        "OPENCLAW_STATE_DIR",
        "OPENCLAW_CONFIG_PATH",
        "OPENCLAW_GATEWAY_TOKEN",
        "OPENCLAW_SKIP_CHANNELS",
        "OPENCLAW_SKIP_PROVIDERS",
        "OPENCLAW_SKIP_GMAIL_WATCHER",
        "OPENCLAW_SKIP_CRON",
        "OPENCLAW_SKIP_CANVAS_HOST",
        "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
        "OPENCLAW_BUNDLED_PLUGINS_DIR",
        "OPENCLAW_TEST_MINIMAL_GATEWAY",
      ]);

      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-connect-home-"));
      const configPath = path.join(tempHome, ".openclaw", "openclaw.json");
      const bundledPluginsDir = path.join(tempHome, "openclaw-test-no-bundled-extensions");
      const token = `test-${Date.now()}`;
      process.env.HOME = tempHome;
      process.env.OPENCLAW_STATE_DIR = path.join(tempHome, ".openclaw");
      process.env.OPENCLAW_CONFIG_PATH = configPath;
      process.env.OPENCLAW_GATEWAY_TOKEN = token;
      process.env.OPENCLAW_SKIP_CHANNELS = "1";
      process.env.OPENCLAW_SKIP_PROVIDERS = "1";
      process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
      process.env.OPENCLAW_SKIP_CRON = "1";
      process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
      process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER = "1";
      process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;
      process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "1";
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.mkdir(bundledPluginsDir, { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ gateway: { auth: { mode: "token", token } } }, null, 2)}\n`,
      );
      clearRuntimeConfigSnapshot();
      clearConfigCache();
      clearSessionStoreCacheForTest();

      const deviceIdentity = await ensurePairedTestGatewayClientIdentity();
      const port = await getFreeGatewayPort();
      const server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });
      let client: Awaited<ReturnType<typeof connectTestGatewayClient>> | undefined;

      try {
        client = await connectTestGatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token,
          deviceIdentity,
        });
        const health = await client.request("health", undefined, {
          timeoutMs: 5_000,
        });
        expect(health).toMatchObject({
          ok: true,
        });
      } finally {
        await client?.stopAndWait({ timeoutMs: 1_000 }).catch(() => {});
        await server.close({ reason: "gateway connect regression complete" });
        await fs.rm(tempHome, { recursive: true, force: true });
        envSnapshot.restore();
      }
    },
    GATEWAY_CONNECT_TIMEOUT_MS,
  );
});
