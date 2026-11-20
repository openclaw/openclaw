import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { writeJsonFile } from "../../../test/helpers/temp-repo.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { collectErrorGraphCandidates } from "../../infra/errors.js";
import * as inspection from "../../plugins/registry-inspection-resources.js";
import { retireInspectionInstances } from "../../plugins/registry-inspection.test-support.js";
import { capturePluginLifecycleAuthority } from "../../plugins/registry-lifecycle.js";
import { createPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { resolveWidgetPresenters } from "../../plugins/widget-presenters.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createEnteredGate } from "../entered-gate.test-support.js";
import { prepareWorkspaceBuildGroup } from "../prepared-model-runtime.facts.js";
import { closePreparedModelRuntimeSnapshots } from "../prepared-model-runtime.lifecycle.js";
import {
  retainPreparedPluginGeneration,
  retainPreparedPluginRegistry,
} from "../prepared-model-runtime.plugin-lifetime.js";
import * as resources from "../prepared-model-runtime.resources.js";
import { createImageGenerateTool } from "./image-generate-tool.js";
import { imageGenerationTaskLifecycle as lifecycle } from "./media-generate-background.js";
import * as media from "./media-resource-fixtures.test-support.js";

const png = createSolidPngBuffer(1, 1, { r: 0, g: 0, b: 0 });

afterEach(() => {
  media.reset();
  resetPluginRuntimeStateForTest();
});

it.each(["managed", "failure", "primary-failure", "rollback", "raw"] as const)(
  "keeps copied donor resources through media and disposal (%s)",
  (mode) =>
    withOpenClawTestState({ prefix: "openclaw-media-donor-", layout: "split" }, async (state) => {
      const id = "media-donor-fixture";
      const pluginRoot = state.path("plugin");
      fs.mkdirSync(state.agentDir(), { recursive: true });
      const key = `__media_donor_${path.basename(state.root)}`;
      const donorFile = state.path("donor.sqlite");
      using donorDb = new DatabaseSync(donorFile);
      donorDb.exec("CREATE TABLE answer(value INTEGER); INSERT INTO answer VALUES(42)");
      const callback = createEnteredGate();
      const primary = createEnteredGate();
      const rollback = createEnteredGate();
      const rollbackFailure = new Error("rollback cleanup failed");
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
        primary,
        values,
        readDonor: () => donorDb.prepare("SELECT value FROM answer").get()?.value,
        useDonor: async () => {
          const registration = resolveWidgetPresenters()[0];
          assert(registration, "Missing copied presenter");
          return await registration.presenter.availability({});
        },
      };
      Object.defineProperty(globalThis, key, { configurable: true, value: bridge });
      const entry = path.join(pluginRoot, "index.cjs");
      writeJsonFile(path.join(pluginRoot, "package.json"), {
        name: id,
        version: "1.0.0",
        openclaw: { extensions: ["./index.cjs"] },
      });
      writeJsonFile(path.join(pluginRoot, "openclaw.plugin.json"), {
        id,
        contracts: { imageGenerationProviders: [id] },
        configSchema: { type: "object" },
      });
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
    connection.disposals++; await state.primary.wait();
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
      const donorSource =
        mode === "raw"
          ? undefined
          : new inspection.PluginRegistryInspectionResources(retireInspectionInstances);
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
            await callback.wait();
            values.push(bridge.readDonor());
            return { ok: true, value: { available: true } };
          },
          present: async () => ({ ok: false, error: { code: "unavailable", message: "Not used" } }),
        });
      };
      if (donorSource) {
        donorSource.runRegistration(id, register);
      } else {
        register();
      }
      setActivePluginRegistry(donor.registry);
      const donorCurrent = capturePluginLifecycleAuthority(donor.registry);
      const construction = new resources.PreparedModelRuntimeBuildResources(
        retainPreparedPluginRegistry,
      );
      let releasePublication: ReturnType<typeof retainPreparedPluginGeneration> | undefined;
      let releasingOwners: Promise<PromiseSettledResult<void>[]> | undefined;
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
          {
            includeCredentialProviders: false,
            registryResources: construction,
            loadRuntimeRegistry: construction.load.bind(construction),
          },
        );
        if (mode === "rollback") {
          const source = inspection.getPluginRegistryInspectionResources(
            prepared.pluginGeneration.pluginRegistry!,
          )!;
          source.runRegistration("rolled-back", () => {
            source.register("rolled-back", {
              id: "cleanup",
              dispose: async () => {
                await rollback.wait();
                values.push(bridge.readDonor());
                throw rollbackFailure;
              },
            });
          });
          source.rollback("rolled-back");
          await rollback.entered;
        }
        releasePublication = retainPreparedPluginGeneration(prepared.pluginGeneration);
        const snapshot = media.snapshot(prepared);
        const sessionKey = "agent:main:discord:direct:donor-proof";
        const { completed, failed, settlement } = media.admitTask(lifecycle, sessionKey);
        const tool = createImageGenerateTool({
          config,
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          preparedModelRuntime: snapshot,
          agentSessionKey: sessionKey,
        });
        assert(tool, "Missing image tool");
        const started = await tool.execute("donor-call", { prompt: "A synthetic resource proof" });
        completion = settlement.wait().then(() => {});
        expect(started.details).toMatchObject({ status: "started" });
        await awaitGateBeforeSettlement(
          callback.entered,
          completion,
          "Media work settled before the expected phase",
        );
        releasingOwners = Promise.allSettled([
          construction[Symbol.asyncDispose](),
          releasePublication?.(),
        ]);
        closeDonor = donorSource?.release();
        void closeDonor?.catch(() => {});
        await setImmediate();
        expect.soft(donorDb.isOpen).toBe(true);
        expect.soft(donorDispose).not.toHaveBeenCalled();
        if (donorSource) {
          expect(donorCurrent?.()).toBe(false);
        }
        expect(() => snapshot.acquireMediaCapabilityProviders?.()).toThrow(
          /provider setup changed/,
        );
        callback.release();
        await awaitGateBeforeSettlement(
          primary.entered,
          completion,
          "Media work settled before the expected phase",
        );
        expect.soft(donorDb.isOpen).toBe(true);
        primary.release();
        if (mode === "rollback") {
          await setImmediate();
          expect(donorDb.isOpen).toBe(true);
          expect(donorDispose).not.toHaveBeenCalled();
          expect(completed).not.toHaveBeenCalled();
          rollback.release();
        }
        if (donorSource) {
          await donorDisposal.promise;
          expect(completed).not.toHaveBeenCalled();
          expect(failed).not.toHaveBeenCalled();
        }
        finishDonor.resolve();
        await completion;
        await releasingOwners;
        await closeDonor?.catch(() => {});
        expect(values).toEqual(mode === "rollback" ? [42, 42, 42, 42] : [42, 42, 42]);
        if (mode === "rollback") {
          const observed = resources.closeEphemeralPreparedModelRuntimeResources();
          await expect(observed).rejects.toBeInstanceOf(AggregateError);
          const failure: unknown = await observed.catch((error: unknown) => error);
          expect(
            collectErrorGraphCandidates(failure, (candidate) => [
              candidate.cause,
              ...(Array.isArray(candidate.errors) ? candidate.errors : []),
            ]),
          ).toContain(rollbackFailure);
          await expect(
            resources.closeEphemeralPreparedModelRuntimeResources(),
          ).resolves.toBeUndefined();
          await expect(closePreparedModelRuntimeSnapshots()).resolves.toBeUndefined();
        }
        expect(connections).toMatchObject([{ disposals: 1 }]);
        expect(donorDispose).toHaveBeenCalledTimes(donorSource ? 1 : 0);
        const disposalFailed = mode === "failure" || mode === "primary-failure";
        expect(failed).toHaveBeenCalledTimes(disposalFailed ? 1 : 0);
        expect(completed).toHaveBeenCalledTimes(disposalFailed ? 0 : 1);
        for (const file of [connections[0]!.file, donorFile]) {
          using db = new DatabaseSync(file, { readOnly: true });
          expect(db.prepare("SELECT value FROM answer").get()?.value).toBe(42);
        }
      } finally {
        callback.release();
        rollback.release();
        primary.release();
        finishDonor.resolve();
        await completion;
        await releasingOwners;
        await Promise.allSettled([construction[Symbol.asyncDispose](), releasePublication?.()]);
        await closeDonor?.catch(() => {});
        await donorSource?.release().catch(() => {});
        await resources.closeEphemeralPreparedModelRuntimeResources().catch(() => {});
        for (const connection of connections) {
          if (connection.db.isOpen) {
            connection.db.close();
          }
        }
        Reflect.deleteProperty(globalThis, key);
      }
    }),
);
