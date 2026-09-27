import { randomUUID } from "node:crypto";
import path from "node:path";
import { expect, it } from "vitest";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { getPublishedPreparedModelCatalogOwnerSnapshot } from "../agents/prepared-model-catalog.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import {
  createGatewayConfigPath,
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import {
  disconnectGatewayClient,
  getGatewayE2ePortBlock,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";

it.each(["native", "custom"] as const)(
  "models.list excludes retired authored native models and preserves %s inventory",
  async (endpoint) => {
    resetGatewayTestState();
    const home = await setupGatewayTempHome({ prefix: "openclaw-auto-list-proof-" });
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    await runQaGatewayFixture(
      async () => {
        setTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR", path.resolve("extensions"));
        deleteTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS");
        const token = randomUUID();
        const port = await getGatewayE2ePortBlock();
        setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
        const baseUrl = endpoint === "native" ? "https://api.x.ai/v1" : "https://custom.invalid/v1";
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: home.workspaceDir,
              skipBootstrap: true,
              model: "personal/auto",
              models: { "personal/auto": { alias: "Personal" } },
              modelPolicy: { allow: [] },
            },
          },
          models: {
            providers: {
              personal: {
                api: "openai-responses",
                baseUrl,
                apiKey: "synthetic-personal-key",
                models: [
                  makeProviderModelFixture<"openai-responses">({
                    id: "auto",
                    name: "Authored auto",
                    provider: "personal",
                    api: "openai-responses",
                    baseUrl,
                    contextWindow: 128000,
                    maxTokens: 8192,
                  }),
                ].map(({ provider: _provider, ...model }) => model),
              },
            },
          },
          plugins: { allow: ["xai"], entries: { xai: { enabled: true } } },
          gateway: { port, auth: { mode: "token", token } },
          hooks: { enabled: false },
        };
        gateway = await startGatewayWithClient({
          cfg,
          port,
          token,
          configPath: await createGatewayConfigPath(home.tempHome),
        });
        await gateway.server.startupSettled;
        const owner = getPublishedPreparedModelCatalogOwnerSnapshot({
          config: getRuntimeConfig(),
          agentId: "main",
          workspaceDir: home.workspaceDir,
        });
        expect(owner?.metadataSnapshot.plugins.some((plugin) => plugin.id === "xai")).toBe(true);
        type Row = { provider: string; id: string; available?: boolean };
        const observed: Array<{ view: string; preparedOnly: boolean; model?: Row }> = [];
        for (const preparedOnly of [true, false]) {
          for (const view of ["default", "configured"] as const) {
            const response = await gateway.client.request<{ models: Row[] }>("models.list", {
              view,
              preparedOnly,
            });
            observed.push({
              view,
              preparedOnly,
              model: response.models.find(
                (row) => row.provider === "personal" && row.id === "auto",
              ),
            });
          }
        }
        const admin = await gateway.client.request<{ models: Row[] }>("models.list", {
          view: "provider-config",
          preparedOnly: true,
        });
        const adminModel = admin.models.find(
          (row) => row.provider === "personal" && row.id === "auto",
        );
        expect(adminModel?.id).toBe("auto");
        for (const result of observed) {
          if (endpoint === "native") {
            expect(result.model, JSON.stringify(result)).toBeUndefined();
          } else {
            expect(result.model?.available, JSON.stringify(result)).toBe(true);
          }
        }
      },
      () => gateway && disconnectGatewayClient(gateway.client),
      () => gateway?.server.close({ reason: "auto model-list proof complete" }),
      () => removeGatewayTempHome(home.tempHome),
      () => home.envSnapshot.restore(),
      resetGatewayTestState,
    );
  },
  600_000,
);
