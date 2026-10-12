import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { startGatewayServer } from "../server.js";
import { connectGatewayClient, disconnectGatewayClient } from "../test-helpers.e2e.js";
import { GATEWAY_STARTUP_MUTATED_ENV_KEYS } from "../test-helpers.env.js";
import { testState, writeSessionStore } from "../test-helpers.js";
import { acquireGatewayE2ePortBlock, startClaimedGateway } from "../test-helpers.listener.js";
import { getTalkHandoff } from "./handoff.js";
import { getUnifiedTalkSession } from "./session-registry.js";

const GATEWAY_E2E_TIMEOUT_MS = 90_000;
const ENV_KEYS = [
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
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
  "OPENCLAW_TEST_MINIMAL_GATEWAY",
];

describe("talk.session.close Gateway E2E", () => {
  it(
    "closes a live managed-room Talk session when talk.session.close receives a padded sessionId",
    { timeout: GATEWAY_E2E_TIMEOUT_MS },
    async () => {
      const envSnapshot = captureEnv(ENV_KEYS);
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-talk-close-trim-"));
      const stateDir = path.join(tempHome, ".openclaw");
      const bundledPluginsDir = path.join(tempHome, "empty-bundled-plugins");
      const token = `talk-session-close-trim-${process.pid}`;
      try {
        await fs.mkdir(bundledPluginsDir, { recursive: true });
        await fs.mkdir(stateDir, { recursive: true });
        setTestEnvValue("HOME", tempHome);
        setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
        deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
        setTestEnvValue("OPENCLAW_SKIP_CHANNELS", "1");
        setTestEnvValue("OPENCLAW_SKIP_GMAIL_WATCHER", "1");
        setTestEnvValue("OPENCLAW_SKIP_CRON", "1");
        setTestEnvValue("OPENCLAW_SKIP_CANVAS_HOST", "1");
        setTestEnvValue("OPENCLAW_SKIP_BROWSER_CONTROL_SERVER", "1");
        setTestEnvValue("OPENCLAW_SKIP_PROVIDERS", "1");
        setTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledPluginsDir);
        setTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
        setTestEnvValue("OPENCLAW_TEST_MINIMAL_GATEWAY", "1");
        testState.sessionStorePath = path.join(stateDir, "sessions.sqlite");
        await writeSessionStore({
          entries: {
            "agent:main:main": {
              sessionId: "talk-session-close-trim-session",
              updatedAt: Date.now(),
            },
          },
        });
        const claim = await acquireGatewayE2ePortBlock();
        const server = await startClaimedGateway(claim, () =>
          startGatewayServer(claim.port, {
            bind: "loopback",
            auth: { mode: "token", token },
            controlUiEnabled: false,
          }),
        );
        const client = await connectGatewayClient({
          url: `ws://127.0.0.1:${claim.port}`,
          token,
          scopes: [ADMIN_SCOPE],
          timeoutMs: 60_000,
        });
        try {
          const created = await client.request<{ sessionId?: string; handoffId?: string }>(
            "talk.session.create",
            { transport: "managed-room", sessionKey: "agent:main:main" },
          );
          const sessionId = created.sessionId;
          if (!sessionId) {
            throw new Error("talk.session.create did not return a sessionId");
          }
          expect(getUnifiedTalkSession(sessionId).kind).toBe("managed-room");
          expect(getTalkHandoff(created.handoffId ?? sessionId)).toBeDefined();

          const padded = ` ${sessionId} `;
          expect(padded).not.toBe(sessionId);
          await expect(
            client.request("talk.session.close", { sessionId: padded }),
          ).resolves.toEqual({
            ok: true,
          });
          expect(() => getUnifiedTalkSession(sessionId)).toThrow(/Unknown Talk session/);
          expect(getTalkHandoff(created.handoffId ?? sessionId)).toBeUndefined();
          await expect(client.request("talk.session.close", { sessionId })).rejects.toThrow(
            /Unknown Talk session/,
          );
          console.log(
            `[talk.session.close Gateway client E2E] created=true closed=true forgotten=true padded=${JSON.stringify(padded)} exact=${sessionId}`,
          );
        } finally {
          await disconnectGatewayClient(client);
          await server.close({ reason: "talk session close id trim complete" });
        }
      } finally {
        try {
          await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        } finally {
          envSnapshot.restore();
        }
      }
    },
  );
});
