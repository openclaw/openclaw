import { randomUUID } from "node:crypto";
import path from "node:path";
import { expect, it } from "vitest";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { getPublishedPreparedModelCatalogOwnerSnapshot } from "../agents/prepared-model-catalog.js";
import { getRuntimeConfig } from "../config/config.js";
import { deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import {
  createGatewayConfigPath,
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

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
        setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
        const baseUrl = endpoint === "native" ? "https://api.x.ai/v1" : "https://custom.invalid/v1";
        const personal = {
          api: "openai-responses",
          baseUrl,
          apiKey: "synthetic-personal-key",
          models: [{ id: "auto", name: "Auto" }],
        };
        const cfg = {
          agents: {
            defaults: {
              workspace: home.workspaceDir,
              skipBootstrap: true,
              model: "personal/auto",
              models: { "personal/auto": { alias: "Personal" } },
              modelPolicy: { allow: [] },
            },
          },
          models: { providers: { personal } },
          plugins: { allow: ["xai"], entries: { xai: { enabled: true } } },
          gateway: { auth: { mode: "token", token } },
          hooks: { enabled: false },
        };
        gateway = await startGatewayWithClient({
          cfg,
          token,
          configPath: await createGatewayConfigPath(home.tempHome),
        });
        await gateway.server.startupSettled;
        const { client } = gateway;
        const owner = getPublishedPreparedModelCatalogOwnerSnapshot({
          config: getRuntimeConfig(),
          agentId: "main",
          workspaceDir: home.workspaceDir,
        });
        expect(owner?.metadataSnapshot.plugins.some((plugin) => plugin.id === "xai")).toBe(true);
        type Row = { provider: string; id: string; available?: boolean };
        for (const [view, preparedOnly] of [
          ["default", true],
          ["configured", true],
          ["default", false],
          ["configured", false],
          ["provider-config", true],
        ] as const) {
          const { models } = await client.request<{ models: Row[] }>("models.list", {
            view,
            preparedOnly,
          });
          const model = models.find((row) => row.provider === "personal" && row.id === "auto");
          const context = JSON.stringify({ view, preparedOnly, model });
          if (view === "provider-config") {
            expect(model?.id).toBe("auto");
          } else if (endpoint === "native") {
            expect(model, context).toBeUndefined();
          } else {
            expect(model?.available, context).toBe(true);
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
