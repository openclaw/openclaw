import assert from "node:assert/strict";
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
import {
  generationModels,
  verifyPreparedModelGenerationCleanup,
} from "./prepared-model-generation.retirement.test-support.js";
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
      const shared = retirement === "shared runtime projection";
      const writeJson = (name: string, value: unknown) =>
        fs.writeFileSync(path.join(root, name), JSON.stringify(value));
      fs.mkdirSync(root);
      writeJson("package.json", {
        name: id,
        version: "1.0.0",
        type: "module",
        openclaw: { extensions: ["./index.ts"] },
      });
      writeJson("openclaw.plugin.json", {
        id,
        configSchema: { type: "object", properties: {} },
      });
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
        models: generationModels("fixture"),
        plugins: {
          enabled: true,
          allow: [id],
          load: { paths: [root] },
          entries: { [id]: { enabled: true } },
          slots: {
            memory: "none",
            ...(shared ? { contextEngine: id } : {}),
          },
        },
      };
      await state.writeConfig(config);
      const originalListeners = process.listenerCount(event);
      const scope = { config, env: state.env, workspaceDir: state.workspaceDir };
      const acquire = (agentId?: string) =>
        acquireAgentRunPreparedModelRuntime({
          ...scope,
          agentDir: state.agentDir(agentId),
          skipCredentials: true,
        });
      if (shared) {
        await loadAndActivateRootPluginRegistry({ ...scope, cache: false });
      }
      const before = process.listenerCount(event);
      let service:
        | Parameters<import("./types.js").OpenClawPluginApi["registerService"]>[0]
        | undefined;
      try {
        await using lease = await acquire();
        const metadata = lease.snapshot.metadataSnapshot;
        const registry = lease.snapshot.pluginRegistry;
        service = registry?.services.find((entry) => entry.pluginId === id)?.service;
        expect(service?.id).toBe("retained-service");
        expect(process.listenerCount(event)).toBe(before + 1);
        const record = metadata.manifestRegistry.plugins.find((entry) => entry.id === id);
        assert.ok(record, "fixture metadata missing");
        const loadSetup = () =>
          withPluginMetadataSnapshotScope(metadata, () => {
            const load = getPluginSetupModuleLoader(record, setupEntry, root);
            return load.initialize(() => load(setupEntry));
          });
        if (retirement === "standalone reset") {
          resetPluginCache();
          await waitForPluginCacheRetirement();
        } else {
          await using peer = await acquire("peer");
          const peerService = peer.snapshot.pluginRegistry?.services.find(
            (entry) => entry.pluginId === id,
          )?.service;
          expect(peerService?.id).toBe("retained-service");
          expect(process.listenerCount(event)).toBe(before + 2);
          await peer[Symbol.asyncDispose]();
          expect(() => peerService?.id).toThrow(/reloaded|disabled|retir/);
          assert.ok(registry, "prepared registry missing");
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
        expect(fs.existsSync(disposed)).toBe(shared);
        if (shared) {
          expect(fs.readFileSync(disposed, "utf8")).toBe("disposed\n");
        }
        const module = loadSetup();
        assert.ok(module && typeof module === "object" && "read" in module);
        assert.ok(typeof module.read === "function");
        expect(module.read()).toBe("captured setup");
      } finally {
        await closePreparedModelRuntimeSnapshots();
        await waitForPluginCacheRetirement(true);
        if (shared) {
          await clearActivePluginRegistry();
        }
      }
      expect(process.listenerCount(event)).toBe(originalListeners);
      expect(fs.readFileSync(disposed, "utf8")).toBe(
        shared ? "disposed\ndisposed\ndisposed\n" : "disposed\n",
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
