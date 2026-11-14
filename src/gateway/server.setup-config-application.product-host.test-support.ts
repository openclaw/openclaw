import assert from "node:assert/strict";
import { runGatewayLoop } from "../cli/gateway-cli/run-loop.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import { detectGatewayRespawnSupervisorIdentity } from "../infra/supervisor-markers.js";
import { createDeferredCore } from "../shared/deferred.js";
import { captureEnv } from "../test-utils/env.js";
import type { GatewayHostLifecycle } from "./server-public.js";
import { startGatewayServer } from "./server.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";
import { GATEWAY_STARTUP_MUTATED_ENV_KEYS } from "./test-helpers.env.js";
import { acquireGatewayE2ePortBlock } from "./test-helpers.listener.js";

/** A real foreground owner inside the already prebound, task-owned product child. */
export async function startSetupProductGateway(configPath: string) {
  assert(process.env.OPENCLAW_TEST_PRIVATE_HANDOFF_PATH, "Requires the owned product child");
  assert.equal(detectGatewayRespawnSupervisorIdentity(), null, "Must not control a system service");
  const env = captureEnv([...GATEWAY_STARTUP_MUTATED_ENV_KEYS, "OPENCLAW_CONFIG_PATH"]);
  const previousExitCode = process.exitCode;
  const claim = await acquireGatewayE2ePortBlock();
  const ready = createDeferredCore<Awaited<ReturnType<typeof startGatewayServer>>>();
  let host: GatewayHostLifecycle | undefined;
  let starts = 0;
  let loopSettled = false;
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearSessionStoreCacheForTest();
  // Keep the port claim until the whole loop joins, including any recovery iteration.
  const loop = runGatewayLoop({
    ownsProcessLifecycle: true,
    lockPort: claim.port,
    start: async (options = {}) => {
      const { requestHotReloadRecovery, ...startupOptions } = options;
      host = startupOptions.hostLifecycle;
      const server = await startGatewayServer(claim.port, {
        ...startupOptions,
        bind: "loopback",
        controlUiEnabled: false,
        auth: { mode: "token", token: "setup-proof-token" },
        hotReloadRecovery: requestHotReloadRecovery,
      });
      starts++;
      ready.resolve(server);
      return server;
    },
  });
  void loop.then(
    (code) => {
      loopSettled = true;
      if (starts === 0) {
        ready.reject(new Error(`Gateway owner exited before startup: ${code}`));
      }
    },
    (error: unknown) => {
      loopSettled = true;
      ready.reject(error);
    },
  );
  let client: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
  const stop = async () => {
    if (client) {
      await disconnectGatewayClient(client);
    }
    if (host && !loopSettled) {
      const result = await host.request("stop", () => {});
      if (!result.ok) {
        throw new Error(result.error);
      }
    }
    assert.equal(await loop, 0, "The real Gateway owner must complete clean shutdown");
    await claim.release();
    env.restore();
    process.exitCode = previousExitCode;
  };
  try {
    const server = await ready.promise;
    await server.startupSettled;
    client = await connectGatewayClient({
      url: `ws://127.0.0.1:${claim.port}`,
      token: "setup-proof-token",
      scopes: ["operator.admin"],
    });
    return {
      client,
      stop,
      get starts() {
        return starts;
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
