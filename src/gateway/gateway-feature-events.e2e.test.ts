/** Public feature contracts reach authenticated clients through the normal plugin loader. */
import { expect, it } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { createStartupTestState } from "./server-startup.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

const pluginId = "feature-events-proof";
const source = `import { defineFeatureContract } from "openclaw/plugin-sdk/feature-contract";
import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";
const schema = { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false };
const events = Object.fromEntries(Array.from({ length: 80 }, (_, i) => ["event-" + i, schema]));
const contract = defineFeatureContract({
  pluginId: "feature-events-proof",
  operations: { emit: { kind: "action", description: "Emit declared events", input: schema, output: schema } },
  events,
});
export default defineFeaturePlugin({
  contract, name: "Feature events proof", description: "Feature event delivery fixture",
  setup(_api, emitter) {
    return { emit(input) {
      for (const event of Object.keys(events)) emitter.emit(event, input);
      return input;
    } };
  },
});`;

it("delivers more than 64 declared feature event types through the Gateway", async ({ signal }) => {
  await using state = await createStartupTestState("feature-events", {
    OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  });
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
  const received: Array<{ event: string; payload: unknown }> = [];
  const delivered = createDeferred();
  await runQaGatewayFixture(
    async () => {
      await state.writeJson("plugin/package.json", {
        name: pluginId,
        version: "1.0.0",
        openclaw: { extensions: ["./index.ts"] },
      });
      await state.writeJson("plugin/openclaw.plugin.json", {
        id: pluginId,
        activation: { onStartup: true },
        configSchema: { type: "object" },
      });
      await state.writeText("plugin/index.ts", source);
      const token = "feature-events-test-token";
      gateway = await startGatewayWithClient({
        configPath: state.configPath,
        token,
        scopes: ["operator.read", "operator.write"],
        cfg: {
          agents: {
            defaults: { workspace: state.workspaceDir, skipBootstrap: true },
            entries: { main: {} },
          },
          gateway: { auth: { mode: "token", token } },
          plugins: {
            allow: [pluginId],
            load: { paths: [state.statePath("plugin")] },
            slots: { memory: "none" },
          },
        },
        onEvent(frame) {
          if (frame.event?.startsWith("plugin." + pluginId + ".")) {
            received.push({ event: frame.event, payload: frame.payload });
            if (received.length === 80) {
              delivered.resolve();
            }
          }
        },
      });
      await withinTest(gateway.server.startupSettled, signal);
      const { client } = gateway;
      const invoke = (value: unknown) =>
        client.request("plugins.sessionAction", {
          pluginId,
          actionId: "emit",
          payload: { value },
        });
      await expect(invoke("invalid")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect(received).toEqual([]);
      await expect(invoke(42)).resolves.toEqual({ ok: true, result: { value: 42 } });
      await withinTest(delivered.promise, signal);
      expect(received).toEqual(
        Array.from({ length: 80 }, (_, i) => ({
          event: "plugin.feature-events-proof.event-" + i,
          payload: { value: 42 },
        })),
      );
    },
    () => gateway && disconnectGatewayClient(gateway.client),
    () => gateway?.server.close({ reason: "feature event proof complete" }),
  );
}, 120_000);
