import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import {
  getPluginRegistryInspectionResources,
  PluginRegistryInspectionResources,
} from "../../plugins/registry-inspection-resources.js";
import { capturePluginLifecycleAuthority } from "../../plugins/registry-lifecycle.js";
import { createPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { resolveWidgetPresenters } from "../../plugins/widget-presenters.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resetRecentMediaGenerationDuplicateGuardsForTests } from "../media-generation-task-status-shared.test-support.js";
import { prepareConfiguredRuntimeFacts } from "../prepared-model-runtime.configured-catalog.js";
import { prepareWorkspaceBuildGroup } from "../prepared-model-runtime.facts.js";
import { createPreparedModelRuntimeSnapshot } from "../prepared-model-runtime.full-catalog.js";
import {
  closeEphemeralPreparedModelRuntimeResources,
  PreparedModelRuntimeBuildResources,
  retainPreparedModelRuntimeGenerationResources,
} from "../prepared-model-runtime.resources.js";
import { ModelRegistry } from "../sessions/model-registry.js";
import { createImageGenerateTool } from "./image-generate-tool.js";
import { imageGenerationTaskLifecycle as lifecycle } from "./media-generate-background.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQVDL+DwACFAFmBODefwAAAABJRU5ErkJggg==",
  "base64",
);

afterEach(() => {
  vi.restoreAllMocks();
  resetRecentMediaGenerationDuplicateGuardsForTests();
  clearPluginMetadataLifecycleCaches();
  resetPluginRuntimeStateForTest();
});

