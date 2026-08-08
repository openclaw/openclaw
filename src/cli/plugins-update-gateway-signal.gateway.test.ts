// Exact-head proof: plugins.refresh targets configured port, not OPENCLAW_GATEWAY_PORT.
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { resolveGatewayPort } from "../config/paths.js";
import { callGateway } from "../gateway/call.js";
import {
  connectOk,
  installGatewayTestHooks,
  startServerWithClient,
} from "../gateway/test-helpers.js";
import { notifyGatewayPluginMetadataChanged } from "./plugins-update-gateway-signal.js";

installGatewayTestHooks({ scope: "suite" });

describe("notifyGatewayPluginMetadataChanged live gateway", () => {
  let started: Awaited<ReturnType<typeof startServerWithClient>> | undefined;
  const token = "proof-plugins-refresh-port-token";

  beforeAll(async () => {
    started = await startServerWithClient(token);
    await connectOk(started.ws);
  }, 120_000);

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (started) {
      started.ws.close();
      await started.server.close().catch(() => undefined);
      started.envSnapshot.restore();
    }
  });

  test("after-fix plugins.refresh uses configured port when OPENCLAW_GATEWAY_PORT differs", async () => {
    expect(started).toBeDefined();
    const { port } = started!;
    const decoyPort = port === 62_000 ? 62_001 : 62_000;
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", String(decoyPort));

    const config = {
      gateway: {
        port,
        auth: { mode: "token" as const, token },
      },
    };

    const envResolved = resolveGatewayPort(config);
    const configuredResolved = resolveGatewayPort(config, {});
    expect(envResolved).toBe(decoyPort);
    expect(configuredResolved).toBe(port);

    // Contrast: pointing at the env/decoy port must not reach this Gateway.
    await expect(
      callGateway({
        config,
        method: "plugins.refresh",
        params: {},
        timeoutMs: 1_000,
        localPortOverride: envResolved,
        ignoreEnvUrlOverride: true,
        requiredMethods: ["plugins.refresh"],
        scopes: ["operator.admin"],
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
        token,
      }),
    ).rejects.toThrow();

    const ok = await notifyGatewayPluginMetadataChanged(config);
    console.log(
      [
        "----- plugins-refresh-configured-port-vs-env -----",
        `gateway_listen_port=${port}`,
        `OPENCLAW_GATEWAY_PORT=${decoyPort}`,
        `resolveGatewayPort(config)=${envResolved}`,
        `resolveGatewayPort(config, {})=${configuredResolved}`,
        `decoy_port_call=rejected`,
        `notifyGatewayPluginMetadataChanged=${ok}`,
      ].join("\n"),
    );
    expect(ok).toBe(true);
  }, 60_000);
});
