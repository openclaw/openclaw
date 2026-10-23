import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { startGatewayServer } from "./server.js";
import { GATEWAY_STARTUP_MUTATED_ENV_KEYS } from "./test-helpers.env.js";
import { acquireGatewayE2ePortBlock, startClaimedGateway } from "./test-helpers.listener.js";

const proxyKeys = ["http_proxy", "https_proxy", "all_proxy", "no_proxy"];
const NETWORK_GATEWAY_ENV_KEYS = [
  "HOME",
  ...GATEWAY_STARTUP_MUTATED_ENV_KEYS,
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_TEST_MINIMAL_GATEWAY",
  ...proxyKeys,
  ...proxyKeys.map((key) => key.toUpperCase()),
] as const;

describe("gateway network runtime", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let tempHome: string;
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  const token = `network-token-${process.pid}-${process.env.VITEST_POOL_ID ?? "0"}`;
  const reset = () => {
    resetAgentEventsForTest({ preserveListeners: true });
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    clearSessionStoreCacheForTest();
  };

  beforeEach(async () => {
    reset();
    envSnapshot = captureEnv([...NETWORK_GATEWAY_ENV_KEYS]);
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-network-home-"));
    for (const key of NETWORK_GATEWAY_ENV_KEYS) {
      deleteTestEnvValue(key);
    }
    setTestEnvValue("HOME", tempHome);
    setTestEnvValue("OPENCLAW_STATE_DIR", path.join(tempHome, ".openclaw"));
    for (const key of NETWORK_GATEWAY_ENV_KEYS.filter(
      (candidate) =>
        candidate.startsWith("OPENCLAW_SKIP_") || candidate === "OPENCLAW_TEST_MINIMAL_GATEWAY",
    )) {
      setTestEnvValue(key, "1");
    }
    const bundledDir = path.join(tempHome, "empty-bundled-plugins");
    setTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledDir);
    await fs.mkdir(bundledDir, { recursive: true });
    setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
  });

  afterEach(async () => {
    try {
      await server?.close({ reason: "gateway network test complete" });
    } finally {
      server = undefined;
      await fs.rm(tempHome, { recursive: true, force: true });
      envSnapshot.restore();
      reset();
    }
  });

  async function writeConfig(gateway: OpenClawConfig["gateway"]) {
    const configPath = path.join(tempHome, ".openclaw", "openclaw.json");
    const raw = `${JSON.stringify({ gateway }, null, 2)}\n`;
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, raw, { mode: 0o600 });
    setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
    return { configPath, raw };
  }

  async function start(options: Parameters<typeof startGatewayServer>[1] = {}) {
    const claim = await acquireGatewayE2ePortBlock();
    server = await startClaimedGateway(claim, () =>
      startGatewayServer(claim.port, { controlUiEnabled: false, ...options }),
    );
  }

  it("bootstraps env proxy dispatching when the gateway starts directly", async () => {
    const originalDispatcher = getGlobalDispatcher();
    try {
      setGlobalDispatcher(new Agent());
      process.env.HTTPS_PROXY = "http://127.0.0.1:9";
      await writeConfig({ auth: { mode: "token", token } });
      await start({ bind: "loopback", auth: { mode: "token", token } });
      expect(getGlobalDispatcher().constructor.name).toBe("EnvHttpProxyAgent");
    } finally {
      await server?.close({ reason: "gateway proxy bootstrap test complete" });
      server = undefined;
      const dispatcherToClose = getGlobalDispatcher();
      setGlobalDispatcher(originalDispatcher);
      if (dispatcherToClose !== originalDispatcher) {
        await dispatcherToClose.close();
      }
    }
  });

  it.each(["lan", "loopback", "tailnet", "auto", "custom", undefined] as const)(
    "starts with persisted canonical bind %s without rewriting config",
    async (bind) => {
      const { configPath, raw } = await writeConfig({
        mode: "local",
        auth: { mode: "token", token },
        ...(bind ? { bind } : {}),
        ...(bind === "custom" ? { customBindHost: "127.0.0.1" } : {}),
      });
      await start();
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(raw);
    },
  );
});
