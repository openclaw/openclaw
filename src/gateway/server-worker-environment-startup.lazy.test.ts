import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as metadataState from "../plugins/current-plugin-metadata-state.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import * as version from "../version.js";
import { createDesktopSessionRegistry } from "./desktop/session-registry.js";
import * as bundles from "./worker-environments/bundle.js";
import type { WorkerConnectionIdentity } from "./worker-environments/connection-identity.js";
import * as bootstrapArtifacts from "./worker-environments/node-bootstrap-artifact.js";
import type {
  createWorkerEnvironmentService,
  WorkerEnvironmentService,
} from "./worker-environments/service.js";

type GatewayToolFactory = NonNullable<
  Parameters<typeof createWorkerEnvironmentService>[0]["createGatewayTools"]
>;
type WorkerGatewayTools =
  typeof import("./worker-environments/worker-session-tool-executor.js").createWorkerGatewayTools;

const mocks = vi.hoisted(() => {
  return {
    createTools: vi.fn<WorkerGatewayTools>(() => []),
    createGatewayTools: undefined as GatewayToolFactory | undefined,
    prepareNodeArtifacts: undefined as Parameters<
      typeof createWorkerEnvironmentService
    >[0]["prepareNodeArtifacts"],
    service: {
      setHumanPresence: vi.fn(async () => {}),
      get: vi.fn<WorkerEnvironmentService["get"]>(),
      ready: vi.fn<WorkerEnvironmentService["ready"]>(async () => {}),
      stop: vi.fn<WorkerEnvironmentService["stop"]>(async () => {}),
    } satisfies Pick<WorkerEnvironmentService, "get" | "ready" | "stop" | "setHumanPresence">,
  };
});

vi.mock("./worker-environments/service.js", () => ({
  createWorkerEnvironmentService: vi.fn(
    (options: Parameters<typeof createWorkerEnvironmentService>[0]) => {
      mocks.createGatewayTools = options.createGatewayTools;
      mocks.prepareNodeArtifacts = options.prepareNodeArtifacts;
      return mocks.service;
    },
  ),
}));

vi.mock("./worker-environments/worker-session-tool-executor.js", () => ({
  createWorkerGatewayTools: mocks.createTools,
}));

import {
  createGatewayWorkerEnvironmentRuntime,
  loadGatewayWorkerEnvironmentStartupState,
} from "./server-worker-environment-startup.js";
import { withGatewayWorkerEnvironmentStartupState } from "./server-worker-environment-startup.state.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    mocks.createGatewayTools = undefined;
    mocks.prepareNodeArtifacts = undefined;
    vi.restoreAllMocks();
    vi.clearAllMocks();
    cleanup();
  }),
);

async function withWorkerRuntime(run: () => Promise<void>) {
  const stateDir = tempDirs.make("openclaw-worker-session-tool-lazy-");
  await withGatewayWorkerEnvironmentStartupState(stateDir, async () => {
    const startup = await loadGatewayWorkerEnvironmentStartupState();
    const registry = createEmptyPluginRegistry();
    await createGatewayWorkerEnvironmentRuntime({
      scheduler: createTestGatewayScheduler(),
      getPluginRegistry: () => registry,
      getPortalRuntime: () => undefined,
      resolveGatewayContext: () => undefined,
      desktopSessionRegistry: createDesktopSessionRegistry({ lingerMs: 1 }),
      startup,
      log: { child: () => ({ info: () => {}, warn: () => {} }) },
    });

    await run();
  });
}

