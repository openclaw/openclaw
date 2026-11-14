import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as mediaStore from "../../media/store.js";
import * as webMedia from "../../media/web-media.js";
import { writeFixtureJson } from "../../plugins/loader-fixture-builders.test-support.js";
import { acquirePluginRegistryForInspection } from "../../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../../plugins/loader.test-fixtures.js";
import {
  cleanupNativeFixture,
  nativeFixtureEnv,
} from "../../plugins/native-resource.test-support.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withEnvAsync } from "../../test-utils/env.js";
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
  const lookupStarted = createDeferredCore();
  const resumeLookup = createDeferredCore();
  if (!holdLookup) {
    resumeLookup.resolve();
  }
  const resumeProvider = createDeferredCore();
  const generated = createDeferredCore();
  const resumeGeneration = createDeferredCore();
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: {
      connections,
      generated,
      resumeGeneration,
      resumeProvider,
      lookupStarted,
      resumeLookup,
      png,
      mp4,
      audio: Buffer.from("synthetic native music 42"),
    },
  });
  const id = `prepared-${kind}-resource`;
  const plugin = writePlugin({
    dir,
    id,
    body: `const { DatabaseSync } = require("node:sqlite");
const metadata = (value) => new Proxy(value, {});
module.exports = {
  id: ${JSON.stringify(id)},
  register(api) {
    const kind = ${JSON.stringify(kind)};
    const state = globalThis[${JSON.stringify(key)}];
    const database = new DatabaseSync(":memory:");
    const connection = { database, disposals: 0, generated: 0, projected: 0 };
    state.connections.push(connection);
    const read = () => database.prepare("SELECT 42 AS value").get().value;
    api.lifecycle.registerRuntimeLifecycle({
      id: "prepared-media-database",
      dispose() {
        read();
        connection.disposals++;
        database.close();
      },
    });
    const title = kind[0].toUpperCase() + kind.slice(1);
    const limit = { image: "maxCount", music: "maxTracks", video: "maxVideos" }[kind];
    const referenceMode = kind === "video" ? "imageToVideo" : "edit";
    const provider = {
      id: ${JSON.stringify(id)},
      defaultModel: "fixture-" + kind,
      isConfigured() { return read() === 42; },
      capabilities: metadata({
        generate: { [limit]: 2 },
        [referenceMode]: { enabled: ${edit}, maxInputImages: ${edit ? 1 : 0} },
      }),
      async ["generate" + title](request) {
        await state.resumeProvider.promise;
        read();
        connection.generated++;
        state.generated.resolve();
        await state.resumeGeneration.promise;
        read();
        const items = Array.from({ length: kind === "image" ? request.count ?? 1 : ${trackCount} }, (_, index) => {
          const item = {
            buffer: { image: state.png, music: state.audio, video: state.mp4 }[kind],
            mimeType: { image: "image/png", music: "audio/mpeg", video: "video/mp4" }[kind],
            fileName: "native-" + index + (kind === "image" ? ".png" : ".mp4"),
          };
          if (kind === "image") Object.defineProperty(item, "revisedPrompt", {
            enumerable: true,
            get() { connection.projected++; return "native value " + read(); },
          });
          if (kind === "music") Object.defineProperty(item, "fileName", {
            enumerable: true,
            get() { connection.projected++; return "native-" + index + "-" + read() + ".mp3"; },
          });
          return item;
        });
        const result = { [{ image: "images", music: "tracks", video: "videos" }[kind]]: items };
        if (kind === "video") result.metadata = {
          supportedDurationSeconds: Object.assign([1], {
            filter(predicate) {
              connection.projected++;
              read();
              return Array.prototype.filter.call(this, predicate);
            },
          }),
        };
        return result;
      },
    };
    if (kind === "image") {
      provider.models = ["fixture-image-catalog"];
      provider.catalogByModel = { "fixture-image-catalog": {
        capabilities: metadata({ generate: { maxCount: 1 }, edit: { enabled: false, maxInputImages: 0 } }),
        modes: metadata(["generate"]),
      } };
    }
    if (kind === "video") provider.resolveModelCapabilities = async () => {
      await state.resumeProvider.promise;
      read();
      state.lookupStarted.resolve();
      await state.resumeLookup.promise;
      read();
      return {};
    };
    api["register" + title + "GenerationProvider"](provider);
  },
};`,
  });
  writeFixtureJson(dir, "openclaw.plugin.json", {
    id,
    contracts: { [`${kind}GenerationProviders`]: [id] },
    configSchema: { type: "object", additionalProperties: false, properties: {} },
  });
  const config: OpenClawConfig = {
    agents: { defaults: { mediaModels: { [kind]: { primary: `${id}/fixture-${kind}` } } } },
    plugins: { allow: [id], load: { paths: [plugin.file] }, slots: { memory: "none" } },
  };
  return {
    dir,
    config,
    output:
      kind === "image" ? png : kind === "video" ? mp4 : Buffer.from("synthetic native music 42"),
    connections,
    generated,
    resumeGeneration,
    resumeProvider,
    lookupStarted,
    resumeLookup,
    withEnvironment(run: () => Promise<void>) {
      useNoBundledPlugins();
      return withEnvAsync(nativeFixtureEnv(dir), run).finally(() => {
        resumeLookup.resolve();
        resumeProvider.resolve();
        resumeGeneration.resolve();
        cleanupNativeFixture(key, connections);
      });
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
  return {
    snapshot: createPreparedSnapshot(prepared, async () => {
      throw new Error("The synthetic media provider does not request model credentials");
    }),
    release: () => discardPreparedPluginGeneration(prepared.pluginGeneration),
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
    it("waits for the captured workspace before reading a generation reference", async () => {
      const fixture = createNativeFixture(kind, true);
      const waiting = createDeferredCore();
      const ready = createDeferredCore();
      await fixture.withEnvironment(async () => {
        const first = await acquirePluginRegistryForInspection({ config: fixture.config });
        const prepared = await prepareSnapshot(fixture, first.registry);
        const sessionKey = "agent:main:discord:direct:synthetic-media";
        const referencePath = path.join(fixture.dir, "pending-reference.png");
        const {
          created: createTask,
          completed,
          failed,
          settlement,
        } = admitTask(lifecycle, sessionKey);
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
          async () =>
            createTool({
              config: fixture.config,
              agentDir: prepared.snapshot.agentDir,
              workspaceDir: fixture.dir,
              preparedModelRuntime: prepared.snapshot,
              agentSessionKey: sessionKey,
            }),
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
          fixture.resumeProvider.resolve();
          fixture.resumeGeneration.resolve();
          expect(await settlement.wait(2)).toEqual(["succeeded", "succeeded"]);
          expect(completed).toHaveBeenCalledTimes(2);
          expect(fixture.connections[0]!.generated).toBe(2);
          expect(failed).not.toHaveBeenCalled();
        } finally {
          ready.resolve();
          await outcome.catch(() => {});
          fixture.resumeProvider.resolve();
          fixture.resumeGeneration.resolve();
          await settlement.wait(createTask.mock.calls.length);
          await first.release();
          await prepared.release();
        }
      });
    });
    it("returns serializable list metadata after its provider resources close", async () => {
      const fixture = createNativeFixture(kind);
      await fixture.withEnvironment(async () => {
        const acquired = await acquirePluginRegistryForInspection({ config: fixture.config });
        try {
          const result = await withPluginRuntimeRegistryScope(acquired.registry, () =>
            createTool({ config: fixture.config })!.execute("media-list-call", { action: "list" }),
          );
          await acquired.release();

          const connection = fixture.connections[0]!;
          expect(connection.database.isOpen).toBe(false);
          expect(connection.disposals).toBe(1);
          expect(connection.generated).toBe(0);

          expect(() => JSON.stringify(result)).not.toThrow();
          // oxlint-disable-next-line unicorn/prefer-structured-clone -- Assert the JSON wire shape, not an in-memory clone.
          const serialized = JSON.parse(JSON.stringify(result)) as {
            details: { providers: Array<Record<string, unknown>> };
          };
          const providers = serialized.details.providers;
          expect(providers).toHaveLength(1);
          expect(providers[0]?.id).toBe(`prepared-${kind}-resource`);
          expect(providers[0]?.configured).toBe(true);
          expect(providers[0]?.models).toContain(`fixture-${kind}`);
          if (kind === "image") {
            expect(providers[0]?.models).toContain("fixture-image-catalog");
            const catalog = providers[0]?.catalog as Array<Record<string, unknown>> | undefined;
            const catalogEntry = catalog?.find((entry) => entry.model === "fixture-image-catalog");
            expect(catalogEntry?.capabilities).toEqual({
              generate: { maxCount: 1 },
              edit: { enabled: false, maxInputImages: 0 },
            });
            expect(catalogEntry?.modes).toEqual(["generate"]);
          }
        } finally {
          await acquired.release();
        }
      });
    });
    it.each(["request lookup", "duplicate lookup", "reference loading"] as const)(
      "refuses generation when the prepared owner releases during %s",
      async (pause) => {
        const fixture = createNativeFixture(kind, true);
        const preflightPaused = createDeferredCore();
        const resumePreflight = createDeferredCore();
        await fixture.withEnvironment(async () => {
          const first = await acquirePluginRegistryForInspection({ config: fixture.config });
          const referencePath = path.join(fixture.dir, "reference.png");
          fs.writeFileSync(referencePath, png);
          const prepared = await prepareSnapshot(fixture, first.registry);
          const { snapshot } = prepared;
          const createTask = vi.spyOn(lifecycle, "createTaskRun").mockResolvedValue({
            taskId: "preflight-image-task",
            detach: true,
            runId: "preflight-image-run",
            requesterSessionKey: "agent:main:discord:direct:synthetic-media",
            taskLabel: "Synthetic media edit",
          });
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
          const tool = createTool({
            config: {
              ...fixture.config,
              agents: pause === "request lookup" ? undefined : fixture.config.agents,
            },
            agentDir: snapshot.agentDir,
            workspaceDir: fixture.dir,
            preparedModelRuntime: snapshot,
            agentSessionKey: "agent:main:discord:direct:synthetic-media",
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
            await first.release();
            await prepared.release();
            resumePreflight.resolve();
            const result = await outcome;
            expect(result.error).toBeInstanceOf(Error);
            expect(result.value).toBeUndefined();
            if (pause !== "reference loading") {
              expect(reference).not.toHaveBeenCalled();
              expect(createTask).not.toHaveBeenCalled();
            }
            if (pause === "request lookup") {
              expect(lookups).toBe(1);
            }
            expect(fixture.connections[0]!.generated).toBe(0);
            expect(fixture.connections[0]!.database.isOpen).toBe(false);
            expect(fixture.connections[0]!.disposals).toBe(1);
          } finally {
            resumePreflight.resolve();
            await outcome;
            await first.release();
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
      const fixture = createNativeFixture(
        kind,
        false,
        phase === "rollback" ? 2 : 1,
        phase === "lookup",
      );
      const saveStarted = createDeferredCore();
      const resumeSave = createDeferredCore();
      const rollbackStarted = createDeferredCore();
      const resumeRollback = createDeferredCore();
      let completion: Promise<void> | undefined;
      await fixture.withEnvironment(async () => {
        const first = await acquirePluginRegistryForInspection({ config: fixture.config });
        let prepared: Awaited<ReturnType<typeof prepareSnapshot>> | undefined;
        let successor: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
        try {
          prepared = await prepareSnapshot(fixture, first.registry);
          const { snapshot } = prepared;
          expect(snapshot.mediaCapabilityProviders?.[`${kind}GenerationProviders`]).toHaveLength(1);
          const connection = fixture.connections[0]!;
          const sessionKey = "agent:main:discord:direct:synthetic-media";
          const { completed, failed, wake, settlement } = admitTask(lifecycle, sessionKey);
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
          const tool = createTool({
            config: fixture.config,
            agentDir: snapshot.agentDir,
            workspaceDir: fixture.dir,
            preparedModelRuntime: snapshot,
            agentSessionKey: sessionKey,
          });
          expect(tool).not.toBeNull();
          const started = await tool!.execute("image-resource-call", {
            prompt: "Synthetic media resource proof",
            count: phase === "rollback" ? 2 : 1,
          });
          completion = settlement.wait().then(() => {});
          expect(started.details).toMatchObject({ status: "started" });
          expect(connection.generated).toBe(0);
          if (phase === "queued") {
            await first.release();
            await prepared.release();
          }
          successor = await acquirePluginRegistryForInspection({ config: fixture.config });
          setActivePluginRegistry(successor.registry);
          expect(fixture.connections).toHaveLength(2);
          if (phase === "queued") {
            expect(connection.database.isOpen).toBe(true);
          }
          fixture.resumeProvider.resolve();
          if (phase === "lookup") {
            await awaitGateBeforeSettlement(
              fixture.lookupStarted.promise,
              completion,
              "Video task settled before model capability lookup",
            );
            await first.release();
            await prepared.release();
            expect(connection.database.isOpen).toBe(true);
            expect(connection.generated).toBe(0);
            fixture.resumeLookup.resolve();
          }
          await awaitGateBeforeSettlement(
            fixture.generated.promise,
            completion,
            "Media task settled without invoking its prepared provider",
          );
          fixture.resumeGeneration.resolve();
          await awaitGateBeforeSettlement(
            saveStarted.promise,
            completion,
            "Media task settled before persisting its output",
          );
          if (kind !== "video" || phase !== "rollback") {
            await first.release();
            await prepared.release();
          }
          expect(connection.database.isOpen).toBe(true);
          expect(connection.disposals).toBe(0);
          expect(fixture.connections[1]!.generated).toBe(0);
          resumeSave.resolve();
          if (phase === "rollback") {
            await rollbackStarted.promise;
            if (kind === "video") {
              await first.release();
              await prepared.release();
            }
            expect(connection.database.isOpen).toBe(true);
            expect(savedPath && fs.existsSync(savedPath)).toBe(true);
            resumeRollback.resolve();
          }
          await completion;
          expect(connection.generated).toBe(1);
          expect(connection.database.isOpen).toBe(false);
          expect(connection.disposals).toBe(1);
          expect(fixture.connections[1]!.database.isOpen).toBe(true);
          if (phase === "rollback") {
            expect(failed).toHaveBeenCalledOnce();
            expect(wake).toHaveBeenCalledWith(
              expect.objectContaining({
                status: "error",
                result: expect.stringContaining("synthetic first media persistence failure"),
              }),
            );
            expect(completed).not.toHaveBeenCalled();
            expect(savedPath && fs.existsSync(savedPath)).toBe(false);
          } else {
            expect(failed).not.toHaveBeenCalled();
            expect(completed).toHaveBeenCalledOnce();
            expect(connection.projected).toBeGreaterThan(0);
            expect(fs.readFileSync(savedPath!)).toEqual(fixture.output);
          }
        } finally {
          fixture.resumeLookup.resolve();
          fixture.resumeProvider.resolve();
          fixture.resumeGeneration.resolve();
          resumeSave.resolve();
          resumeRollback.resolve();
          await completion;
          await first.release();
          await prepared?.release();
          await successor?.release();
        }
      });
    });
  },
);
