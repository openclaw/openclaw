import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { writeJsonFile } from "../../test/helpers/temp-repo.js";
import * as configSnapshot from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import * as hooks from "../plugins/hook-runner-global.js";
import { loadPluginRegistryHandle } from "../plugins/loader.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { getPluginInstance, type PluginInstanceHandle } from "../plugins/plugin-instance-scope.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import * as mcp from "./mcp-http-request.test-support.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import * as captures from "./mcp-http.loopback-runtime.js";

const fixtureLifetime = createFixtureLifetime();
afterEach(() => fixtureLifetime.cleanup());

it.for(["plain", "shared"] as const)(
  "observes %s results by reference across registry replacement despite observer errors",
  async (variant, { signal }) =>
    fixtureLifetime.run(async () => {
      const root = fixtureLifetime.createTempDir("mcp-plugin-generation-");
      const bundledDir = path.join(root, "bundled");
      const pluginDir = path.join(bundledDir, "generation-probe");
      const workspaceDir = path.join(root, "workspace");
      const observationsEvent = `tool-completions:${root}`;
      const observations = new Map(
        ["before", "after"].map((phase) => [
          `agent:main:generation-${phase}`,
          createDeferred<unknown>(),
        ]),
      );
      const onObservation = (sessionKey: string, observation: unknown) =>
        observations.get(sessionKey)?.resolve(observation);
      const content = [{ type: "text", text: "generation tool available" }];
      const captureKey = `observer-${path.basename(root)}`;
      const captured: unknown[] = [];
      const warnings = createWarnLogCapture("mcp-observer-result-isolation");
      const config: OpenClawConfig = {
        agents: { defaults: { workspace: workspaceDir } },
        plugins: {
          allow: ["generation-probe"],
          entries: { "generation-probe": { enabled: true } },
        },
        tools: { allow: ["generation_probe"] },
      };
      const instances: PluginInstanceHandle[] = [];
      const loadGeneration = () => {
        const generation = withPluginCache(createPluginCache(), () => {
          const metadataSnapshot = resolvePluginMetadataSnapshot({ config, workspaceDir });
          const pluginRegistry = loadPluginRegistryHandle({
            config,
            workspaceDir,
            manifestRegistry: metadataSnapshot.manifestRegistry,
            onlyPluginIds: ["generation-probe"],
          });
          const record = pluginRegistry.plugins.find((plugin) => plugin.id === "generation-probe");
          const instance = expectDefined(record && getPluginInstance(record), "plugin instance");
          instances.push(instance);
          return { pluginRegistry, metadataSnapshot, instance };
        });
        setActivePluginRegistry(generation.pluginRegistry);
        hooks.initializeGlobalHookRunner(generation.pluginRegistry);
        return generation;
      };
      const callTool = async (phase: string) => {
        const runtime = mcp.runtime();
        const response = await mcp.request(runtime, mcp.toolCall("generation_probe", {}, phase), {
          signal,
          sessionKey: `agent:main:generation-${phase}`,
          captureKey,
          connection: "close",
        });
        const payload = await mcp.json(response);
        const details = variant === "shared" ? { bytes: new Uint8Array(1) } : {};
        expect({ payload, callback: captured.at(-1) }).toMatchObject({
          payload: { result: { content, isError: false } },
          callback: { outcome: "completed", result: { content, details } },
        });
        const callback = captured.at(-1);
        if (!isRecord(callback) || !isRecord(callback.result)) {
          throw new Error("MCP capture must retain the authoritative result");
        }
        callback.result.ownerAnnotation = phase;
      };

      await runQaGatewayFixture(
        async () => {
          process.on(observationsEvent, onObservation);
          vi.stubEnv("OPENCLAW_HOME", root);
          vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
          vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
          vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledDir);
          writeJsonFile(path.join(pluginDir, "package.json"), {
            name: "@openclaw/generation-probe",
            version: "1.0.0",
            type: "commonjs",
            main: "index.cjs",
            openclaw: { extensions: ["./index.cjs"] },
          });
          writeJsonFile(path.join(pluginDir, "openclaw.plugin.json"), {
            id: "generation-probe",
            configSchema: { type: "object", additionalProperties: false },
            contracts: { tools: ["generation_probe"] },
          });
          fs.writeFileSync(
            path.join(pluginDir, "index.cjs"),
            `module.exports = { id: "generation-probe", register(api) {
      let lastResult;
      api.on("after_tool_call", (event, ctx) => {
        process.emit(${JSON.stringify(observationsEvent)}, ctx.sessionKey, {
          toolName: event.toolName, sessionKey: ctx.sessionKey,
          sameResult: event.result === lastResult
        });
        throw new Error("observer failure must not change the HTTP result");
      }, { matcher: ["generation_probe"] });
      api.registerTool({
        name: "generation_probe", label: "Generation probe", description: "Return a generation-owned answer",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          lastResult = {
            content: [{ type: "text", text: "generation tool available" }],
            details: ${JSON.stringify(variant)} === "shared"
              ? { bytes: new Uint8Array(new SharedArrayBuffer(1)) }
              : {}
          };
          return lastResult;
        }
      });
    } };`,
          );
          configSnapshot.setRuntimeConfigSnapshot(config);
          captures.beginMcpLoopbackToolCallCapture({
            captureKey,
            onToolCallResult: (call) => captured.push(call),
          });
          const original = loadGeneration();
          await withPluginRuntimeGenerationScope(original, ensureMcpLoopbackServer);
          await callTool("before");

          loadGeneration();
          await original.instance.dispose();
          await callTool("after");
          const logged = await withinTest(
            Promise.all([...observations.values()].map((entry) => entry.promise)),
            signal,
          );
          expect(await warnings.findText("after_tool_call")).toBeDefined();
          expect(logged).toEqual(
            ["before", "after"].map((phase) => ({
              toolName: "generation_probe",
              sessionKey: `agent:main:generation-${phase}`,
              sameResult: true,
            })),
          );
        },
        ...[
          closeMcpLoopbackServer,
          () => captures.clearMcpLoopbackToolCallCapture(captureKey),
          () => Promise.all(instances.map((instance) => instance.dispose())),
          () => resetPluginRuntimeStateForTest(),
          () => hooks.resetGlobalHookRunner(),
          () => configSnapshot.clearRuntimeConfigSnapshot(),
          () => vi.unstubAllEnvs(),
          () => warnings.cleanup(),
          () => process.removeListener(observationsEvent, onObservation),
        ].map(
          (cleanup) => () =>
            fixtureLifetime.verifyCleanup(async () => {
              await Promise.resolve(cleanup());
            }),
        ),
      );
    }),
);

