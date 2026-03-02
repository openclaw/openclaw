/**
 * E2E test: token-authed localhost connections without device identity
 * retain their self-declared scopes after the scope-stripping fix.
 *
 * Before the fix, `clearUnboundScopes()` stripped ALL scopes from
 * connections without device identity, even trusted localhost+token ones.
 * This caused internal gateway-client calls (e.g. cron announce) to fail
 * with "missing scope: operator.write".
 *
 * IMPORTANT: Tests use `skipDeviceIdentity: true` to prevent GatewayClient
 * from auto-loading a device identity via `loadOrCreateDeviceIdentity()`.
 * Without this flag, the client would always send a device identity,
 * making `hasDeviceIdentity=true` on the server side and trivially
 * bypassing the scope-stripping path we intend to test.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { connectGatewayClient, getFreeGatewayPort } from "./test-helpers.e2e.js";

const TIMEOUT_MS = 15_000;

describe("localhost token-auth scope preservation", () => {
  let port: number;
  let server: Awaited<ReturnType<typeof import("./server.js").startGatewayServer>>;
  let envSnapshot: ReturnType<typeof captureEnv>;
  let tempHome: string;
  const token = `test-scope-${randomUUID()}`;

  beforeAll(async () => {
    envSnapshot = captureEnv([
      "HOME",
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_GATEWAY_TOKEN",
      "OPENCLAW_SKIP_CHANNELS",
      "OPENCLAW_SKIP_GMAIL_WATCHER",
      "OPENCLAW_SKIP_CRON",
      "OPENCLAW_SKIP_CANVAS_HOST",
      "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
    ]);

    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-scope-test-"));
    process.env.HOME = tempHome;
    process.env.OPENCLAW_SKIP_CHANNELS = "1";
    process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
    process.env.OPENCLAW_SKIP_CRON = "1";
    process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
    process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER = "1";
    process.env.OPENCLAW_GATEWAY_TOKEN = token;

    const configDir = path.join(tempHome, ".openclaw");
    await fs.mkdir(configDir, { recursive: true });
    const configPath = path.join(configDir, "openclaw.json");
    await fs.writeFile(configPath, JSON.stringify({ gateway: { auth: { token } } }, null, 2));
    process.env.OPENCLAW_CONFIG_PATH = configPath;

    port = await getFreeGatewayPort();
    const { startGatewayServer } = await import("./server.js");
    server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token },
      controlUiEnabled: false,
    });
  }, TIMEOUT_MS);

  afterAll(async () => {
    await server?.close();
    envSnapshot?.restore();
    if (tempHome) {
      await fs.rm(tempHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  it(
    "localhost + token + no device identity retains operator.write scope",
    async () => {
      // Connect from localhost with token auth, requesting operator.write,
      // but WITHOUT device identity. skipDeviceIdentity prevents the
      // GatewayClient constructor from auto-loading one from disk.
      // Before the fix, clearUnboundScopes() stripped ALL scopes from
      // connections without device identity, even trusted localhost+token.
      const client = await connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        scopes: ["operator.write"],
        skipDeviceIdentity: true,
        timeoutMs: 10_000,
        timeoutMessage: "connect timed out — scopes may have been rejected",
      });

      // Verify scopes are actually preserved by calling a method that
      // requires operator.read (health). operator.write satisfies
      // operator.read per authorizeOperatorScopesForMethod().
      // If scopes were stripped to [], this call would fail with
      // "missing scope: operator.read".
      const result = await client.request<{ ok: boolean }>("health");
      expect(result).toHaveProperty("ok", true);

      client.stop();
    },
    TIMEOUT_MS,
  );

  it(
    "localhost + token + no device identity retains operator.read scope",
    async () => {
      // Same scenario but with operator.read — verifies that read-only
      // scopes are also preserved for localhost token-auth connections.
      const client = await connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        scopes: ["operator.read"],
        skipDeviceIdentity: true,
        timeoutMs: 10_000,
      });

      const result = await client.request<{ ok: boolean }>("health");
      expect(result).toHaveProperty("ok", true);

      client.stop();
    },
    TIMEOUT_MS,
  );
});
