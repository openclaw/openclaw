import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { writeJsonFile } from "../../test/helpers/temp-repo.js";
import * as configSnapshot from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as hooks from "../plugins/hook-runner-global.js";
import { activatePluginRegistry } from "../plugins/loader-shared.js";
import type { PluginLoadOptions } from "../plugins/loader-types.js";
import { loadPluginRegistryHandle } from "../plugins/loader.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { getPluginInstance, type PluginInstanceHandle } from "../plugins/plugin-instance-scope.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  bindPluginRegistryGatewayOwner,
  getPluginRegistryGatewayOwner,
} from "../plugins/registry-lifecycle.js";
import { createPluginRegistryOwner, resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import * as mcp from "./mcp-http-request.test-support.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";

const fixtureLifetime = createFixtureLifetime();
afterEach(() => fixtureLifetime.cleanup());

function writePlugin(dir: string, id: string, manifest: object, source: string) {
  writeJsonFile(path.join(dir, id, "package.json"), {
    name: `@openclaw/${id}`,
    version: "1.0.0",
    type: "commonjs",
    main: "index.cjs",
    openclaw: { extensions: ["./index.cjs"] },
  });
  writeJsonFile(path.join(dir, id, "openclaw.plugin.json"), {
    id,
    configSchema: { type: "object", additionalProperties: false },
    ...manifest,
  });
  fs.writeFileSync(path.join(dir, id, "index.cjs"), source);
}

// #205714: a run whose prepared registry borrowed a hook plugin from the Gateway keeps that
// registry for the whole run. When only the hook plugin reloads, the run's registry stays
// live but its borrowed hook instance is gone; later tool calls must reach the new hook.
it("runs a reloaded before_tool_call hook for a run-bound grant on a borrowing registry", async ({
  signal,
}) =>
  fixtureLifetime.run(async () => {
    const root = fixtureLifetime.createTempDir("mcp-grant-hook-reload-");
    const bundledDir = path.join(root, "bundled");
    const workspaceDir = path.join(root, "workspace");
    const hookEvent = `guard-probe:${root}`;
    const pluginIds = ["steady-probe", "guard-probe"];
    const config: OpenClawConfig = {
      agents: { defaults: { workspace: workspaceDir } },
      plugins: {
        allow: pluginIds,
        entries: Object.fromEntries(pluginIds.map((id) => [id, { enabled: true }])),
      },
      tools: { allow: ["steady_probe"] },
    };
    const hookLoads: number[] = [];
    const onHook = (load: number) => hookLoads.push(load);
    const instances: PluginInstanceHandle[] = [];
    const load = (options: Partial<PluginLoadOptions>) =>
      withPluginCache(createPluginCache(), () => {
        const metadataSnapshot = resolvePluginMetadataSnapshot({ config, workspaceDir });
        const pluginRegistry = loadPluginRegistryHandle({
          config,
          workspaceDir,
          manifestRegistry: metadataSnapshot.manifestRegistry,
          onlyPluginIds: pluginIds,
          ...options,
        });
        const guard = pluginRegistry.plugins.find((plugin) => plugin.id === "guard-probe");
        for (const plugin of pluginRegistry.plugins) {
          const instance = getPluginInstance(plugin);
          if (instance && !instances.includes(instance)) {
            instances.push(instance);
          }
        }
        return {
          pluginRegistry,
          metadataSnapshot,
          guard: expectDefined(guard && getPluginInstance(guard), "guard instance"),
        };
      });
    // A Gateway-mode load, published the way the Gateway publishes, so it lends its records.
    const publish = (options: Partial<PluginLoadOptions>) => {
      const generation = load({ activate: false, runtimeSideEffects: true, ...options });
      activatePluginRegistry(generation.pluginRegistry, null, "gateway-bindable");
      hooks.initializeGlobalHookRunner(generation.pluginRegistry);
      return generation;
    };
    const admissions: Array<{ close: () => unknown }> = [];

    await runQaGatewayFixture(
      async () => {
        process.on(hookEvent, onHook);
        vi.stubEnv("OPENCLAW_HOME", root);
        vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
        vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
        vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledDir);
        writePlugin(
          bundledDir,
          "steady-probe",
          { contracts: { tools: ["steady_probe"] } },
          `module.exports = { id: "steady-probe", register(api) {
      api.registerTool({
        name: "steady_probe", label: "steady_probe", description: "probe",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [{ type: "text", text: "steady_probe ok" }] })
      });
    } };`,
        );
        // A hook-only policy plugin (like a tool guard); each load counts itself.
        writePlugin(
          bundledDir,
          "guard-probe",
          {},
          `module.exports = { id: "guard-probe", register(api) {
      const load = (globalThis.__guardProbeLoads = (globalThis.__guardProbeLoads ?? 0) + 1);
      api.on("before_tool_call", () => { process.emit(${JSON.stringify(hookEvent)}, load); });
    } };`,
        );
        configSnapshot.setRuntimeConfigSnapshot(config);
        const gateway = publish({});
        const owner = createPluginRegistryOwner(gateway.pluginRegistry);
        // The run's prepared registry lists the Gateway's unchanged records (a different
        // workspace or activation input than the Gateway's own load).
        const prepared = load({
          activate: false,
          preferBuiltPluginArtifacts: true,
          borrowRegistry: gateway.pluginRegistry,
        });
        expect(prepared.pluginRegistry).not.toBe(gateway.pluginRegistry);
        expect(prepared.guard).toBe(gateway.guard);
        // As a turn registry is bound to the Gateway that admitted it.
        bindPluginRegistryGatewayOwner(
          prepared.pluginRegistry,
          expectDefined(getPluginRegistryGatewayOwner(gateway.pluginRegistry), "Gateway owner"),
          gateway.pluginRegistry,
        );

        await withPluginRuntimeGenerationScope(gateway, ensureMcpLoopbackServer);
        const runtime = mcp.runtime();
        const admission = mcp.prepareAdmission("hook-run", "mcp-hook-reload-proof");
        admissions.push(admission);
        const admittedRunContext = await admission.admit("gateway", "gateway-hook-run");
        const grant = withPluginRuntimeGenerationScope(prepared, () =>
          mcp.captureGrant(
            {
              context: { sessionKey: "agent:main:hook-run", senderIsOwner: true },
              runtimeOwnerToken: runtime.ownerToken,
              admittedRunContext,
              toolPolicyConfig: config,
              withCronManagementToolConstruction: (run) => run(),
            },
            "capture-hook-run",
          ),
        );
        const callTool = async () =>
          await mcp.json(
            await mcp.request(runtime, mcp.toolCall("steady_probe"), {
              token: grant.token,
              captureKey: grant.captureKey,
              sessionKey: "agent:main:hook-run",
              signal,
              connection: "close",
            }),
          );
        const ok = {
          result: { content: [{ type: "text", text: "steady_probe ok" }], isError: false },
        };
        expect(await callTool()).toMatchObject(ok);

        // Only the hook plugin reloads, as `openclaw plugins reload guard-probe` does: the
        // Gateway publishes a registry with a new guard instance and disposes the old one.
        const next = publish({
          previousRegistry: gateway.pluginRegistry,
          replacePluginIds: ["guard-probe"],
        });
        owner.publish(next.pluginRegistry);
        await gateway.guard.dispose();

        // The run goes on: its next calls pass the new hook instead of failing closed.
        expect(await callTool()).toMatchObject(ok);
        expect(await callTool()).toMatchObject(ok);
        expect(hookLoads).toEqual([1, 2, 2]);
      },
      ...[
        closeMcpLoopbackServer,
        () => Promise.all(admissions.map(async (admission) => await admission.close())),
        () => Promise.all(instances.map((instance) => instance.dispose())),
        () => resetPluginRuntimeStateForTest(),
        () => hooks.resetGlobalHookRunner(),
        () => configSnapshot.clearRuntimeConfigSnapshot(),
        () => process.off(hookEvent, onHook),
        () => vi.unstubAllEnvs(),
      ].map(
        (cleanup) => () =>
          fixtureLifetime.verifyCleanup(async () => {
            await Promise.resolve(cleanup());
          }),
      ),
    );
  }));
