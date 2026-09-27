import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { fingerprintOpaqueRuntimeOwner } from "../agents/execution-auth-binding.js";
import { getRegisteredAgentHarness } from "../agents/harness/registry.js";
import { loadAgentRuntimePluginRegistryHandle } from "../agents/runtime-plugins.js";
import { readConfigFileSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveSystemAgentConfiguredRouteFromConfig } from "./inference-route.js";
import { runSystemAgent } from "./system-agent.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";
import { createSystemAgentVerifiedInferenceBinding } from "./verified-inference.js";

it.each([false, true])(
  "owns the private harness until the conversation settles (throws: %s)",
  async (throws) => {
    await withOpenClawTestState(
      { label: "system-agent-harness", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        const id = "conversation-harness";
        const pluginDir = state.path(id);
        const nativeEvent = `system-agent-harness-native-${throws}`;
        const observationEvent = `system-agent-harness-observation-${throws}`;
        const before = process.listenerCount(nativeEvent);
        const events: string[] = [];
        const observe = (event: string) => events.push(event);
        await fs.mkdir(pluginDir);
        await fs.writeFile(
          path.join(pluginDir, "package.json"),
          JSON.stringify({
            name: id,
            version: "1.0.0",
            type: "commonjs",
            openclaw: { extensions: ["./index.cjs"] },
          }),
        );
        await fs.writeFile(
          path.join(pluginDir, "openclaw.plugin.json"),
          JSON.stringify({
            id,
            activation: { onAgentHarnesses: [id] },
            configSchema: { type: "object", properties: {}, additionalProperties: false },
          }),
        );
        await fs.writeFile(
          path.join(pluginDir, "index.cjs"),
          `
          const record = event => process.emit(${JSON.stringify(observationEvent)}, event);
          module.exports = { id: ${JSON.stringify(id)}, register(api) {
            record("register");
            const listener = () => {};
            process.on(${JSON.stringify(nativeEvent)}, listener);
            api.lifecycle.onDispose(() => {
              process.off(${JSON.stringify(nativeEvent)}, listener);
              record("dispose");
            });
            api.registerAgentHarness({
              id: ${JSON.stringify(id)}, label: "Synthetic private harness",
              supports() { record("supports"); return { supported: true }; },
              runAttempt() { throw new Error("Unexpected model request"); },
              runtimeArtifact: { validate(artifact) {
                record("validate");
                return artifact.id === "synthetic-artifact" && artifact.fingerprint === "synthetic-v1";
              } },
            });
          } };
        `,
        );
        const authoredConfig: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: state.workspaceDir,
              model: "synthetic-provider/proof",
              models: { "synthetic-provider/proof": { agentRuntime: { id } } },
            },
          },
          plugins: {
            allow: [id],
            load: { paths: [pluginDir] },
            slots: { memory: "none" },
            entries: { [id]: { enabled: true } },
          },
        };
        await state.writeConfig(authoredConfig);
        const snapshot = await readConfigFileSnapshot();
        expect(snapshot.valid).toBe(true);
        const config = snapshot.runtimeConfig ?? snapshot.config;
        const route = await resolveSystemAgentConfiguredRouteFromConfig(config);
        if (!route || route.runner !== "embedded") {
          throw new Error("Missing fixture route");
        }
        const binding = await (async () => {
          await using cache = createPluginCache();
          return await withPluginCache(cache, async () => {
            const registry = loadAgentRuntimePluginRegistryHandle({
              basePluginIds: [],
              config,
              workspaceDir: state.workspaceDir,
              selections: [
                {
                  provider: route.provider,
                  modelId: route.model,
                  runtime: id,
                  agentId: route.agentId,
                },
              ],
            });
            return await withPluginRuntimeRegistryScope(registry, () =>
              createSystemAgentVerifiedInferenceBinding({
                configuredRoute: route,
                executionRoute: route,
                auth: {
                  agentHarnessId: id,
                  runtimeOwnerKind: "plugin-harness",
                  runtimeOwnerId: id,
                  runtimeArtifactId: "synthetic-artifact",
                  runtimeArtifactFingerprint: "synthetic-v1",
                  runtimeOwnerFingerprint: fingerprintOpaqueRuntimeOwner({
                    kind: "plugin-harness",
                    runner: "embedded",
                    provider: route.provider,
                    backendId: id,
                    runtimeArtifactFingerprint: "synthetic-v1",
                  }),
                },
              }),
            );
          });
        })();
        expect(process.listenerCount(nativeEvent)).toBe(before);
        const started = createDeferredCore();
        const release = createDeferredCore();
        const terminalError = new Error("Conversation failed");
        const { runtime } = createSystemAgentTestRuntime();
        const input = Object.assign(new PassThrough(), { isTTY: true });
        const output = Object.assign(new PassThrough(), { isTTY: true });
        process.on(observationEvent, observe);
        const work = runSystemAgent(
          {
            verifiedInference: binding,
            input,
            output,
            runInteractiveTui: async () => {
              const harness = getRegisteredAgentHarness(id)?.harness;
              expect(harness?.supports({ provider: route.provider, requestedRuntime: id })).toEqual(
                { supported: true },
              );
              started.resolve();
              await release.promise;
              if (throws) {
                throw terminalError;
              }
            },
          },
          runtime,
        );
        const settled = work.then(
          () => undefined,
          (error: unknown) => error,
        );
        try {
          await Promise.race([started.promise, work]);
          expect(events).toEqual(["register", "validate", "supports"]);
          expect(process.listenerCount(nativeEvent)).toBe(before + 1);
          // Acquire outside the conversation context: chat must not retain the install lease.
          await withPluginLifecycleLease({ env: state.env, waitMs: 0 }, async (lease) =>
            lease.assertOwned(),
          );
          release.resolve();
          expect(await settled).toBe(throws ? terminalError : undefined);
          expect(events).toEqual(["register", "validate", "supports", "dispose"]);
          expect(process.listenerCount(nativeEvent)).toBe(before);
        } finally {
          release.resolve();
          await settled;
          input.destroy();
          output.destroy();
          process.off(observationEvent, observe);
        }
      },
    );
  },
);
