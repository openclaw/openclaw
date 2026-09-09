import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as mediaStore from "../../media/store.js";
import * as webMedia from "../../media/web-media.js";
import { acquirePluginRegistryForInspection } from "../../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { resetRecentMediaGenerationDuplicateGuardsForTests } from "../media-generation-task-status-shared.test-support.js";
import { prepareConfiguredRuntimeFacts } from "../prepared-model-runtime.configured-catalog.js";
import { prepareWorkspaceBuildGroup } from "../prepared-model-runtime.facts.js";
import { createPreparedModelRuntimeSnapshot } from "../prepared-model-runtime.full-catalog.js";
import { ModelRegistry } from "../sessions/model-registry.js";
import { createImageGenerateTool } from "./image-generate-tool.js";
import { imageGenerationTaskLifecycle } from "./media-generate-background.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQVDL+DwACFAFmBODefwAAAABJRU5ErkJggg==",
  "base64",
);

function createNativeFixture(edit = false) {
  const dir = makePluginLoaderTempDir();
  const key = `__openclaw_prepared_image_${path.basename(dir)}`;
  const connections: Array<{
    database: DatabaseSync;
    disposals: number;
    generated: number;
    projected: number;
  }> = [];
  const generated = createDeferredCore();
  const resumeGeneration = createDeferredCore();
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: { connections, generated, resumeGeneration, png },
  });
  const id = "prepared-image-resource";
  const plugin = writePlugin({
    dir,
    id,
    body: `const { DatabaseSync } = require("node:sqlite");
module.exports = {
  id: ${JSON.stringify(id)},
  register(api) {
    const state = globalThis[${JSON.stringify(key)}];
    const database = new DatabaseSync(":memory:");
    const connection = { database, disposals: 0, generated: 0, projected: 0 };
    state.connections.push(connection);
    const read = () => database.prepare("SELECT 42 AS value").get().value;
    api.lifecycle.registerRuntimeLifecycle({
      id: "prepared-image-database",
      dispose() {
        read();
        connection.disposals++;
        database.close();
      },
    });
    api.registerImageGenerationProvider({
      id: ${JSON.stringify(id)},
      defaultModel: "fixture-image",
      isConfigured() { return read() === 42; },
      capabilities: { generate: { maxCount: 2 }, edit: { enabled: ${edit}, maxInputImages: ${edit ? 1 : 0} } },
      async generateImage(request) {
        read();
        connection.generated++;
        state.generated.resolve();
        await state.resumeGeneration.promise;
        read();
        return {
          images: Array.from({ length: request.count ?? 1 }, (_, index) => ({
            buffer: state.png,
            mimeType: "image/png",
            fileName: "native-" + index + ".png",
            get revisedPrompt() {
              connection.projected++;
              return "native value " + read();
            },
          })),
        };
      },
    });
  },
};`,
  });
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      contracts: { imageGenerationProviders: [id] },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  const config: OpenClawConfig = {
    agents: { defaults: { mediaModels: { image: { primary: `${id}/fixture-image` } } } },
    plugins: { allow: [id], load: { paths: [plugin.file] }, slots: { memory: "none" } },
  };
  return {
    dir,
    config,
    connections,
    generated,
    resumeGeneration,
    withEnvironment: (run: () => Promise<void>) =>
      withEnvAsync(
        {
          OPENCLAW_HOME: dir,
          OPENCLAW_STATE_DIR: dir,
          OPENCLAW_CONFIG_PATH: path.join(dir, "config.json"),
        },
        run,
      ),
    cleanup() {
      resumeGeneration.resolve();
      for (const { database } of connections) {
        if (database.isOpen) {
          database.close();
        }
      }
      Reflect.deleteProperty(globalThis, key);
    },
  };
}

