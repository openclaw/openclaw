import { Type } from "typebox";
import { expect, it } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import {
  createFeatureClient,
  defineFeatureContract,
  type FeatureOperation,
  type FeatureContract,
} from "../plugin-sdk/feature-contract.js";
import { createStartupTestState } from "./server-startup.test-support.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";

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

const valueSchema = Type.Object({ value: Type.String() }, { additionalProperties: false });
const largeContract = {
  pluginId: "feature-session-action-large",
  operations: Object.fromEntries(
    Array.from({ length: 80 }, (_, index) => [
      `operation-${index}`,
      {
        kind: index % 2 === 0 ? "query" : "action",
        description: "Read or update the fixture value",
        input: valueSchema,
        output: valueSchema,
        ...(index < 30 ? { tool: { name: `feature_tool_${index}` } } : {}),
      } satisfies FeatureOperation,
    ]),
  ),
  events: {},
} satisfies FeatureContract;
const largeSource = `const { defineFeatureContract } = require("openclaw/plugin-sdk/feature-contract");
const { defineFeaturePlugin } = require("openclaw/plugin-sdk/feature-plugin");
const contract = defineFeatureContract(${JSON.stringify(largeContract)});
module.exports = defineFeaturePlugin({
  contract,
  name: "Large feature fixture",
  description: "Large feature fixture",
  setup: () => {
    let value = "initial";
    return Object.fromEntries(Object.entries(contract.operations).map(([id, operation]) => [
      id,
      (input) => {
        if (operation.kind === "action") value = input.value;
        return { value };
      },
    ]));
  },
});`;

it("dispatches large feature contracts with authenticated scopes and preserves bounded errors", async ({
  signal,
}) => {
  await using state = await createStartupTestState("feature-session-action-errors", {
    OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  });
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
  let writer: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
  let acquisition: ReturnType<typeof startGatewayWithClient> | undefined;
  let reportedAcquisitionError: unknown;
  await runQaGatewayFixture(
    async () => {
      const fixtures = [
        { id: pluginId, source, tools: [] },
        {
          id: largeContract.pluginId,
          source: largeSource,
          tools: Array.from({ length: 30 }, (_, index) => `feature_tool_${index}`),
        },
      ];
      for (const fixture of fixtures) {
        const dir = `plugins/${fixture.id}`;
        await state.writeJson(`${dir}/package.json`, {
          name: fixture.id,
          version: "1.0.0",
          openclaw: { extensions: ["./index.cjs"] },
        });
        await state.writeJson(`${dir}/openclaw.plugin.json`, {
          id: fixture.id,
          activation: { onStartup: true },
          contracts: { tools: fixture.tools },
          configSchema: { type: "object" },
        });
        await state.writeText(`${dir}/index.cjs`, fixture.source);
      }
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
          plugins: {
            allow: fixtures.map(({ id }) => id),
            load: { paths: fixtures.map(({ id }) => state.statePath(`plugins/${id}`)) },
            slots: { memory: "none" },
          },
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
      const readerFeature = createFeatureClient(largeContract, {
        pluginId: largeContract.pluginId,
        signal,
        connection: { connected: true },
        request: gateway.client.request.bind(gateway.client),
        onEvent: () => () => {},
        subscribe: () => () => {},
      });
      const query = {
        pluginId: largeContract.pluginId,
        actionId: "operation-78",
        payload: { value: "read" },
      };
      const action = { ...query, actionId: "operation-79", payload: { value: "forbidden" } };
      await expect(gateway.client.request("plugins.sessionAction", query)).resolves.toEqual({
        ok: true,
        result: { value: "initial" },
      });
      await expect(gateway.client.request("plugins.sessionAction", action)).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "missing scope: operator.write",
      });
      await expect(readerFeature.invoke("operation-79", action.payload)).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "missing scope: operator.write",
      });
      writer = await connectGatewayClient({
        url: `ws://127.0.0.1:${gateway.port}`,
        token,
        scopes: ["operator.write"],
        signal,
      });
      const writerFeature = createFeatureClient(largeContract, {
        pluginId: largeContract.pluginId,
        signal,
        connection: { connected: true },
        request: writer.request.bind(writer),
        onEvent: () => () => {},
        subscribe: () => () => {},
      });
      await expect(
        writer.request("plugins.sessionAction", { ...action, payload: { value: 42 } }),
      ).rejects.toMatchObject({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("plugin session action payload does not match schema"),
      });
      // Neither rejected writes nor malformed input may reach the state-changing handler.
      await expect(readerFeature.invoke("operation-78", query.payload)).resolves.toEqual({
        value: "initial",
      });
      await expect(
        writer.request("plugins.sessionAction", { ...action, payload: { value: "raw action" } }),
      ).resolves.toEqual({ ok: true, result: { value: "raw action" } });
      await expect(
        writerFeature.invoke("operation-79", { value: "feature client action" }),
      ).resolves.toEqual({ value: "feature client action" });
      await expect(readerFeature.invoke("operation-78", query.payload)).resolves.toEqual({
        value: "feature client action",
      });
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
    () => writer && disconnectGatewayClient(writer),
    () => gateway?.server.close({ reason: "feature session action proof complete" }),
  );
});
