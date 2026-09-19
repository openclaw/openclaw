import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveAuthProfileStore } from "../src/agents/auth-profiles/store-runtime.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../src/config/config.js";
import { clearSessionStoreCacheForTest } from "../src/config/sessions/store-writer-state.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { closeOpenClawAgentDatabasesForTest } from "../src/state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../src/state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../src/test-utils/env.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";

const envKeys = [
  "HOME",
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
] as const;

const MODEL_ID = "only-in-main";
const TOKEN = "pr58373-proof-token";

describe("PR #58373 secondary catalog runtime proof", () => {
  let tempHome: string | undefined;

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    if (tempHome) {
      await fs.rm(tempHome, { recursive: true, force: true });
      tempHome = undefined;
    }
  });

  it(
    "runs a model found only in the system-agent catalog after agents.create",
    { timeout: 90_000 },
    async () => {
      const envSnapshot = captureEnv([...envKeys]);
      let providerServer: ReturnType<typeof createServer> | undefined;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      const providerRequests: Array<{ method: string; url: string }> = [];

      try {
        tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pr58373-proof-"));
        const stateDir = path.join(tempHome, ".openclaw");
        const mainAgentDir = path.join(stateDir, "agents", "main", "agent");
        const secondaryAgentDir = path.join(stateDir, "agents", "ops", "agent");
        const mainWorkspaceDir = path.join(tempHome, "workspace-main");
        const secondaryWorkspaceDir = path.join(tempHome, "workspace-ops");
        const configPath = path.join(stateDir, "openclaw.json");
        const bundledPluginsDir = path.join(tempHome, "bundled-plugins");
        await Promise.all([
          fs.mkdir(mainAgentDir, { recursive: true }),
          fs.mkdir(mainWorkspaceDir, { recursive: true }),
          fs.mkdir(bundledPluginsDir, { recursive: true }),
          fs.mkdir(path.dirname(configPath), { recursive: true }),
        ]);
        for (const [key, value] of Object.entries({
          HOME: tempHome,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_GATEWAY_TOKEN: TOKEN,
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        })) {
          setTestEnvValue(key, value);
        }

        providerServer = createServer((request, response) => {
          providerRequests.push({ method: request.method ?? "", url: request.url ?? "" });
          request.resume();
          writeOpenAiResponsesText(response, {
            text: "PR58373_RUNTIME_OK",
            messageId: "pr58373-message",
            responseId: "pr58373-response",
          });
        });
        await new Promise<void>((resolve, reject) => {
          providerServer?.once("error", reject);
          providerServer?.listen(0, "127.0.0.1", resolve);
        });
        const providerAddress = providerServer.address();
        if (!providerAddress || typeof providerAddress === "string") {
          throw new Error("proof provider did not bind a loopback port");
        }
        const provider = buildMockOpenAiResponsesProvider(
          `http://127.0.0.1:${providerAddress.port}/v1`,
          MODEL_ID,
        );
        const { apiKey: _apiKey, ...catalogProvider } = provider.config;
        await fs.writeFile(
          path.join(mainAgentDir, "models.json"),
          `${JSON.stringify({ providers: { [provider.providerId]: catalogProvider } }, null, 2)}\n`,
        );
        saveAuthProfileStore(
          {
            version: 1,
            profiles: {
              [`${provider.providerId}:proof`]: {
                type: "api_key",
                provider: provider.providerId,
                key: "synthetic-loopback-key",
              },
            },
          },
          mainAgentDir,
          { syncExternalCli: false },
        );

        const cfg = {
          agents: {
            defaults: {
              workspace: mainWorkspaceDir,
              skipBootstrap: true,
              model: { primary: provider.modelRef },
              models: {
                [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
              },
            },
            entries: { main: { default: true } },
          },
          gateway: { auth: { mode: "token", token: TOKEN } },
        };
        gateway = await startGatewayWithClient({
          cfg,
          configPath,
          token: TOKEN,
          clientDisplayName: "pr58373-proof",
          scopes: ["operator.admin", "operator.read", "operator.write"],
        });
        await gateway.server.startupSettled;

        await expect(
          gateway.client.request("agents.create", {
            name: "ops",
            workspace: secondaryWorkspaceDir,
          }),
        ).resolves.toMatchObject({ agentId: "ops", ok: true });
        const updatedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
        expect(updatedConfig.agents?.entries?.ops).toMatchObject({
          workspace: secondaryWorkspaceDir,
        });
        await expect(fs.stat(path.join(secondaryAgentDir, "models.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });

        await disconnectGatewayClient(gateway.client);
        await gateway.server.close();
        gateway = await startGatewayWithClient({
          cfg: updatedConfig,
          configPath,
          token: TOKEN,
          clientDisplayName: "pr58373-proof-restarted",
          scopes: ["operator.admin", "operator.read", "operator.write"],
        });
        await gateway.server.startupSettled;

        const runId = "pr58373-secondary-turn";
        const accepted = await gateway.client.request<{ runId?: string; status?: string }>(
          "agent",
          {
            sessionKey: "agent:ops:main",
            message: "Reply with the configured proof marker.",
            deliver: false,
            idempotencyKey: runId,
          },
        );
        expect(accepted).toMatchObject({ runId, status: "accepted" });
        await expect(
          gateway.client.request("agent.wait", { runId, timeoutMs: 30_000 }),
        ).resolves.toMatchObject({ status: "ok" });

        expect(providerRequests).toEqual([{ method: "POST", url: "/v1/responses" }]);
        await expect(fs.stat(path.join(secondaryAgentDir, "models.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        if (gateway) {
          await disconnectGatewayClient(gateway.client).catch(() => undefined);
          await gateway.server.close().catch(() => undefined);
        }
        if (providerServer?.listening) {
          await new Promise<void>((resolve) => {
            providerServer?.close(() => resolve());
          });
        }
        envSnapshot.restore();
        clearRuntimeConfigSnapshot();
        clearConfigCache();
        clearSessionStoreCacheForTest();
      }
    },
  );
});
