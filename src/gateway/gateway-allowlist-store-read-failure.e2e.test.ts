import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

type ChatFinalPayload = {
  runId?: string;
  state?: string;
  message?: unknown;
};

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Gateway allowlist command", () => {
  it("surfaces a pairing-store read failure through chat.send", { timeout: 90_000 }, async () => {
    const home = tempDirs.make("openclaw-allowlist-gateway-");
    const stateDir = path.join(home, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const workspaceDir = path.join(home, "workspace");
    const env = {
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(process.cwd(), "extensions"),
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
    };
    const envSnapshot = captureEnv(Object.keys(env));
    const originalRead = stateReads.executeExistingOpenClawStateRead;
    const read = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
    let faultArmed = false;
    let faultObserved = false;
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    try {
      await Promise.all([
        fs.mkdir(stateDir, { recursive: true }),
        fs.mkdir(workspaceDir, { recursive: true }),
      ]);
      for (const [key, value] of Object.entries(env)) {
        setTestEnvValue(key, value);
      }

      const runId = randomUUID();
      const { promise: final, resolve: resolveFinal } = createDeferred<ChatFinalPayload>();
      gateway = await startGatewayWithClient({
        cfg: {
          agents: {
            defaults: { workspace: workspaceDir, skipBootstrap: true },
            entries: { main: {} },
          },
          channels: {
            telegram: {
              enabled: true,
              botToken: "test-token",
              dmPolicy: "allowlist",
              allowFrom: ["123"],
            },
          },
          commands: { text: true },
          gateway: { auth: { mode: "token", token: "allowlist-gateway-token" } },
          plugins: {
            enabled: true,
            allow: ["telegram"],
            entries: { telegram: { enabled: true } },
          },
        },
        configPath,
        token: "allowlist-gateway-token",
        clientDisplayName: "allowlist-store-read-failure",
        onEvent: (event) => {
          if (event.event !== "chat" || !event.payload || typeof event.payload !== "object") {
            return;
          }
          const payload = event.payload as ChatFinalPayload;
          if (payload.runId === runId && payload.state === "final") {
            resolveFinal?.(payload);
          }
        },
      });

      // Pairing reads run in a worker; inject the failure at that existing boundary.
      read.mockImplementation(async (...args) => {
        const request = args[1];
        if (
          faultArmed &&
          request.type === "pairing.allowFrom" &&
          request.input.channel === "telegram"
        ) {
          faultArmed = false;
          faultObserved = true;
          throw new Error("injected pairing-store read failure");
        }
        return originalRead(...args);
      });
      faultArmed = true;

      await gateway.client.request("chat.send", {
        sessionKey: "agent:main:main",
        message: "/allowlist list dm channel=telegram",
        deliver: false,
        idempotencyKey: runId,
      });
      const payload = await withTestTimeout(
        final,
        30_000,
        "timed out waiting for allowlist command reply",
      );

      expect(faultObserved).toBe(true);
      expect(extractFirstTextBlock(payload.message)).toContain(
        "Paired allowFrom (store): unavailable (read failed). Retry this command; if it still fails, run openclaw doctor.",
      );
    } finally {
      read.mockRestore();
      if (gateway) {
        await disconnectGatewayClient(gateway.client).catch(() => undefined);
        await gateway.server.close().catch(() => undefined);
      }
      envSnapshot.restore();
      clearRuntimeConfigSnapshot();
      clearConfigCache();
      clearSessionStoreCacheForTest();
    }
  });
});
