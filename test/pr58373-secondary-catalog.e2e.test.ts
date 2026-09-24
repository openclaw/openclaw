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
    "uses secondary credentials for inherited models and rejects after all credentials are removed",
    { timeout: 90_000 },
    async () => {
      const envSnapshot = captureEnv([...envKeys]);
      let providerServer: ReturnType<typeof createServer> | undefined;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      const providerRequests: Array<{
        authorization: string | undefined;
        catalogRoute: string | undefined;
        cookie: string | undefined;
        method: string;
        modelRoute: string | undefined;
        url: string;
      }> = [];

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
          providerRequests.push({
            authorization: request.headers.authorization,
            catalogRoute: request.headers["x-catalog-route"] as string | undefined,
            cookie: request.headers.cookie,
            method: request.method ?? "",
            modelRoute: request.headers["x-model-route"] as string | undefined,
            url: request.url ?? "",
          });
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
        const { apiKey: _apiKey, ...catalogProviderBase } = provider.config;
        const catalogProvider = {
          ...catalogProviderBase,
          headers: {
            Authorization: "Bearer system-agent-catalog-key",
            Cookie: "provider-session=system-agent",
            "X-Catalog-Route": "provider-route",
          },
          models: catalogProviderBase.models.map((model) =>
            Object.assign({}, model, {
              headers: {
                Authorization: "Bearer system-agent-model-key",
                cookie: "model-session=system-agent",
                "X-Model-Route": "model-route",
              },
            }),
          ),
        };
        const mainCatalog = JSON.stringify(
          { providers: { [provider.providerId]: catalogProvider } },
          null,
          2,
        )
          .replace('"providers": {', '"providers": {\n    // Supported catalog comment.')
          .replace('"X-Model-Route": "model-route"', '"X-Model-Route": "model-route",');
        await fs.writeFile(path.join(mainAgentDir, "models.json"), `${mainCatalog}\n`);
        saveAuthProfileStore(
          {
            version: 1,
            profiles: {
              [`${provider.providerId}:proof`]: {
                type: "api_key",
                provider: provider.providerId,
                key: "system-agent-auth-key",
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
        const saveSecondaryAuth = (key: string) =>
          saveAuthProfileStore(
            {
              version: 1,
              profiles: {
                [`${provider.providerId}:proof`]: {
                  type: "api_key",
                  provider: provider.providerId,
                  key,
                },
              },
            },
            secondaryAgentDir,
            { syncExternalCli: false },
          );
        saveSecondaryAuth("secondary-account-b");

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

        const runSecondaryTurn = async (runId: string) => {
          const accepted = await gateway?.client.request<{ runId?: string; status?: string }>(
            "agent",
            {
              sessionKey: "agent:ops:main",
              message: "Reply with the configured proof marker.",
              deliver: false,
              idempotencyKey: runId,
            },
          );
          expect(accepted).toMatchObject({ runId, status: "accepted" });
          return gateway?.client.request("agent.wait", { runId, timeoutMs: 30_000 });
        };
        await expect(runSecondaryTurn("pr58373-secondary-account-b")).resolves.toMatchObject({
          status: "ok",
        });
        expect(providerRequests).toEqual([
          {
            authorization: "Bearer secondary-account-b",
            catalogRoute: "provider-route",
            cookie: undefined,
            method: "POST",
            modelRoute: "model-route",
            url: "/v1/responses",
          },
        ]);

        saveSecondaryAuth("secondary-account-c");
        await expect(runSecondaryTurn("pr58373-secondary-account-c")).resolves.toMatchObject({
          status: "ok",
        });
        expect(providerRequests[1]).toEqual({
          authorization: "Bearer secondary-account-c",
          catalogRoute: "provider-route",
          cookie: undefined,
          method: "POST",
          modelRoute: "model-route",
          url: "/v1/responses",
        });
        expect(providerRequests).toHaveLength(2);

        // Removing only the local profile would still allow shared-store authentication.
        // This custom provider has no configured or environment-backed credential source.
        for (const agentDir of [mainAgentDir, secondaryAgentDir]) {
          saveAuthProfileStore({ version: 1, profiles: {} }, agentDir, { syncExternalCli: false });
        }
        await expect(runSecondaryTurn("pr58373-secondary-no-credentials")).resolves.toMatchObject({
          status: "error",
          error: expect.stringContaining(`No API key found for provider "${provider.providerId}".`),
        });
        expect(providerRequests).toHaveLength(2);
        expect(await fs.readFile(path.join(mainAgentDir, "models.json"), "utf8")).toBe(
          `${mainCatalog}\n`,
        );
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
