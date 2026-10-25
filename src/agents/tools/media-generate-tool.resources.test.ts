import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
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
import { createEnteredGate } from "../entered-gate.test-support.js";
import { resetGeneratedMediaTaskActivityForTests } from "../media-generation-activity.test-support.js";
import * as taskRuntime from "../media-generation-task-status.js";
import { prepareWorkspaceBuildGroup } from "../prepared-model-runtime.facts.js";
import { discardPreparedPluginGeneration } from "../prepared-model-runtime.plugin-lifetime.js";
import { runWithAgentWorkspaceReadiness } from "../workspace-readiness.js";
import { createImageGenerateTool } from "./image-generate-tool.js";
import {
  imageGenerationTaskLifecycle,
  musicGenerationTaskLifecycle,
  videoGenerationTaskLifecycle,
} from "./media-generate-background.js";
import {
  admitTask,
  snapshot as createPreparedSnapshot,
} from "./media-resource-fixtures.test-support.js";
import { createMusicGenerateTool } from "./music-generate-tool.js";
import { createVideoGenerateTool } from "./video-generate-tool.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQVDL+DwACFAFmBODefwAAAABJRU5ErkJggg==",
  "base64",
);

const mp4 = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
  0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31,
]);
type GenerationKind = "image" | "music" | "video";

function createNativeFixture(
  kind: GenerationKind,
  edit = false,
  trackCount = 1,
  holdLookup = false,
) {
  const dir = makePluginLoaderTempDir();
  const key = `__openclaw_prepared_${kind}_${path.basename(dir)}`;
  const connections: Array<{
    database: DatabaseSync;
    disposals: number;
    generated: number;
    projected: number;
  }> = [];
  const lookup = createEnteredGate();
  const provider = createEnteredGate();
  const generation = createEnteredGate();
  const output =
    kind === "image" ? png : kind === "video" ? mp4 : Buffer.from("synthetic native music 42");
  if (!holdLookup) {
    lookup.release();
  }
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: {
      connections,
      generation,
      provider,
      lookup,
      output,
      kind,
      edit,
      trackCount,
    },
  });
  const id = `prepared-${kind}-resource`;
  const plugin = writePlugin({
    dir,
    id,
    body: `const { DatabaseSync } = require("node:sqlite");
module.exports = {
  id: ${JSON.stringify(id)},
  register(api) {
    const state = globalThis[${JSON.stringify(key)}];
    const { kind, edit } = state;
    const database = new DatabaseSync(":memory:");
    const connection = { database, disposals: 0, generated: 0, projected: 0 };
    state.connections.push(connection);
    const read = () => database.prepare("SELECT 42 AS value").get().value;
    const project = (value) => { connection.projected++; return value(); };
    api.lifecycle.registerRuntimeLifecycle({
      id: "prepared-media-database",
      dispose() { read(); connection.disposals++; database.close(); },
    });
    const title = kind[0].toUpperCase() + kind.slice(1);
    const extension = { image: "png", music: "mp3", video: "mp4" }[kind];
    const mimeType = { image: "image/png", music: "audio/mpeg", video: "video/mp4" }[kind];
    const resultKey = { image: "images", music: "tracks", video: "videos" }[kind];
    const maxKey = { image: "maxCount", music: "maxTracks", video: "maxVideos" }[kind];
    const provider = {
      id: ${JSON.stringify(id)},
      defaultModel: "fixture-" + kind,
      isConfigured() { return read() === 42; },
      capabilities: {
        generate: { [maxKey]: 2 },
        [kind === "video" ? "imageToVideo" : "edit"]: { enabled: edit, maxInputImages: edit ? 1 : 0 },
      },
      async ["generate" + title](request) {
        await state.provider.wait();
        read();
        connection.generated++;
        await state.generation.wait();
        read();
        const outputs = Array.from({ length: kind === "image" ? request.count ?? 1 : state.trackCount }, (_, index) => {
          const output = { buffer: state.output, mimeType, fileName: "native-" + index + "." + extension };
          if (kind === "image") Object.defineProperty(output, "revisedPrompt", {
            enumerable: true, get() { return project(() => "native value " + read()); },
          });
          if (kind === "music") Object.defineProperty(output, "fileName", {
            enumerable: true, get() { return project(() => "native-" + index + "-" + read() + ".mp3"); },
          });
          return output;
        });
        return {
          [resultKey]: outputs,
          ...(kind === "video" ? { metadata: {
            supportedDurationSeconds: Object.assign([1], {
              filter(predicate) {
                project(read);
                return Array.prototype.filter.call(this, predicate);
              },
            }),
          }} : {}),
        };
      },
    };
    if (kind === "video") provider.resolveModelCapabilities = async () => {
      await state.provider.wait();
      read();
      await state.lookup.wait();
      read();
      return {};
    };
    api["register" + title + "GenerationProvider"](provider);
  },
};`,
  });
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      contracts: { [`${kind}GenerationProviders`]: [id] },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  const config: OpenClawConfig = {
    agents: { defaults: { mediaModels: { [kind]: { primary: `${id}/fixture-${kind}` } } } },
    plugins: { allow: [id], load: { paths: [plugin.file] }, slots: { memory: "none" } },
  };
  return {
    dir,
    config,
    output,
    connections,
    generation,
    provider,
    lookup,
    withEnvironment: (run: () => Promise<void>) =>
      withEnvAsync(
        {
          OPENCLAW_HOME: dir,
          OPENCLAW_STATE_DIR: dir,
          OPENCLAW_CONFIG_PATH: path.join(dir, "config.json"),
        },
        run,
      ),
    [Symbol.dispose]() {
      lookup.release();
      provider.release();
      generation.release();
      for (const { database } of connections) {
        if (database.isOpen) {
          database.close();
        }
      }
      Reflect.deleteProperty(globalThis, key);
    },
  };
}