function writeProbePlugin(bundledDir: string, id: string, tool: string) {
  const pluginDir = path.join(bundledDir, id);
  writeJsonFile(path.join(pluginDir, "package.json"), {
    name: `@openclaw/${id}`,
    version: "1.0.0",
    type: "commonjs",
    main: "index.cjs",
    openclaw: { extensions: ["./index.cjs"] },
  });
  writeJsonFile(path.join(pluginDir, "openclaw.plugin.json"), {
    id,
    configSchema: { type: "object", additionalProperties: false },
    contracts: { tools: [tool] },
  });
  fs.writeFileSync(
    path.join(pluginDir, "index.cjs"),
    `module.exports = { id: ${JSON.stringify(id)}, register(api) {
      api.registerTool({
        name: ${JSON.stringify(tool)}, label: ${JSON.stringify(tool)}, description: "probe",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [{ type: "text", text: ${JSON.stringify(`${tool} ok`)} }] })
      });
    } };`,
  );
}

it("keeps a run-bound grant's tools working after a plugin reload retires its generation", async ({
  signal,
}) =>
  fixtureLifetime.run(async () => {
    const root = fixtureLifetime.createTempDir("mcp-grant-generation-");
    const bundledDir = path.join(root, "bundled");
    const workspaceDir = path.join(root, "workspace");
    const pluginIds = ["steady-probe", "reloaded-probe"];
    const config: OpenClawConfig = {
      agents: { defaults: { workspace: workspaceDir } },
      plugins: {
        allow: pluginIds,
        entries: Object.fromEntries(pluginIds.map((id) => [id, { enabled: true }])),
      },
      tools: { allow: ["steady_probe", "reloaded_probe"] },
    };
    const instances: PluginInstanceHandle[] = [];
    const loadGeneration = () => {
      const generation = withPluginCache(createPluginCache(), () => {
        const metadataSnapshot = resolvePluginMetadataSnapshot({ config, workspaceDir });
        const pluginRegistry = loadPluginRegistryHandle({
          config,
          workspaceDir,
          manifestRegistry: metadataSnapshot.manifestRegistry,
          onlyPluginIds: pluginIds,
        });
        const record = pluginRegistry.plugins.find((plugin) => plugin.id === "reloaded-probe");
        const reloaded = expectDefined(record && getPluginInstance(record), "plugin instance");
        for (const plugin of pluginRegistry.plugins) {
          const instance = getPluginInstance(plugin);
          if (instance) {
            instances.push(instance);
          }
        }
        return { pluginRegistry, metadataSnapshot, reloaded };
      });
      setActivePluginRegistry(generation.pluginRegistry);
      hooks.initializeGlobalHookRunner(generation.pluginRegistry);
      return generation;
    };
    const admissions: Array<{ close: () => unknown }> = [];

    await runQaGatewayFixture(
      async () => {
        vi.stubEnv("OPENCLAW_HOME", root);
        vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
        vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
        vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledDir);
        writeProbePlugin(bundledDir, "steady-probe", "steady_probe");
        writeProbePlugin(bundledDir, "reloaded-probe", "reloaded_probe");
        configSnapshot.setRuntimeConfigSnapshot(config);
        const original = loadGeneration();
        await withPluginRuntimeGenerationScope(original, ensureMcpLoopbackServer);
        const runtime = mcp.runtime();
        const admission = mcp.prepareAdmission("generation-run", "mcp-generation-proof");
        admissions.push(admission);
        const admittedRunContext = await admission.admit("gateway", "gateway-generation-run");
        // A CLI run mints its grant inside the generation it started on and builds tools
        // under Cron management scope, so both happen in that generation's request scope.
        const grant = withPluginRuntimeGenerationScope(original, () =>
          mcp.captureGrant(
            {
              context: { sessionKey: "agent:main:generation-run", senderIsOwner: true },
              runtimeOwnerToken: runtime.ownerToken,
              admittedRunContext,
              toolPolicyConfig: config,
              withCronManagementToolConstruction: (run) => run(),
            },
            "capture-generation-run",
          ),
        );
        const callTool = async (name: string) =>
          await mcp.json(
            await mcp.request(runtime, mcp.toolCall(name), {
              token: grant.token,
              captureKey: grant.captureKey,
              sessionKey: "agent:main:generation-run",
              signal,
              connection: "close",
            }),
          );

        // One plugin reloads while the run continues; the run's generation retires.
        loadGeneration();
        await original.reloaded.dispose();

        // The unrelated plugin's tool and the reloaded plugin's tool both keep working,
        // and later requests stay on the published generation.
        for (const name of ["steady_probe", "reloaded_probe", "steady_probe"]) {
          expect(await callTool(name)).toMatchObject({
            result: { content: [{ type: "text", text: `${name} ok` }], isError: false },
          });
        }
      },
      ...[
        closeMcpLoopbackServer,
        () => Promise.all(admissions.map(async (admission) => await admission.close())),
        () => Promise.all(instances.map((instance) => instance.dispose())),
        () => resetPluginRuntimeStateForTest(),
        () => hooks.resetGlobalHookRunner(),
        () => configSnapshot.clearRuntimeConfigSnapshot(),
        () => vi.unstubAllEnvs(),
      ].map(
        (cleanup) => () =>
          fixtureLifetime.verifyCleanup(async () => {
            await Promise.resolve(cleanup());
          }),
      ),
    );
  }));
