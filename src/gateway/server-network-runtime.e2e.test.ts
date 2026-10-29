import fs from "node:fs/promises";
import path from "node:path";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import {
  GATEWAY_TEST_ENV_KEYS,
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import { startGatewayServer } from "./server.js";
import { acquireGatewayE2ePortBlock, startClaimedGateway } from "./test-helpers.listener.js";

const proxyKeys = ["http_proxy", "https_proxy", "all_proxy", "no_proxy"];
const NETWORK_GATEWAY_ENV_KEYS = [
  ...GATEWAY_TEST_ENV_KEYS,
  ...proxyKeys,
  ...proxyKeys.map((key) => key.toUpperCase()),
] as const;

describe("gateway network runtime", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let tempHome: string;
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  const token = `network-token-${process.pid}-${process.env.VITEST_POOL_ID ?? "0"}`;
  beforeEach(async () => {
    resetGatewayTestState();
    envSnapshot = captureEnv([...NETWORK_GATEWAY_ENV_KEYS]);
    for (const key of NETWORK_GATEWAY_ENV_KEYS) {
      deleteTestEnvValue(key);
    }
    ({ tempHome } = await setupGatewayTempHome({
      prefix: "openclaw-gw-network-home-",
      minimalGateway: true,
    }));
    setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
  });

  afterEach(async () => {
    try {
      await server?.close({ reason: "gateway network test complete" });
    } finally {
      server = undefined;
      await removeGatewayTempHome(tempHome);
      envSnapshot.restore();
      resetGatewayTestState();
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
});