describe("gateway worker tool-surface startup", () => {
  it("loads Gateway tools lazily and binds each requested surface", async () => {
    await withWorkerRuntime(async () => {
      expect(mocks.service.ready).toHaveBeenCalledOnce();
      expect(mocks.createTools).not.toHaveBeenCalled();
      const createGatewayTools = mocks.createGatewayTools;
      if (!createGatewayTools) {
        throw new Error("worker tool-surface callback was not composed");
      }
      const identity: WorkerConnectionIdentity = {
        environmentId: "environment",
        credentialHash: "credential",
        bundleHash: "bundle",
        sessionId: null,
        runId: null,
        turnClaim: null,
        ownerEpoch: 1,
        rpcSetVersion: 1,
        protocolFeatures: [],
        credentialExpiresAtMs: Date.now() + 60_000,
      };
      const results = await Promise.all([
        createGatewayTools({ identity }),
        createGatewayTools({ identity }),
      ]);
      expect(results).toEqual([[], []]);
      expect(results[0]).not.toBe(results[1]);
      expect(mocks.createTools).toHaveBeenCalledTimes(2);
      expect(mocks.createTools).toHaveBeenCalledWith(
        expect.objectContaining({ identity, environments: mocks.service }),
      );
    });
  });
});

it.each(["success", "failure", "abort"] as const)(
  "cold artifact preparation overlaps without late publication (outcome=%s)",
  async (outcome) => {
    const nodeArtifact = {
      tarballPath: "/synthetic/node.tgz",
      tarballSha256: "a".repeat(64),
      tarballBytes: 1,
      openclawVersion: "1.2.3",
      buildId: "fixture",
      enabledPluginIds: [],
    };
    const bundleArtifact = {
      install: "bundle" as const,
      tarballPath: "/synthetic/worker.tgz",
      tarballSha256: "b".repeat(64),
      tarballBytes: 1,
      bundleHash: "c".repeat(64),
      openclawVersion: "1.2.3",
      protocolFeatures: [],
    };
    const node = createDeferredCore<typeof nodeArtifact>();
    const bundle = createDeferredCore<typeof bundleArtifact>();
    const prepareNode = vi.fn(() => node.promise);
    const prepareBundle = vi.fn(() => bundle.promise);
    vi.spyOn(metadataState, "getGatewayPluginMetadataSnapshot").mockReturnValue(
      createPluginMetadataSnapshotFixture(),
    );
    vi.spyOn(version, "resolveRuntimeServiceBuildId").mockReturnValue("fixture");
    vi.spyOn(bootstrapArtifacts, "createNodeBootstrapArtifactProvider").mockReturnValue({
      prepare: prepareNode,
      close: async () => {},
    });
    vi.spyOn(bundles, "createWorkerBundleProducer").mockReturnValue({
      prepare: prepareBundle,
      prune: async () => {},
    });
    await withWorkerRuntime(async () => {
      const controller = new AbortController();
      const preparation = mocks.prepareNodeArtifacts!({}, controller.signal);
      const published = vi.fn();
      const rejected = vi.fn();
      void preparation.then(published, rejected);
      const failure = new Error("node artifact failed");
      try {
        await vi.dynamicImportSettled();
        if (outcome === "abort") {
          expect(prepareBundle).toHaveBeenCalledOnce();
          node.resolve(nodeArtifact);
          await vi.dynamicImportSettled();
          controller.abort();
          await vi.dynamicImportSettled();
          expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ name: "AbortError" }));
          expect(published).not.toHaveBeenCalled();
          bundle.reject(new Error("late bundle failure"));
          await vi.dynamicImportSettled();
          expect(published).not.toHaveBeenCalled();
        } else if (outcome === "failure") {
          node.reject(failure);
          await vi.dynamicImportSettled();
          expect(rejected).not.toHaveBeenCalled();
          expect(published).not.toHaveBeenCalled();
          bundle.reject(new Error("bundle artifact failed"));
          await expect(preparation).rejects.toBe(failure);
          expect(published).not.toHaveBeenCalled();
        } else {
          expect(prepareNode).toHaveBeenCalledOnce();
          expect(prepareBundle).toHaveBeenCalledOnce();
          expect(published).not.toHaveBeenCalled();
          node.resolve(nodeArtifact);
          bundle.resolve(bundleArtifact);
          await expect(preparation).resolves.toMatchObject({
            artifacts: { workerBundleHash: bundleArtifact.bundleHash },
          });
        }
      } finally {
        node.resolve(nodeArtifact);
        bundle.resolve(bundleArtifact);
        await preparation.catch(() => undefined);
      }
    });
  },
);