it.each(["managed", "failure", "primary-failure", "rollback", "raw"] as const)(
  "keeps copied donor resources through media and disposal (%s)",
  async (mode) => {
    await withOpenClawTestState(
      { prefix: "openclaw-media-donor-", layout: "split" },
      async (state) => {
        const id = "media-donor-fixture";
        const pluginRoot = state.path("plugin");
        fs.mkdirSync(pluginRoot, { recursive: true });
        fs.mkdirSync(state.agentDir(), { recursive: true });
        fs.mkdirSync(state.workspaceDir, { recursive: true });
        const key = `__media_donor_${path.basename(state.root)}`;
        const donorFile = state.path("donor.sqlite");
        const donorDb = new DatabaseSync(donorFile);
        donorDb.exec("CREATE TABLE answer(value INTEGER); INSERT INTO answer VALUES(42)");
        const admitted = createDeferredCore();
        const finishCallback = createDeferredCore();
        const primaryDisposal = createDeferredCore();
        const finishPrimary = createDeferredCore();
        const rollbackDisposal = createDeferredCore();
        const finishRollback = createDeferredCore();
        const donorDisposal = createDeferredCore();
        const finishDonor = createDeferredCore();
        const values: unknown[] = [];
        const connections: Array<{ file: string; db: DatabaseSync; disposals: number }> = [];
        const donorDispose = vi.fn(async () => {
          donorDisposal.resolve();
          donorDb.close();
          await finishDonor.promise;
          if (mode === "failure") {
            throw new Error("donor cleanup failed");
          }
        });
        const bridge = {
          png,
          failPrimary: mode === "primary-failure",
          connections,
          primaryDisposal,
          finishPrimary,
          values,
          readDonor: () => donorDb.prepare("SELECT value FROM answer").get()?.value,
          useDonor: async () => {
            const registration = resolveWidgetPresenters()[0];
            if (!registration) {
              throw new Error("Missing copied presenter");
            }
            return await registration.presenter.availability({});
          },
        };
        Object.defineProperty(globalThis, key, { configurable: true, value: bridge });
        const entry = path.join(pluginRoot, "index.cjs");
        fs.writeFileSync(
          path.join(pluginRoot, "package.json"),
          JSON.stringify({ name: id, version: "1.0.0", openclaw: { extensions: ["./index.cjs"] } }),
        );
        fs.writeFileSync(
          path.join(pluginRoot, "openclaw.plugin.json"),
          JSON.stringify({
            id,
            contracts: { imageGenerationProviders: [id] },
            configSchema: { type: "object" },
          }),
        );
        fs.writeFileSync(
          entry,
          `
const { DatabaseSync } = require('node:sqlite');
module.exports = { id: '${id}', register(api) {
  const state = globalThis[${JSON.stringify(key)}];
  const file = ${JSON.stringify(state.root)} + '/primary-' + state.connections.length + '.sqlite';
  const db = new DatabaseSync(file); db.exec('CREATE TABLE answer(value INTEGER); INSERT INTO answer VALUES(42)');
  const connection = { file, db, disposals: 0 }; state.connections.push(connection);
  api.lifecycle.registerRuntimeLifecycle({ id: 'primary', async dispose() {
    connection.disposals++; state.primaryDisposal.resolve(); await state.finishPrimary.promise;
    try {
      state.values.push(state.readDonor());
      if (state.failPrimary) throw new Error("primary cleanup failed");
    } finally { db.close(); }
  }});
  api.registerImageGenerationProvider({ id: '${id}', defaultModel: 'fixture-image', isConfigured: () => true,
    capabilities: { generate: { maxCount: 1 }, edit: { enabled: false, maxInputImages: 0 } },
    async generateImage() {
      await state.useDonor(); state.values.push(db.prepare('SELECT value FROM answer').get().value);
      return { images: [{ buffer: state.png, mimeType: 'image/png', fileName: 'donor-proof.png' }] };
    }
  });
}};
`,
        );
        const config: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: state.workspaceDir,
              mediaModels: { image: { primary: `${id}/fixture-image` } },
            },
          },
          plugins: { allow: [id], load: { paths: [pluginRoot] }, slots: { memory: "none" } },
        };
        await state.writeConfig(config);
        const donor = createPluginRegistry({
          runtime: createPluginRuntime(),
          logger: { info() {}, warn() {}, error() {}, debug() {} },
          activateGlobalSideEffects: false,
        });
        const donorSource = mode === "raw" ? undefined : new PluginRegistryInspectionResources();
        donorSource?.attach(donor.registry);
        const record = createPluginRecord({ id, source: entry });
        donor.registry.plugins.push(record);
        const api = donor.createApi(record, { config, registrationMode: "full" });
        const register = () => {
          api.lifecycle.registerRuntimeLifecycle({ id: "donor", dispose: donorDispose });
          api.registerWidgetPresenter({
            target: "node_panel",
            description: "Synthetic donor",
            availability: async () => {
              admitted.resolve();
              await finishCallback.promise;
              values.push(bridge.readDonor());
              return { ok: true, value: { available: true } };
            },
            present: async () => ({
              ok: false,
              error: { code: "unavailable", message: "Not used" },
            }),
          });
        };
        if (donorSource) {
          donorSource.runRegistration(id, register);
        } else {
          register();
        }
        setActivePluginRegistry(donor.registry);
        const donorCurrent = capturePluginLifecycleAuthority(donor.registry);
        const construction = new PreparedModelRuntimeBuildResources();
        let publication: ReturnType<typeof retainPreparedModelRuntimeGenerationResources>;
        let closeDonor: Promise<void> | undefined;
        let completion: Promise<void> | undefined;
        try {
          const prepared = await prepareWorkspaceBuildGroup(
            [
              {
                config,
                agentId: "main",
                agentDir: state.agentDir(),
                workspaceDir: state.workspaceDir,
                skipCredentials: true,
              },
            ],
            "static",
            { includeCredentialProviders: false, registryResources: construction },
          );
          if (mode === "rollback") {
            const source = getPluginRegistryInspectionResources(
              prepared.pluginGeneration.pluginRegistry!,
            )!;
            source.runRegistration("rolled-back", () => {
              source.register("rolled-back", {
                id: "cleanup",
                dispose: async () => {
                  rollbackDisposal.resolve();
                  await finishRollback.promise;
                  values.push(bridge.readDonor());
                  throw new Error("rollback cleanup failed");
                },
              });
            });
            source.rollback("rolled-back");
            await rollbackDisposal.promise;
          }
          publication = retainPreparedModelRuntimeGenerationResources(prepared.pluginGeneration);
          const facts = prepared.agentFacts[0]!;
          const catalog = prepareConfiguredRuntimeFacts({
            agentFacts: facts,
            workspaceFacts: prepared.pluginGeneration,
            templateModelRegistry: ModelRegistry.inMemory(facts.templateAuthStorage),
            configuredRuntimeModels: facts.configuredRuntimeModels,
          });
          const snapshot = createPreparedModelRuntimeSnapshot(
            undefined,
            facts,
            prepared.pluginGeneration,
            catalog,
            {
              isCurrent: () => true,
              withRefreshStatus: (value) => value,
              readFullModelCatalog: () => catalog.modelCatalog,
              loadFullModelCatalog: async () => catalog.modelCatalog,
              loadAuth: async () => {
                throw new Error("No model auth in this fixture");
              },
            },
          );
          const scheduled: Array<() => Promise<void>> = [];
          const sessionKey = "agent:main:discord:direct:donor-proof";
          vi.spyOn(lifecycle, "createTaskRun").mockReturnValue({
            taskId: "donor-task",
            runId: "donor-run",
            requesterSessionKey: sessionKey,
            requesterAgentId: "main",
            taskLabel: "Donor proof",
          });
          vi.spyOn(lifecycle, "recordTaskProgress").mockImplementation(() => {});
          const completed = vi.spyOn(lifecycle, "completeTaskRun").mockImplementation(() => {});
          const failed = vi.spyOn(lifecycle, "failTaskRun").mockImplementation(() => {});
          vi.spyOn(lifecycle, "wakeTaskCompletion").mockResolvedValue({ status: "delivered" });
          const tool = createImageGenerateTool({
            config,
            agentDir: state.agentDir(),
            workspaceDir: state.workspaceDir,
            preparedModelRuntime: snapshot,
            agentSessionKey: sessionKey,
            scheduleBackgroundWork: (work) => {
              scheduled.push(work);
            },
          });
          if (!tool) {
            throw new Error("Missing image tool");
          }
          expect(
            (await tool.execute("donor-call", { prompt: "A synthetic resource proof" })).details,
          ).toMatchObject({ status: "started" });
          completion = scheduled[0]!();
          await admitted.promise;
          construction.release();
          publication?.release();
          closeDonor = donorSource?.release();
          void closeDonor?.catch(() => {});
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect.soft(donorDb.isOpen).toBe(true);
          expect.soft(donorDispose).not.toHaveBeenCalled();
          if (donorSource) {
            expect(donorCurrent?.()).toBe(false);
          }
          expect(() => snapshot.acquireMediaCapabilityProviders?.()).toThrow(
            /provider setup changed/,
          );
          finishCallback.resolve();
          await Promise.race([
            primaryDisposal.promise,
            completion.then(() => {
              throw new Error("Media work ended without primary disposal");
            }),
          ]);
          expect.soft(donorDb.isOpen).toBe(true);
          finishPrimary.resolve();
          if (mode === "rollback") {
            await new Promise<void>((resolve) => {
              setImmediate(resolve);
            });
            expect(donorDb.isOpen).toBe(true);
            expect(donorDispose).not.toHaveBeenCalled();
            expect(completed).not.toHaveBeenCalled();
            finishRollback.resolve();
          }
          if (donorSource) {
            await donorDisposal.promise;
            expect(completed).not.toHaveBeenCalled();
            expect(failed).not.toHaveBeenCalled();
          }
          finishDonor.resolve();
          await completion;
          await closeDonor?.catch(() => {});
          expect(values).toEqual(mode === "rollback" ? [42, 42, 42, 42] : [42, 42, 42]);
          if (mode === "rollback") {
            await expect(closeEphemeralPreparedModelRuntimeResources()).rejects.toMatchObject({
              errors: [
                expect.objectContaining({
                  errors: [
                    expect.objectContaining({
                      cause: expect.objectContaining({ message: "rollback cleanup failed" }),
                    }),
                  ],
                }),
              ],
            });
            await expect(closeEphemeralPreparedModelRuntimeResources()).resolves.toBeUndefined();
          }
          expect(connections).toHaveLength(1);
          expect(connections[0]?.disposals).toBe(1);
          expect(donorDispose).toHaveBeenCalledTimes(donorSource ? 1 : 0);
          const disposalFailed = mode === "failure" || mode === "primary-failure";
          expect(failed).toHaveBeenCalledTimes(disposalFailed ? 1 : 0);
          expect(completed).toHaveBeenCalledTimes(disposalFailed ? 0 : 1);
          for (const file of [connections[0]!.file, donorFile]) {
            const db = new DatabaseSync(file, { readOnly: true });
            try {
              expect(db.prepare("SELECT value FROM answer").get()?.value).toBe(42);
            } finally {
              db.close();
            }
          }
        } finally {
          finishCallback.resolve();
          finishRollback.resolve();
          finishPrimary.resolve();
          finishDonor.resolve();
          await completion;
          construction.release();
          publication?.release();
          await closeDonor?.catch(() => {});
          await donorSource?.release().catch(() => {});
          await closeEphemeralPreparedModelRuntimeResources().catch(() => {});
          for (const connection of connections) {
            if (connection.db.isOpen) {
              connection.db.close();
            }
          }
          if (donorDb.isOpen) {
            donorDb.close();
          }
          Reflect.deleteProperty(globalThis, key);
        }
      },
    );
  },
);
