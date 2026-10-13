import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import { expect } from "vitest";
import { stateDirGatewayFixtureEntrypoint } from "../../src/cli/cli-entrypoint.test-support.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import { withEnvAsync } from "../../src/test-utils/env.js";
import { createOpenClawTestInstance } from "./openclaw-test-instance.js";
import { runQaGatewayFixture } from "./qa-gateway-cleanup.js";

export async function withSetupHealthGateway(
  flow: string,
  signal: AbortSignal,
  run: (gateway: {
    config: OpenClawConfig;
    port: number;
    pid: number;
    password: string;
  }) => Promise<void>,
): Promise<void> {
  const password = "synthetic-setup-local-password"; // pragma: allowlist secret
  const config: OpenClawConfig = {
    gateway: {
      mode: "local",
      bind: "loopback",
      auth: {
        mode: "trusted-proxy",
        token: undefined,
        password,
        trustedProxy: { userHeader: "x-forwarded-user" },
      },
      trustedProxies: ["10.0.0.5"],
    },
    hooks: { enabled: false },
  };
  const entrypoint = resolveRuntimeWorkerUrl(stateDirGatewayFixtureEntrypoint);
  const gateway = await createOpenClawTestInstance({
    name: `setup-health-${flow}`,
    entrypoint: [
      ...resolveRuntimeWorkerArgv(entrypoint),
      "--minimal-real-gateway",
      "--configured-auth",
    ],
    gatewayCommandPrefix: [process.execPath],
    config: { ...config },
    signal,
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  });
  let unrelatedConnections = 0;
  const unrelated = net.createServer((socket) => {
    unrelatedConnections += 1;
    socket.destroy();
  });
  await runQaGatewayFixture(
    async () => {
      unrelated.listen(0, "127.0.0.1");
      await once(unrelated, "listening");
      const unrelatedPort = (unrelated.address() as net.AddressInfo).port;
      const requestLog = gateway.state.path("gateway-requests.jsonl");
      await fs.writeFile(requestLog, "");
      gateway.env.OPENCLAW_GATEWAY_PORT = String(gateway.port);
      gateway.env.OPENCLAW_TEST_GATEWAY_REQUEST_LOG = requestLog;
      await gateway.startGateway();
      gateway.state.applyEnv();
      config.gateway!.port = gateway.port;
      expect(gateway.child?.pid).toBeTypeOf("number");

      for (const override of ["url-and-port", "port-only"]) {
        await fs.writeFile(requestLog, "");
        await withEnvAsync(
          {
            OPENCLAW_GATEWAY_URL:
              override === "url-and-port" ? `ws://127.0.0.1:${unrelatedPort}` : undefined,
            OPENCLAW_GATEWAY_PORT: String(unrelatedPort),
          },
          () => run({ config, port: gateway.port, pid: gateway.child!.pid!, password }),
        );
        const requests = (await fs.readFile(requestLog, "utf8")).split("\n").filter(Boolean);
        const healthRequests = requests.filter(
          (line) => JSON.parse(line).method === "health",
        ).length;
        expect(healthRequests).toBeGreaterThan(0);
        expect(unrelatedConnections).toBe(0);
        console.info(
          JSON.stringify({
            proof: "setup-health-target",
            flow,
            override,
            healthRequests,
            unrelatedConnections,
          }),
        );
      }
    },
    () => gateway.cleanup(),
    () =>
      new Promise<void>((resolve, reject) => {
        if (!unrelated.listening) {
          resolve();
          return;
        }
        unrelated.close((error) => (error ? reject(error) : resolve()));
      }),
  );
}