async function prepareSnapshot(
  fixture: ReturnType<typeof createNativeFixture>,
  registry: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>>["registry"],
) {
  const prepared = await prepareWorkspaceBuildGroup(
    [
      {
        agentId: "main",
        agentDir: path.join(fixture.dir, "agent"),
        workspaceDir: fixture.dir,
        config: fixture.config,
        skipCredentials: true,
      },
    ],
    "static",
    { includeCredentialProviders: false },
    () => registry,
  );
  const facts = prepared.agentFacts[0]!;
  const catalog = prepareConfiguredRuntimeFacts({
    agentFacts: facts,
    workspaceFacts: prepared.pluginGeneration,
    templateModelRegistry: ModelRegistry.inMemory(facts.templateAuthStorage),
    configuredRuntimeModels: facts.configuredRuntimeModels,
  });
  return createPreparedModelRuntimeSnapshot(undefined, facts, prepared.pluginGeneration, catalog, {
    isCurrent: () => true,
    withRefreshStatus: (value) => value,
    readFullModelCatalog: () => catalog.modelCatalog,
    loadFullModelCatalog: async () => catalog.modelCatalog,
    loadAuth: async () => {
      throw new Error("The synthetic image provider does not request model credentials");
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  resetRecentMediaGenerationDuplicateGuardsForTests();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

describe("prepared image job registration resources", () => {
  it("refuses new paid admission when the prepared owner releases during reference loading", async () => {
    const fixture = createNativeFixture(true);
    const referenceStarted = createDeferredCore();
    const resumeReference = createDeferredCore();
    try {
      await fixture.withEnvironment(async () => {
        useNoBundledPlugins();
        const first = await acquirePluginRegistryForInspection({ config: fixture.config });
        const referencePath = path.join(fixture.dir, "reference.png");
        fs.writeFileSync(referencePath, png);
        const snapshot = await prepareSnapshot(fixture, first.registry);
        const createTask = vi.spyOn(imageGenerationTaskLifecycle, "createTaskRun").mockReturnValue({
          taskId: "preflight-image-task",
          runId: "preflight-image-run",
          requesterSessionKey: "agent:main:discord:direct:synthetic-image",
          taskLabel: "Synthetic image edit",
        });
        const schedule = vi.fn();
        const loadReference = webMedia.loadWebMedia;
        vi.spyOn(webMedia, "loadWebMedia").mockImplementation(async (...args) => {
          referenceStarted.resolve();
          await resumeReference.promise;
          return loadReference(...args);
        });
        const tool = createImageGenerateTool({
          config: fixture.config,
          agentDir: snapshot.agentDir,
          workspaceDir: fixture.dir,
          preparedModelRuntime: snapshot,
          agentSessionKey: "agent:main:discord:direct:synthetic-image",
          scheduleBackgroundWork: schedule,
        });
        const outcome = tool!
          .execute("preflight-image-call", { prompt: "Synthetic image edit", image: referencePath })
          .then(
            (value) => ({ value, error: undefined }),
            (error: unknown) => ({ value: undefined, error }),
          );
        try {
          await Promise.race([
            referenceStarted.promise,
            outcome.then(() => {
              throw new Error("Image preflight settled before reading its reference");
            }),
          ]);
          await first.release();
          resumeReference.resolve();
          const result = await outcome;
          expect(result.error).toBeInstanceOf(Error);
          expect(result.value).toBeUndefined();
          expect(createTask).not.toHaveBeenCalled();
          expect(schedule).not.toHaveBeenCalled();
          expect(fixture.connections[0]!.generated).toBe(0);
          expect(fixture.connections[0]!.database.isOpen).toBe(false);
          expect(fixture.connections[0]!.disposals).toBe(1);
        } finally {
          resumeReference.resolve();
          await outcome;
          await first.release();
        }
      });
    } finally {
      fixture.cleanup();
    }
  });

  it.each(["queued", "saving", "rollback"] as const)(
    "retains the admitted provider through %s after its parent releases",
    async (phase) => {
      const fixture = createNativeFixture();
      const saveStarted = createDeferredCore();
      const resumeSave = createDeferredCore();
      const rollbackStarted = createDeferredCore();
      const resumeRollback = createDeferredCore();
      const scheduled: Array<() => Promise<void>> = [];
      let completion: Promise<void> | undefined;
      try {
        await fixture.withEnvironment(async () => {
          useNoBundledPlugins();
          const first = await acquirePluginRegistryForInspection({ config: fixture.config });
          let successor: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
          try {
            const snapshot = await prepareSnapshot(fixture, first.registry);
            expect(snapshot.mediaCapabilityProviders?.imageGenerationProviders).toHaveLength(1);
            const connection = fixture.connections[0]!;
            const sessionKey = "agent:main:discord:direct:synthetic-image";
            vi.spyOn(imageGenerationTaskLifecycle, "createTaskRun").mockReturnValue({
              taskId: "image-resource-task",
              runId: "image-resource-run",
              requesterSessionKey: sessionKey,
              requesterAgentId: "main",
              taskLabel: "Synthetic image resource proof",
            });
            vi.spyOn(imageGenerationTaskLifecycle, "recordTaskProgress").mockImplementation(
              () => {},
            );
            const completed = vi
              .spyOn(imageGenerationTaskLifecycle, "completeTaskRun")
              .mockImplementation(() => {});
            const failed = vi
              .spyOn(imageGenerationTaskLifecycle, "failTaskRun")
              .mockImplementation(() => {});
            vi.spyOn(imageGenerationTaskLifecycle, "wakeTaskCompletion").mockResolvedValue({
              status: "delivered",
            });
            const save = mediaStore.saveMediaBuffer;
            const remove = mediaStore.deleteMediaBuffer;
            let saveCalls = 0;
            let savedPath: string | undefined;
            vi.spyOn(mediaStore, "saveMediaBuffer").mockImplementation(async (...args) => {
              saveCalls++;
              if (phase === "rollback" && saveCalls === 1) {
                throw new Error("synthetic first image persistence failure");
              }
              saveStarted.resolve();
              await resumeSave.promise;
              const saved = await save(...args);
              savedPath = saved.path;
              return saved;
            });
            vi.spyOn(mediaStore, "deleteMediaBuffer").mockImplementation(async (...args) => {
              rollbackStarted.resolve();
              await resumeRollback.promise;
              return remove(...args);
            });
            const tool = createImageGenerateTool({
              config: fixture.config,
              agentDir: snapshot.agentDir,
              workspaceDir: fixture.dir,
              preparedModelRuntime: snapshot,
              agentSessionKey: sessionKey,
              scheduleBackgroundWork: (work) => scheduled.push(work),
            });
            expect(tool).not.toBeNull();
            const started = await tool!.execute("image-resource-call", {
              prompt: "Synthetic image resource proof",
              count: phase === "rollback" ? 2 : 1,
            });
            expect(started.details).toMatchObject({ status: "started" });
            expect(scheduled).toHaveLength(1);
            expect(connection.generated).toBe(0);
            if (phase === "queued") {
              await first.release();
            }
            successor = await acquirePluginRegistryForInspection({ config: fixture.config });
            setActivePluginRegistry(successor.registry);
            expect(fixture.connections).toHaveLength(2);
            if (phase === "queued") {
              expect(connection.database.isOpen).toBe(true);
            }
            completion = scheduled[0]!();
            await Promise.race([
              fixture.generated.promise,
              completion.then(() => {
                throw new Error("Image task settled without invoking its prepared provider");
              }),
            ]);
            fixture.resumeGeneration.resolve();
            await Promise.race([
              saveStarted.promise,
              completion.then(() => {
                throw new Error("Image task settled before persisting its output");
              }),
            ]);
            await first.release();
            expect(connection.database.isOpen).toBe(true);
            expect(connection.disposals).toBe(0);
            expect(fixture.connections[1]!.generated).toBe(0);
            resumeSave.resolve();
            if (phase === "rollback") {
              await rollbackStarted.promise;
              expect(connection.database.isOpen).toBe(true);
              expect(savedPath && fs.existsSync(savedPath)).toBe(true);
              resumeRollback.resolve();
            }
            await completion;
            expect(connection.database.isOpen).toBe(false);
            expect(connection.disposals).toBe(1);
            expect(fixture.connections[1]!.database.isOpen).toBe(true);
            if (phase === "rollback") {
              expect(failed).toHaveBeenCalledWith(
                expect.objectContaining({
                  error: expect.objectContaining({
                    message: "synthetic first image persistence failure",
                  }),
                }),
              );
              expect(completed).not.toHaveBeenCalled();
              expect(savedPath && fs.existsSync(savedPath)).toBe(false);
            } else {
              expect(failed).not.toHaveBeenCalled();
              expect(completed).toHaveBeenCalledOnce();
              expect(connection.projected).toBeGreaterThan(0);
              expect(fs.readFileSync(savedPath!)).toEqual(png);
            }
          } finally {
            fixture.resumeGeneration.resolve();
            resumeSave.resolve();
            resumeRollback.resolve();
            await completion;
            await first.release();
            await successor?.release();
          }
        });
      } finally {
        fixture.cleanup();
      }
    },
  );
});
