import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createContextEngineLogicalTurnLease } from "../agents/harness/context-engine-logical-turn.js";
import { acquireAgentRunPreparedModelRuntime } from "../agents/prepared-model-runtime.js";
import { closePreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.lifecycle.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withPluginMetadataSnapshotScope } from "./current-plugin-metadata-snapshot.js";
import { loadAndActivateRootPluginRegistry } from "./loader.js";
import { resetPluginCache, waitForPluginCacheRetirement } from "./plugin-cache.js";
import { getPluginSetupModuleLoader } from "./plugin-setup-module.js";
import { verifyPreparedModelGenerationCleanup } from "./prepared-model-generation.retirement.test-support.js";
import { clearActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";

it.each(["standalone reset", "shared runtime projection"] as const)(
  "keeps admitted model callbacks and lazy setup facts through %s",
  async (retirement) => {
    await withOpenClawTestState({ label: "prepared-plugin-lifetime" }, async (state) => {
      await closePreparedModelRuntimeSnapshots();
      resetPluginCache();
      await waitForPluginCacheRetirement();
      const id = "prepared-generation-probe";
      const event = `${id}-${path.basename(state.root)}`;
      const root = state.path("plugin");
      const disposed = state.path("disposed.txt");
      fs.mkdirSync(root);
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({
          name: id,
          version: "1.0.0",
          type: "module",
          openclaw: { extensions: ["./index.ts"] },
        }),
      );
      fs.writeFileSync(
        path.join(root, "openclaw.plugin.json"),
        JSON.stringify({
          id,
          configSchema: { type: "object", properties: {} },
        }),
      );
      fs.writeFileSync(
        path.join(root, "index.ts"),
        `
        import fs from "node:fs";
        export default { id: ${JSON.stringify(id)}, register(api) {
          const listener = () => {};
          process.on(${JSON.stringify(event)}, listener);
          api.lifecycle.onDispose(() => {
            process.off(${JSON.stringify(event)}, listener);
            fs.appendFileSync(${JSON.stringify(disposed)}, "disposed\\n");
          });
          if (api.registrationMode === "full") api.registerContextEngine(${JSON.stringify(id)}, () => ({
            info: { id: ${JSON.stringify(id)}, name: "Prepared fixture" },
            async ingest() { return { ingested: false }; },
            async assemble({ messages }) { return { messages, estimatedTokens: 0 }; },
            async compact() { return { ok: true, compacted: false }; },
          }));
          api.registerService({
            get id() { api.lifecycle.signal.throwIfAborted(); return "retained-service"; },
            start() {}, stop() {},
          });
        } };
      `,
      );
      const setupEntry = path.join(root, "setup.ts");
      fs.writeFileSync(setupEntry, 'export const read = () => "captured setup";');
      const config: OpenClawConfig = {
        agents: { defaults: { workspace: state.workspaceDir, model: "fixture/local" } },
        models: {
          providers: {
            fixture: {
              api: "openai-responses",
              baseUrl: "http://127.0.0.1:1/v1",
              models: [
                {
                  id: "local",
                  name: "Local",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  maxTokens: 1024,
                },
              ],
            },
          },
        },
        plugins: {
          enabled: true,
          allow: [id],
          load: { paths: [root] },
          entries: { [id]: { enabled: true } },
          slots: {
            memory: "none",
            ...(retirement === "shared runtime projection" ? { contextEngine: id } : {}),
          },
        },
      };
      await state.writeConfig(config);
      const originalListeners = process.listenerCount(event);
      if (retirement === "shared runtime projection") {
        loadAndActivateRootPluginRegistry({
          config,
          env: state.env,
          workspaceDir: state.workspaceDir,
          cache: false,
        });
      }
      const before = process.listenerCount(event);
      let lease: Awaited<ReturnType<typeof acquireAgentRunPreparedModelRuntime>> | undefined;
      let service: import("./types.js").OpenClawPluginService | undefined;
      let peer: typeof lease;
      try {
        lease = await acquireAgentRunPreparedModelRuntime({
          config,
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          env: state.env,
          skipCredentials: true,
        });
        const metadata = lease.snapshot.metadataSnapshot;
        const registry = lease.snapshot.pluginRegistry;
        expect(registry?.plugins, JSON.stringify(registry?.diagnostics)).toContainEqual(
          expect.objectContaining({ id, status: "loaded" }),
        );
        service = registry?.services.find((entry) => entry.pluginId === id)?.service;
        expect(service?.id).toBe("retained-service");
        expect(process.listenerCount(event)).toBe(before + 1);
        const record = metadata.manifestRegistry.plugins.find((entry) => entry.id === id);
        if (!record) {
          throw new Error("fixture metadata missing");
        }
        const loadSetup = () =>
          withPluginMetadataSnapshotScope(metadata, () => {
            const load = getPluginSetupModuleLoader(record, setupEntry, root);
            return load.initialize(() => load(setupEntry));
          });
        if (retirement === "standalone reset") {
          resetPluginCache();
          await waitForPluginCacheRetirement();
        } else {
          peer = await acquireAgentRunPreparedModelRuntime({
            config,
            agentDir: state.agentDir("peer"),
            workspaceDir: state.workspaceDir,
            env: state.env,
            skipCredentials: true,
          });
          expect(peer.snapshot.pluginRegistry?.contextEngines.get(id)?.lifecycle).toBe("runtime");
          const peerService = peer.snapshot.pluginRegistry?.services.find(
            (entry) => entry.pluginId === id,
          )?.service;
          expect(peerService?.id).toBe("retained-service");
          expect(process.listenerCount(event)).toBe(before + 2);
          await peer[Symbol.asyncDispose]();
          expect(() => peerService?.id).toThrow(/reloaded|disabled|retir/);
          if (!registry) {
            throw new Error("prepared registry missing");
          }
          await withPluginRuntimeRegistryScope(registry, async () => {
            const turn = await createContextEngineLogicalTurnLease({
              identity: { runId: "retained-run", sessionId: "retained-session" },
              config,
              workspaceDir: state.workspaceDir,
            });
            try {
              expect(turn.effectiveEngineId).toBe(id);
              await expect(
                turn.begin().engine.assemble({ messages: [], sessionId: "retained-session" }),
              ).resolves.toMatchObject({ messages: [], estimatedTokens: 0 });
            } finally {
              await turn.dispose();
            }
          });
        }
        expect(service?.id).toBe("retained-service");
        expect(process.listenerCount(event)).toBe(before + 1);
        expect(fs.existsSync(disposed)).toBe(retirement === "shared runtime projection");
        if (retirement === "shared runtime projection") {
          expect(fs.readFileSync(disposed, "utf8")).toBe("disposed\n");
        }
        const module = loadSetup();
        if (
          !module ||
          typeof module !== "object" ||
          !("read" in module) ||
          typeof module.read !== "function"
        ) {
          throw new Error("fixture setup export missing");
        }
        expect(module.read()).toBe("captured setup");
      } finally {
        await peer?.[Symbol.asyncDispose]();
        await lease?.[Symbol.asyncDispose]();
        await closePreparedModelRuntimeSnapshots();
        await waitForPluginCacheRetirement(true);
        if (retirement === "shared runtime projection") {
          await clearActivePluginRegistry();
        }
      }
      expect(process.listenerCount(event)).toBe(originalListeners);
      expect(fs.readFileSync(disposed, "utf8")).toBe(
        retirement === "shared runtime projection"
          ? "disposed\ndisposed\ndisposed\n"
          : "disposed\n",
      );
      expect(() => service?.id).toThrow(/reloaded|disabled|retir/);
    });
  },
);

it.each(["publication", "arrivals"] as const)(
  "preserves generation cleanup observations without global failure: %s",
  verifyPreparedModelGenerationCleanup,
  40_000,
);
