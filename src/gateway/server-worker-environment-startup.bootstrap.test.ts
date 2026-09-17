import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import * as packageRoot from "../infra/openclaw-root.js";
import * as temporaryRoot from "../infra/tmp-openclaw-dir.js";
import * as metadataState from "../plugins/current-plugin-metadata-state.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseByPathAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as version from "../version.js";
import { createDesktopSessionRegistry } from "./desktop/session-registry.js";
import {
  createGatewayWorkerEnvironmentRuntime,
  loadGatewayWorkerEnvironmentStartupState,
} from "./server-worker-environment-startup.js";
import { withGatewayWorkerEnvironmentStartupState } from "./server-worker-environment-startup.state.test-support.js";
import * as artifactModule from "./worker-environments/node-bootstrap-artifact.js";
import {
  buildId,
  useNodeBootstrapArtifactFixtures,
} from "./worker-environments/node-bootstrap-artifact.test-support.js";
import * as enrollmentModule from "./worker-environments/node-enrollment.js";
import * as transferModule from "./worker-environments/worker-bootstrap-artifact-transfer-service.js";

const tempDirs = createTempDirTracker();
const { fixture } = useNodeBootstrapArtifactFixtures();

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  resetConfigRuntimeState();
  tempDirs.cleanup();
});

describe("cloud bootstrap plugin generations", () => {
  it.skipIf(process.platform === "win32")(
    "reuses image bytes through Gateway restart with fresh enrollment and download authority",
    async () => {
      const installation = await fixture("package");
      vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(installation.root);
      const original = await installation.provider.prepare();
      const retainedBytes = gzipSync(gunzipSync(await fs.readFile(original.tarballPath)), {
        level: 1,
      });
      const retainedHash = createHash("sha256").update(retainedBytes).digest("hex");
      expect(retainedHash).not.toBe(original.tarballSha256);
      const retainedPath = path.join(installation.packageRoot, "node-runtime.tgz");
      await fs.writeFile(retainedPath, retainedBytes);
      await installation.provider.close();
      const plugin = installation.options.plugins[0]!;
      const metadata = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: plugin.id,
            rootDir: plugin.root,
            packageName: installation.pluginPackage.name,
            packageVersion: installation.pluginPackage.version,
          },
        ],
      });
      const registry = createEmptyPluginRegistry();
      registry.plugins = metadata.plugins.map((record) =>
        createPluginRecord({ ...record, enabled: true, configSchema: true }),
      );
      registry.agentHarnesses.push({
        pluginId: plugin.id,
        source: path.join(plugin.root, "index.js"),
        harness: {
          id: plugin.id,
          label: plugin.id,
          cloudPlacement: {
            mode: "remote-exec",
            devicePlacement: {
              requiredNodeCommands: ["fixture.exec"],
              consumesWorkerSlot: false,
            },
          },
          supports: () => ({ supported: true }),
          runAttempt: async () => {
            throw new Error("not used");
          },
        },
      });
      registry.nodeHostCommands.push({
        pluginId: plugin.id,
        source: path.join(plugin.root, "index.js"),
        command: { command: "fixture.exec", handle: async () => "{}" },
      });
      vi.spyOn(packageRoot, "resolveOpenClawPackageRootSync").mockReturnValue(
        installation.packageRoot,
      );
      vi.spyOn(version, "resolveRuntimeServiceBuildId").mockReturnValue(buildId);
      vi.spyOn(metadataState, "getGatewayPluginMetadataSnapshot").mockReturnValue(metadata);
      // Observe the actual managers; the producer, enrollment, and transfer implementations run.
      const enrollmentFactory = vi.spyOn(enrollmentModule, "createWorkerNodeEnrollmentManager");
      const transferFactory = vi.spyOn(
        transferModule,
        "createWorkerBootstrapArtifactTransferService",
      );
      const stateDir = tempDirs.make("openclaw-bootstrap-restart-");
      await withGatewayWorkerEnvironmentStartupState(stateDir, async () => {
        setRuntimeConfigSnapshot({ gateway: { publicOrigin: "https://gateway.example.test" } });
        const start = async (environmentId: string) => {
          const startup = await loadGatewayWorkerEnvironmentStartupState();
          const runtime = await createGatewayWorkerEnvironmentRuntime({
            getPluginRegistry: () => registry,
            getPortalRuntime: () => undefined,
            resolveGatewayContext: () => undefined,
            desktopSessionRegistry: createDesktopSessionRegistry({ lingerMs: 1 }),
            startup,
            log: { child: () => ({ warn: () => {} }) },
          });
          try {
            const managerResult = enrollmentFactory.mock.results.at(-1);
            const transferResult = transferFactory.mock.results.at(-1);
            if (managerResult?.type !== "return" || transferResult?.type !== "return") {
              throw new Error("Gateway managers were not created");
            }
            startup.store.createIntent({
              environmentId,
              providerId: "fake-provider",
              profileId: "test-profile",
              profileSnapshot: { executionMode: "remote-exec", settings: {} },
              provisionOperationId: `provision:${environmentId}`,
            });
            const record = startup.store.transition({
              environmentId,
              from: "requested",
              to: "provisioning",
              patch: { nodeDeviceId: `${environmentId}-node` },
            });
            const enrollment = await managerResult.value.begin(record);
            return { runtime, enrollment, transfer: transferResult.value };
          } catch (error) {
            await runtime.workerEnvironmentService?.stop();
            throw error;
          }
        };
        const first = await start("first-process");
        try {
          expect(first.enrollment.nodeBootstrap.sha256).toBe(retainedHash);
        } finally {
          await first.runtime.workerEnvironmentService?.stop();
        }
        expect(first.enrollment.signal?.aborted).toBe(true);
        expect(
          first.transfer.authorize({
            token: first.enrollment.nodeBootstrap.token,
            artifactKey: retainedHash,
          }),
        ).toBeUndefined();
        await closeOpenClawStateDatabaseByPathAsync(
          resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }),
        );
        closeOpenClawStateDatabaseForTest();
        const second = await start("second-process");
        try {
          expect(second.enrollment.nodeBootstrap.sha256).toBe(retainedHash);
          expect(second.enrollment.nodeBootstrap.token).not.toBe(
            first.enrollment.nodeBootstrap.token,
          );
          const capability = second.transfer.authorize({
            token: second.enrollment.nodeBootstrap.token,
            artifactKey: retainedHash,
          });
          expect(capability).toBeDefined();
          if (!capability) {
            throw new Error("fresh download grant missing");
          }
          const file = await second.transfer.openFile(capability);
          expect(file).not.toBeNull();
          if (!file) {
            throw new Error("verified archive unavailable");
          }
          try {
            expect(await file.handle.readFile()).toEqual(retainedBytes);
          } finally {
            await file.handle.close();
          }
        } finally {
          await second.runtime.workerEnvironmentService?.stop();
        }
        expect(await fs.readFile(retainedPath)).toEqual(retainedBytes);
      });
    },
  );

  it("refreshes registry and metadata generations, retires old artifacts, and drains them on shutdown", async () => {
    const stateDir = await fs.realpath(tempDirs.make("openclaw-bootstrap-generation-"));
    const metadata = createPluginMetadataSnapshotFixture({
      plugins: ["runtime-a", "runtime-b"].map((id) => ({
        id,
        rootDir: `/source/extensions/${id}`,
        packageName: `@example/${id}`,
        packageVersion: "1.2.3",
      })),
    });
    const makeRegistry = (runtimeId: string) => {
      const registry = createEmptyPluginRegistry();
      registry.plugins = metadata.plugins.map((record) =>
        createPluginRecord({ ...record, enabled: true, configSchema: true }),
      );
      registry.agentHarnesses.push({
        pluginId: runtimeId,
        source: `/source/extensions/${runtimeId}/index.js`,
        harness: {
          id: runtimeId,
          label: runtimeId,
          cloudPlacement: {
            mode: "remote-exec",
            devicePlacement: {
              requiredNodeCommands: [`${runtimeId}.exec`],
              consumesWorkerSlot: false,
            },
          },
          supports: () => ({ supported: true }),
          runAttempt: async () => {
            throw new Error("not used");
          },
        },
      });
      registry.nodeHostCommands.push({
        pluginId: runtimeId,
        source: `/source/extensions/${runtimeId}/index.js`,
        command: { command: `${runtimeId}.exec`, handle: async () => "{}" },
      });
      return registry;
    };
    let registry = makeRegistry("runtime-a");
    const metadataSnapshot = vi
      .spyOn(metadataState, "getGatewayPluginMetadataSnapshot")
      .mockReturnValue(metadata);
    vi.spyOn(version, "resolveRuntimeServiceBuildId").mockReturnValue("gateway-source-build");
    const enrollmentFactory = vi.spyOn(enrollmentModule, "createWorkerNodeEnrollmentManager");
    const producers: Array<{
      artifact: artifactModule.NodeBootstrapArtifact;
      prepare: Mock<(signal?: AbortSignal) => Promise<artifactModule.NodeBootstrapArtifact>>;
      close: Mock<() => Promise<void>>;
      closing: Promise<void>;
      release: () => void;
    }> = [];
    vi.spyOn(artifactModule, "createNodeBootstrapArtifactProvider").mockImplementation(
      ({ plugins }) => {
        const number = producers.length + 1;
        const closure = createDeferredCore();
        const closing = createDeferredCore();
        const artifact = {
          tarballPath: path.join(stateDir, `runtime-${number}.tgz`),
          tarballSha256: String(number).repeat(64),
          tarballBytes: 1,
          openclawVersion: "2026.8.1",
          buildId: "gateway-source-build",
          enabledPluginIds: plugins.map(({ id }) => id),
        };
        const producer = {
          artifact,
          prepare: vi.fn(async (_signal?: AbortSignal) => {
            await fs.writeFile(artifact.tarballPath, "x");
            return artifact;
          }),
          close: vi.fn(async () => {
            closing.resolve();
            await closure.promise;
            await fs.rm(artifact.tarballPath, { force: true });
          }),
          closing: closing.promise,
          release: () => closure.resolve(),
        };
        producers.push(producer);
        return producer;
      },
    );

    await withGatewayWorkerEnvironmentStartupState(stateDir, async () => {
      setRuntimeConfigSnapshot({ gateway: { publicOrigin: "https://gateway.example.test" } });
      const startup = await loadGatewayWorkerEnvironmentStartupState();
      const runtime = await createGatewayWorkerEnvironmentRuntime({
        getPluginRegistry: () => registry,
        getPortalRuntime: () => undefined,
        resolveGatewayContext: () => undefined,
        desktopSessionRegistry: createDesktopSessionRegistry({ lingerMs: 1 }),
        startup,
        log: { child: () => ({ warn: () => {} }) },
      });
      const enrollmentResult = enrollmentFactory.mock.results.at(-1);
      const service = runtime.workerEnvironmentService;
      if (enrollmentResult?.type !== "return" || !service) {
        throw new Error("worker environment runtime was not created");
      }
      const manager = enrollmentResult.value;
      const begin = async (id: string) => {
        startup.store.createIntent({
          environmentId: id,
          providerId: "fake-provider",
          profileId: "test-profile",
          profileSnapshot: { executionMode: "remote-exec", settings: {} },
          provisionOperationId: `provision:${id}`,
        });
        const record = startup.store.transition({
          environmentId: id,
          from: "requested",
          to: "provisioning",
          patch: { nodeDeviceId: `${id}-node` },
        });
        return await manager.begin(record);
      };
      let stopping: Promise<void> | undefined;
      try {
        const first = await begin("first");
        const sameGeneration = await begin("same-generation");
        expect(first.nodeBootstrap.enabledPluginIds).toEqual(["runtime-a"]);
        expect(sameGeneration.nodeBootstrap.sha256).toBe(first.nodeBootstrap.sha256);
        expect(producers).toHaveLength(1);
        expect(producers[0]!.prepare).toHaveBeenCalledWith(first.signal);
        await manager.prepare(startup.store.get("first")!);
        const preparationSignal = producers[0]!.prepare.mock.calls.at(-1)?.[0];
        expect(preparationSignal).toBeInstanceOf(AbortSignal);
        expect(preparationSignal?.aborted).toBe(true);
        expect(first.signal?.aborted).toBe(false);
        expect(sameGeneration.signal?.aborted).toBe(false);
        manager.close(sameGeneration);
        expect(first.signal?.aborted).toBe(false);

        registry = makeRegistry("runtime-b");
        const replacement = await begin("replacement");
        expect(replacement.nodeBootstrap.enabledPluginIds).toEqual(["runtime-b"]);
        expect(replacement.nodeBootstrap.sha256).not.toBe(first.nodeBootstrap.sha256);
        expect(producers[0]!.close).toHaveBeenCalledOnce();
        expect(first.signal?.aborted).toBe(false);
        await expect(fs.readFile(producers[0]!.artifact.tarballPath, "utf8")).resolves.toBe("x");

        metadataSnapshot.mockReturnValue({ ...metadata });
        const refreshed = await begin("metadata-refresh");
        expect(refreshed.nodeBootstrap.sha256).not.toBe(replacement.nodeBootstrap.sha256);
        expect(producers).toHaveLength(3);
        expect(producers[1]!.close).toHaveBeenCalledOnce();
        expect(producers[2]!.prepare).toHaveBeenCalledWith(refreshed.signal);

        manager.close(first);
        producers[0]!.release();
        await producers[0]!.close.mock.results[0]!.value;
        await expect(fs.stat(producers[0]!.artifact.tarballPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
        let stopped = false;
        stopping = service.stop().then(() => {
          stopped = true;
        });
        await producers[2]!.closing;
        expect(first.signal?.aborted).toBe(true);
        expect(replacement.signal?.aborted).toBe(true);
        expect(refreshed.signal?.aborted).toBe(true);
        producers[2]!.release();
        await producers[2]!.close.mock.results[0]!.value;
        await Promise.resolve();
        expect(stopped).toBe(false);
        for (const producer of producers) {
          producer.release();
        }
        await stopping;
        for (const producer of producers) {
          expect(producer.close).toHaveBeenCalledOnce();
          await expect(fs.stat(producer.artifact.tarballPath)).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
      } finally {
        for (const producer of producers) {
          producer.release();
        }
        await (stopping ?? service.stop());
      }
    });
  });
});
