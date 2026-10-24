import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { activatePluginRegistry } from "../plugins/loader-shared.js";
import { writePlugin } from "../plugins/loader.test-fixtures.js";
import { updatePluginManifest } from "../plugins/loader.test-harness.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { clearActivePluginRegistry, resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import {
  authorizationClient,
  dispatchAuthorizationRequest,
} from "./server-methods.authorization.test-support.js";
import { prepareGatewayPluginLoad } from "./server-plugin-bootstrap.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";

afterEach(async () => {
  await clearActivePluginRegistry();
  clearPluginMetadataLifecycleCaches();
  resetPluginRuntimeStateForTest();
  vi.unstubAllEnvs();
});

it("dispatches mixed-case plugin methods after enablement and a cold start", async () => {
  await withOpenClawTestState({ label: "plugin-identity" }, async (state) => {
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    const plugin = writePlugin({
      dir: path.join(state.workspaceDir, "fixture"),
      id: "MiXeD-demo",
      filename: "index.js",
      configSchema: { type: "object", properties: {} },
      registration: `api.registerGatewayMethod("MiXeD-demo.probe", ({ respond }) => {
        respond(true, { registered: true });
      });`,
    });
    updatePluginManifest(plugin, { activation: { onStartup: true } });
    const client = authorizationClient(
      "plugin-identity",
      ["operator.admin"],
      {},
      {
        client: { id: "cli", version: "test", platform: "linux", mode: "cli" },
      },
    );
    let previous: Awaited<ReturnType<typeof prepareGatewayPluginLoad>> | undefined;
    try {
      for (const phase of ["disabled", "enabled", "cold start", "denied"] as const) {
        if (phase === "cold start") {
          previous?.retireGatewayRuntimeBindings();
          await clearActivePluginRegistry();
          clearPluginMetadataLifecycleCaches();
          previous = undefined;
        }
        const config: OpenClawConfig = {
          plugins: {
            allow: ["mixed-demo"],
            deny: phase === "denied" ? ["MIXED-demo"] : [],
            load: { paths: [plugin.dir] },
            slots: { memory: "none" },
            entries: { "mixed-demo": { enabled: phase !== "disabled" } },
          },
        };
        await state.writeConfig(config);
        const loaded = await prepareGatewayPluginLoad({
          cfg: config,
          workspaceDir: state.workspaceDir,
          env: process.env,
          log: { info() {}, warn() {}, error() {}, debug() {} },
          baseMethods: [],
          loadIntent: previous ? "replacement" : "startup",
          previousRegistry: previous?.pluginRegistry,
          ambientEnvTriggers: "suppress",
        });
        previous?.retireGatewayRuntimeBindings();
        previous = loaded;
        activatePluginRegistry(loaded.pluginRegistry, null, "gateway-bindable", state.workspaceDir);
        const respond = await dispatchAuthorizationRequest(
          "MiXeD-demo.probe",
          {},
          {
            client,
            context: createGatewayRequestContext(makeContextParams()),
            methodRegistry: createGatewayMethodRegistry(
              loaded.pluginRegistry.gatewayMethodDescriptors,
              loaded.pluginRegistry,
            ),
          },
          phase,
        );
        if (phase === "disabled" || phase === "denied") {
          expect(respond).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({
              message: "unknown method: MiXeD-demo.probe",
            }),
          );
        } else {
          expect(respond.mock.calls.at(-1)?.slice(0, 2), phase).toEqual([
            true,
            { registered: true },
          ]);
        }
      }
    } finally {
      previous?.retireGatewayRuntimeBindings();
      await clearActivePluginRegistry();
    }
  });
});
