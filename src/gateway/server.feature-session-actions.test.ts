import { Type } from "typebox";
import { expect, it } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { createFeatureClient, defineFeatureContract } from "../plugin-sdk/feature-contract.js";
import { createStartupTestState } from "./server-startup.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

const pluginId = "feature-session-action-errors";
const contract = defineFeatureContract({
  pluginId,
  operations: {
    inspect: {
      kind: "query",
      description: "Inspect the fixture",
      input: Type.Object({ message: Type.String() }),
      output: Type.String(),
    },
  },
  events: {},
});
const source = `const { defineFeaturePlugin } = require("openclaw/plugin-sdk/feature-plugin");
module.exports = defineFeaturePlugin({
  contract: ${JSON.stringify(contract)},
  name: "Feature error fixture",
  description: "Feature error fixture",
  setup: () => ({ inspect: ({ message }) => { throw new Error(message); } }),
});`;

it("preserves bounded feature errors across authenticated session actions and the feature client", async ({
  signal,
}) => {
  await using state = await createStartupTestState("feature-session-action-errors", {
    OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  });
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
  let acquisition: ReturnType<typeof startGatewayWithClient> | undefined;
  let reportedAcquisitionError: unknown;
  await runQaGatewayFixture(
    async () => {
      const pluginDir = state.statePath("plugin");
      await state.writeJson("plugin/package.json", {
        name: pluginId,
        version: "1.0.0",
        openclaw: { extensions: ["./index.cjs"] },
      });
      await state.writeJson("plugin/openclaw.plugin.json", {
        id: pluginId,
        activation: { onStartup: true },
        configSchema: { type: "object" },
      });
      await state.writeText("plugin/index.cjs", source);
      const token = "feature-session-action-token";
      acquisition = startGatewayWithClient({
        configPath: state.configPath,
        token,
        scopes: ["operator.read"],
        cfg: {
          agents: {
            defaults: { workspace: state.workspaceDir, skipBootstrap: true },
            entries: { main: {} },
          },
          gateway: { auth: { mode: "token", token } },
          plugins: { allow: [pluginId], load: { paths: [pluginDir] }, slots: { memory: "none" } },
        },
      }).then((started) => {
        gateway = started;
        return started;
      });
      try {
        gateway = await withinTest(acquisition, signal);
      } catch (error) {
        reportedAcquisitionError = error;
        throw error;
      }
      await withinTest(gateway.server.startupSettled, signal);
      const feature = createFeatureClient(contract, {
        pluginId,
        signal,
        connection: { connected: true },
        request: gateway.client.request.bind(gateway.client),
        onEvent: () => () => {},
        subscribe: () => () => {},
      });
      for (const [message, error] of [
        ["Downstream service unavailable", "Downstream service unavailable"],
        ["", "Feature operation failed"],
        ["   ", "Feature operation failed"],
        ["x".repeat(1999) + "😀", "x".repeat(1999)],
      ] as const) {
        await expect(
          gateway.client.request("plugins.sessionAction", {
            pluginId,
            actionId: "inspect",
            payload: { message },
          }),
        ).resolves.toEqual({ ok: false, error, code: "OPERATION_FAILED" });
        await expect(feature.invoke("inspect", { message })).rejects.toMatchObject({
          message: error,
        });
      }
    },
    async () => {
      // Retain late startup success or failure until its resources can be closed.
      try {
        await acquisition;
      } catch (error) {
        if (error !== reportedAcquisitionError) {
          throw error;
        }
      }
    },
    () => gateway && disconnectGatewayClient(gateway.client),
    () => gateway?.server.close({ reason: "feature session action proof complete" }),
  );
});
