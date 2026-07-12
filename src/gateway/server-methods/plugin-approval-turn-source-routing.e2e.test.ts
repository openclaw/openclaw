// Gateway e2e proof: turn-source routing fields change gateway response behavior.
//
// Without turn-source fields: plugin.approval.request expires immediately with
// {decision: null} because there is no approval client and no turn-source route.
//
// With turn-source fields for a routable channel ("tui" is always routable):
// the approval stays alive and returns {status: "accepted"} because
// hasApprovalTurnSourceRoute returns true.
//
// This test runs against a real gateway server with no Telegram required.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../config/config.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import { APPROVALS_SCOPE } from "../method-scopes.js";
import { startGatewayServer } from "../server.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  getFreeGatewayPort,
} from "../test-helpers.e2e.js";

const TEST_ENV_KEYS = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_URL",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PASSWORD",
  "OPENCLAW_GATEWAY_PORT",
];

describe("plugin.approval.request turn-source routing (real gateway)", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let tempHome: string;
  let server: Awaited<ReturnType<typeof startGatewayServer>>;
  let requester: Awaited<ReturnType<typeof connectGatewayClient>>;

  beforeAll(async () => {
    envSnapshot = captureEnv(TEST_ENV_KEYS);
    deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
    deleteTestEnvValue("OPENCLAW_GATEWAY_URL");
    deleteTestEnvValue("OPENCLAW_GATEWAY_TOKEN");
    deleteTestEnvValue("OPENCLAW_GATEWAY_PASSWORD");

    tempHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-plugin-approval-turn-source-e2e-"),
    );
    const stateDir = path.join(tempHome, ".openclaw");
    await fs.mkdir(stateDir, { recursive: true });
    setTestEnvValue("HOME", tempHome);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);

    const port = await getFreeGatewayPort();
    const token = "plugin-approval-turn-source-e2e-token";
    const url = `ws://127.0.0.1:${port}`;
    setTestEnvValue("OPENCLAW_GATEWAY_PORT", String(port));

    server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token },
      controlUiEnabled: false,
      sidecarStartup: "defer",
    });

    // No operator approval client; only a requester with APPROVALS_SCOPE.
    // This is the state that triggers the no-route expiry in the unfixed code.
    requester = await connectGatewayClient({
      url,
      token,
      clientDisplayName: "plugin-approval requester",
      scopes: [APPROVALS_SCOPE],
      timeoutMs: 60_000,
    });
  });

  afterAll(async () => {
    await disconnectGatewayClient(requester).catch(() => undefined);
    await server?.close();
    await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
    envSnapshot.restore();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    clearSessionStoreCacheForTest();
  });

  it("expires with decision:null when no turn-source route and no approval client", async () => {
    // This is the bug: without turn-source fields, the gateway expires the record
    // immediately (decision: null) because there is no delivery route.
    const result = await requester.request("plugin.approval.request", {
      pluginId: "test-plugin",
      title: "Confirm action",
      description: "Plugin wants to perform an action",
      twoPhase: true,
      timeoutMs: 10_000,
      // No turnSourceChannel/turnSourceTo/turnSourceAccountId/turnSourceThreadId
    });

    expect(result).toMatchObject({ decision: null });
    expect((result as { id?: string }).id).toMatch(/^plugin:/);
  });

  it("returns accepted when turn-source route is present (tui channel is always routable)", async () => {
    // With the fix: turn-source fields forwarded from HookContext to the gateway
    // call. hasApprovalTurnSourceRoute("tui") returns true, so the record stays alive.
    const result = await requester.request("plugin.approval.request", {
      pluginId: "test-plugin",
      title: "Confirm action",
      description: "Plugin wants to perform an action",
      twoPhase: true,
      timeoutMs: 10_000,
      turnSourceChannel: "tui",
      turnSourceTo: "main",
      turnSourceAccountId: "local",
    });

    expect(result).toMatchObject({ status: "accepted" });
    expect((result as { id?: string }).id).toMatch(/^plugin:/);
  });
});
