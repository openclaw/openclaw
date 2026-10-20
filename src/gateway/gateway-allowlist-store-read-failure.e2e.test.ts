import { randomUUID } from "node:crypto";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { ChatEvent } from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  createGatewayConfigPath,
  removeGatewayTempHome,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

it("surfaces a pairing-store read failure through chat.send", { timeout: 90_000 }, async () => {
  const pluginEnv = captureEnv([
    "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
    "OPENCLAW_TEST_MINIMAL_GATEWAY",
    "OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR",
  ]);
  let home: Awaited<ReturnType<typeof setupGatewayTempHome>> | undefined;
  const originalRead = stateReads.executeExistingOpenClawStateRead;
  const read = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
  let faultObserved = false;
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
  try {
    home = await setupGatewayTempHome({ prefix: "openclaw-allowlist-gateway-" });
    // Unlike the empty-plugin fixture default, this command needs the real Telegram plugin.
    pluginEnv.restore();
    setTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(process.cwd(), "extensions"));
    setTestEnvValue("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");

    const runId = randomUUID();
    const { promise: final, resolve: resolveFinal } =
      createDeferred<Extract<ChatEvent, { state: "final" }>>();
    gateway = await startGatewayWithClient({
      cfg: {
        agents: {
          defaults: { workspace: home.workspaceDir, skipBootstrap: true },
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
      configPath: await createGatewayConfigPath(home.tempHome),
      token: "allowlist-gateway-token",
      clientDisplayName: "allowlist-store-read-failure",
      onEvent: (event) => {
        if (event.event !== "chat" || !event.payload || typeof event.payload !== "object") {
          return;
        }
        const payload = event.payload as ChatEvent;
        if (payload.runId === runId && payload.state === "final") {
          resolveFinal?.(payload);
        }
      },
    });

    // Pairing reads run in a worker; inject the failure at that existing boundary.
    read.mockImplementation(async (...args) => {
      const request = args[1];
      if (
        !faultObserved &&
        request.type === "pairing.allowFrom" &&
        request.input.channel === "telegram"
      ) {
        faultObserved = true;
        throw new Error("injected pairing-store read failure");
      }
      return originalRead(...args);
    });

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
    home?.envSnapshot.restore();
    pluginEnv.restore();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    clearSessionStoreCacheForTest();
    if (home) {
      await removeGatewayTempHome(home.tempHome);
    }
  }
});
