import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { activatePluginRegistry } from "../plugins/loader-shared.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { clearActivePluginRegistry, resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { handleGatewayRequest } from "./server-methods.js";
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
    const pluginDir = path.join(state.workspaceDir, "fixture");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "MiXeD-demo",
        activation: { onStartup: true },
        configSchema: { type: "object", properties: {} },
      }),
    );
    await fs.writeFile(
      path.join(pluginDir, "index.js"),
      `module.exports = {
        id: "MiXeD-demo",
        register(api) {
          api.registerGatewayMethod("MiXeD-demo.probe", ({ respond }) => {
            respond(true, { registered: true });
          });
        }
      };`,
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
            load: { paths: [pluginDir] },
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
        const respond = vi.fn();
        await handleGatewayRequest({
          req: { type: "req", id: phase, method: "MiXeD-demo.probe", params: {} },
          client: {
            connId: "plugin-identity",
            connect: {
              role: "operator",
              scopes: ["operator.admin"],
              client: { id: "cli", version: "test", platform: "linux", mode: "cli" },
              minProtocol: 1,
              maxProtocol: 1,
            },
          },
          isWebchatConnect: () => false,
          context: createGatewayRequestContext(makeContextParams()),
          methodRegistry: createGatewayMethodRegistry(
            loaded.pluginRegistry.gatewayMethodDescriptors,
            loaded.pluginRegistry,
          ),
          respond,
        });
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