async function prepareSnapshot(fixture: ReturnType<typeof createNativeFixture>) {
  const first = await acquirePluginRegistryForInspection({ config: fixture.config });
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
    () => first.registry,
  );
  return {
    snapshot: createPreparedSnapshot(prepared, async () => {
      throw new Error("The synthetic media provider does not request model credentials");
    }),
    release: async () => {
      await first.release();
      await discardPreparedPluginGeneration(prepared.pluginGeneration);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  resetGeneratedMediaTaskActivityForTests();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

describe.each(["image", "music", "video"] as const)(
  "prepared %s job registration resources",
  (kind) => {
    const createTool = {
      image: createImageGenerateTool,
      music: createMusicGenerateTool,
      video: createVideoGenerateTool,
    }[kind];
    const lifecycle = {
      image: imageGenerationTaskLifecycle,
      music: musicGenerationTaskLifecycle,
      video: videoGenerationTaskLifecycle,
    }[kind];
    const createPreparedTool = (
      fixture: ReturnType<typeof createNativeFixture>,
      snapshot: Awaited<ReturnType<typeof prepareSnapshot>>["snapshot"],
      config = fixture.config,
    ) =>
      createTool({
        config,
        agentDir: snapshot.agentDir,
        workspaceDir: fixture.dir,
        preparedModelRuntime: snapshot,
        agentSessionKey: "agent:main:discord:direct:synthetic-media",
      });
    it("waits for the captured workspace before reading a generation reference", async () => {
      using fixture = createNativeFixture(kind, true);
      const waiting = createDeferredCore();
      const ready = createDeferredCore();
      await fixture.withEnvironment(async () => {
        useNoBundledPlugins();
        const prepared = await prepareSnapshot(fixture);
        const sessionKey = "agent:main:discord:direct:synthetic-media";
        const referencePath = path.join(fixture.dir, "pending-reference.png");
        const { created: createTask, settlement } = admitTask(lifecycle, sessionKey);
        const readReference = vi.spyOn(webMedia, "loadWebMedia");
        const tool = await runWithAgentWorkspaceReadiness(
          {
            sessionKey,
            waitUntilReady: () => {
              waiting.resolve();
              return ready.promise;
            },
            assertCurrent: () => {},
          },
          async () => createPreparedTool(fixture, prepared.snapshot),
        );
        const outcome = tool!.execute("workspace-reference", {
          prompt: "Use the synthetic workspace reference",
          image: referencePath,
        });
        try {
          await awaitGateBeforeSettlement(
            waiting.promise,
            outcome,
            "Media preflight finished before workspace readiness",
          );
          expect(readReference).not.toHaveBeenCalled();
          expect(createTask).not.toHaveBeenCalled();
          const inline = await tool!.execute("inline-reference", {
            prompt: "Use an inline reference while the workspace is pending",
            image: `data:image/png;base64,${png.toString("base64")}`,
          });
          expect(inline.details).toMatchObject({ status: "started" });
          fs.writeFileSync(referencePath, png);
          ready.resolve();
          expect((await outcome).details).toMatchObject({ status: "started" });
          expect(readReference).toHaveBeenCalledOnce();
          expect(createTask).toHaveBeenCalledTimes(2);
          expect(fixture.connections[0]!.generated).toBe(0);
          fixture.provider.release();
          fixture.generation.release();
          expect(await settlement.wait(2)).toEqual(["succeeded", "succeeded"]);
          expect(fixture.connections[0]!.generated).toBe(2);
        } finally {
          ready.resolve();
          await outcome.catch(() => {});
          fixture.provider.release();
          fixture.generation.release();
          await settlement.wait(createTask.mock.calls.length);
          await prepared.release();
        }
      });
    });
    it.each(["request lookup", "duplicate lookup", "reference loading"] as const)(
      "refuses generation when the prepared owner releases during %s",
      async (pause) => {
        using fixture = createNativeFixture(kind, true);
        const preflightPaused = createDeferredCore();
        const resumePreflight = createDeferredCore();
        await fixture.withEnvironment(async () => {
          useNoBundledPlugins();
          const referencePath = path.join(fixture.dir, "reference.png");
          fs.writeFileSync(referencePath, png);
          const prepared = await prepareSnapshot(fixture);
          const { snapshot } = prepared;
          const createTask = vi.spyOn(lifecycle, "createTaskRun");
          const loadReference = webMedia.loadWebMedia;
          const reference = vi
            .spyOn(webMedia, "loadWebMedia")
            .mockImplementation(async (...args) => {
              if (pause === "reference loading") {
                preflightPaused.resolve();
                await resumePreflight.promise;
              }
              return loadReference(...args);
            });
          const lookup = {
            image: "findDuplicateGuardImageGenerationTaskForSession",
            music: "findDuplicateGuardMusicGenerationTaskForSession",
            video: "findDuplicateGuardVideoGenerationTaskForSession",
          } as const;
          const readTasks = taskRuntime[lookup[kind]];
          let lookups = 0;
          vi.spyOn(taskRuntime, lookup[kind]).mockImplementation(async (ownerKey, options) => {
            const tasks = await readTasks(ownerKey, options);
            if (
              pause !== "reference loading" &&
              ++lookups === (pause === "request lookup" ? 1 : 2)
            ) {
              preflightPaused.resolve();
              await resumePreflight.promise;
            }
            return tasks;
          });
          const tool = createPreparedTool(fixture, snapshot, {
            ...fixture.config,
            agents: pause === "request lookup" ? undefined : fixture.config.agents,
          });
          const outcome = tool!
            .execute("preflight-image-call", {
              prompt: "Synthetic media edit",
              image: referencePath,
            })
            .then(
              (value) => ({ value, error: undefined }),
              (error: unknown) => ({ value: undefined, error }),
            );
          try {
            await awaitGateBeforeSettlement(
              preflightPaused.promise,
              outcome,
              `Media preflight settled before ${pause}`,
            );
            await prepared.release();
            resumePreflight.resolve();
            const result = await outcome;
            expect(result.error).toBeInstanceOf(Error);
            expect(result.value).toBeUndefined();
            if (pause !== "reference loading") {
              expect(reference).not.toHaveBeenCalled();
            }
            expect(createTask).not.toHaveBeenCalled();
            expect(fixture.connections[0]!.generated).toBe(0);
            expect(fixture.connections[0]!.database.isOpen).toBe(false);
            expect(fixture.connections[0]!.disposals).toBe(1);
          } finally {
            resumePreflight.resolve();
            await outcome;
            await prepared.release();
          }
        });
      },
    );

    it.each(
      kind === "video"
        ? (["queued", "lookup", "saving", "rollback"] as const)
        : (["queued", "saving", "rollback"] as const),
    )("retains the admitted provider through %s after its parent releases", async (phase) => {
      using fixture = createNativeFixture(
        kind,
        false,
        phase === "rollback" ? 2 : 1,
        phase === "lookup",
      );
      const saveStarted = createDeferredCore();
      const resumeSave = createDeferredCore();
      const rollbackStarted = createDeferredCore();
      const resumeRollback = createDeferredCore();
      let completion: Promise<unknown> | undefined;
      await fixture.withEnvironment(async () => {
        useNoBundledPlugins();
        let prepared: Awaited<ReturnType<typeof prepareSnapshot>> | undefined;
        let successor: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
        try {
          prepared = await prepareSnapshot(fixture);
          const { snapshot } = prepared;
          const connection = fixture.connections[0]!;
          const sessionKey = "agent:main:discord:direct:synthetic-media";
          const { wake, settlement } = admitTask(lifecycle, sessionKey);
          const save = mediaStore.saveMediaBuffer;
          const remove = mediaStore.deleteMediaBuffer;
          let saveCalls = 0;
          let savedPath: string | undefined;
          vi.spyOn(mediaStore, "saveMediaBuffer").mockImplementation(async (...args) => {
            saveCalls++;
            if (phase === "rollback" && saveCalls === (kind === "video" ? 2 : 1)) {
              throw new Error("synthetic first media persistence failure");
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
          const tool = createPreparedTool(fixture, snapshot);
          const started = await tool!.execute("image-resource-call", {
            prompt: "Synthetic media resource proof",
            count: phase === "rollback" ? 2 : 1,
          });
          completion = settlement.wait();
          expect(started.details).toMatchObject({ status: "started" });
          expect(connection.generated).toBe(0);
          if (phase === "queued") {
            await prepared.release();
          }
          successor = await acquirePluginRegistryForInspection({ config: fixture.config });
          setActivePluginRegistry(successor.registry);
          expect(fixture.connections).toHaveLength(2);
          if (phase === "queued") {
            expect(connection.database.isOpen).toBe(true);
          }
          fixture.provider.release();
          if (phase === "lookup") {
            await awaitGateBeforeSettlement(
              fixture.lookup.entered,
              completion,
              "Video task settled before model capability lookup",
            );
            await prepared.release();
            expect(connection.database.isOpen).toBe(true);
            expect(connection.generated).toBe(0);
            fixture.lookup.release();
          }
          await awaitGateBeforeSettlement(
            fixture.generation.entered,
            completion,
            "Media task settled without invoking its prepared provider",
          );
          fixture.generation.release();
          await awaitGateBeforeSettlement(
            saveStarted.promise,
            completion,
            "Media task settled before persisting its output",
          );
          if (kind !== "video" || phase !== "rollback") {
            await prepared.release();
          }
          expect(connection.database.isOpen).toBe(true);
          expect(connection.disposals).toBe(0);
          expect(fixture.connections[1]!.generated).toBe(0);
          resumeSave.resolve();
          if (phase === "rollback") {
            await rollbackStarted.promise;
            if (kind === "video") {
              await prepared.release();
            }
            expect(connection.database.isOpen).toBe(true);
            expect(savedPath && fs.existsSync(savedPath)).toBe(true);
            resumeRollback.resolve();
          }
          expect(await completion).toEqual([phase === "rollback" ? "failed" : "succeeded"]);
          expect(connection.generated).toBe(1);
          expect(connection.database.isOpen).toBe(false);
          expect(connection.disposals).toBe(1);
          expect(fixture.connections[1]!.database.isOpen).toBe(true);
          if (phase === "rollback") {
            expect(wake).toHaveBeenCalledWith(
              expect.objectContaining({
                status: "error",
                result: expect.stringContaining("synthetic first media persistence failure"),
              }),
            );
            expect(savedPath && fs.existsSync(savedPath)).toBe(false);
          } else {
            expect(connection.projected).toBeGreaterThan(0);
            expect(fs.readFileSync(savedPath!)).toEqual(fixture.output);
          }
        } finally {
          fixture.lookup.release();
          fixture.provider.release();
          fixture.generation.release();
          resumeSave.resolve();
          resumeRollback.resolve();
          await completion;
          await prepared?.release();
          await successor?.release();
        }
      });
    });
  },
);
