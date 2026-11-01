import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { recordPersistedContextEngineQuarantine } from "../context-engine/quarantine-health.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import * as pluginStateWorker from "../plugin-state/plugin-state-worker-client.js";
import * as pluginRuntime from "../plugins/runtime.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  clearInstanceBindingProbeCoordinators,
  INSTANCE_BINDING_PROBE_METHOD,
  type InstanceBindingProbeResult,
} from "./server-plugins.lifecycle.test-fixtures.js";
import {
  installInstanceBindingConfigIo,
  observePostReadyStartupMaintenance,
  prepareInstanceBindingFixture,
  startPluginGateway,
  closePluginGateway,
  reloadPlugin,
  type PluginServer,
  type PluginSocket,
} from "./server-plugins.lifecycle.test-support.js";
import { connectWebchatClient, installGatewayTestHooks, rpcReq } from "./test-helpers.server.js";

vi.doUnmock("../plugins/loader.js");
installGatewayTestHooks({ scope: "suite" });
installInstanceBindingConfigIo();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function readPersistedCount(databasePath: string, engineId: string) {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare(
        "SELECT count(*) AS count FROM plugin_state_entries WHERE plugin_id = ? AND namespace = ? AND entry_key = ?",
      )
      .get(
        "core:context-engine-quarantine-health",
        "runtime-quarantines",
        JSON.stringify([engineId, process.pid]),
      );
  } finally {
    database.close();
  }
}

function quarantine(engineId: string) {
  return recordPersistedContextEngineQuarantine({
    engineId,
    operation: "resolve",
    reason: "previous failure",
    failedAt: new Date(123),
  });
}

function holdHealthCleanup(
  engineId: string,
  reached: ReturnType<typeof createDeferred<void>>,
  release: ReturnType<typeof createDeferred<void>>,
) {
  const clear = pluginStateWorker.clearRuntimeHealthInWorker;
  return vi
    .spyOn(pluginStateWorker, "clearRuntimeHealthInWorker")
    .mockImplementation(async (params) => {
      await clear(params);
      if (params.selection.kind === "context-engine" && params.selection.engineId === engineId) {
        reached.resolve();
        await release.promise;
      }
    });
}

it.each([false, true])(
  "joins accepted activation cleanup through Gateway close (publication throws=%s)",
  { timeout: 600_000 },
  async (publicationThrows) => {
    const { coordinator } = await prepareInstanceBindingFixture(
      tempDirs.make("openclaw-activation-health-"),
    );
    const engineId = "gateway-activation-health";
    coordinator.contextEngineId = engineId;
    await quarantine(engineId);
    const databasePath = resolveOpenClawStateSqlitePath();
    expect(readPersistedCount(databasePath, engineId)).toEqual({ count: 1 });
    const reached = createDeferred();
    const release = createDeferred();
    const observer = holdHealthCleanup(engineId, reached, release);
    const kernelModule = await import("./server-kernel.js");
    const createKernel = kernelModule.createGatewayKernel;
    const publicationFailure = new Error("fixture publication failure after activation");
    const kernelSpy = vi
      .spyOn(kernelModule, "createGatewayKernel")
      .mockImplementationOnce(async (...args) => {
        const kernel = await createKernel(...args);
        const prepare = kernel.prepareAttachedPluginRuntime;
        return {
          ...kernel,
          prepareAttachedPluginRuntime: async (...prepareArgs) => {
            const attachment = await prepare(...prepareArgs);
            return {
              ...attachment,
              publish() {
                attachment.publish();
                if (publicationThrows) {
                  throw publicationFailure;
                }
              },
            };
          },
        };
      });
    let server: PluginServer | undefined;
    let closing: Promise<void> | undefined;
    try {
      ({ server } = await startPluginGateway({ sidecarStartup: "defer" }));
      const startupSettled = vi.fn<() => void>();
      const startup = server.startupSettled
        .catch((error: unknown) => error)
        .finally(startupSettled);
      await awaitGateBeforeSettlement(reached.promise, startup, "startup bypassed cleanup");
      const closed = vi.fn<() => void>();
      closing = server.close({ reason: "close during activation cleanup" }).then(closed);
      await setImmediate();
      expect(startupSettled).not.toHaveBeenCalled();
      expect(closed).not.toHaveBeenCalled();
      release.resolve();
      const [startupResult] = await Promise.all([startup, closing]);
      expect(startupResult).toBe(publicationThrows ? publicationFailure : undefined);
      expect(readPersistedCount(databasePath, engineId)).toEqual({ count: 0 });
    } finally {
      release.resolve();
      try {
        await (closing ?? server?.close({ reason: "activation health cleanup" }));
      } finally {
        observer.mockRestore();
        kernelSpy.mockRestore();
        clearInstanceBindingProbeCoordinators();
        delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
      }
    }
  },
);

it.each([false, true])(
  "joins plugin reload activation and recovery before its RPC result (publication refuses=%s)",
  { timeout: 600_000 },
  async (publicationRefuses) => {
    const { coordinator } = await prepareInstanceBindingFixture(
      tempDirs.make("openclaw-reload-health-"),
    );
    const engineId = "gateway-reload-health";
    coordinator.contextEngineId = engineId;
    coordinator.reportReloadSettlement = true;
    let server: PluginServer | undefined;
    let socket: PluginSocket | undefined;
    let reload: ReturnType<typeof rpcReq> | undefined;
    const release = createDeferred();
    let observer: { mockRestore: () => void } | undefined;
    let commit: { mockRestore: () => void } | undefined;
    try {
      const maintenance = await observePostReadyStartupMaintenance();
      const started = await startPluginGateway({});
      server = started.server;
      await server.startupSettled;
      await maintenance.settled;
      socket = await connectWebchatClient({ port: started.port, scopes: ["operator.admin"] });
      await quarantine(engineId);
      const databasePath = resolveOpenClawStateSqlitePath();
      expect(readPersistedCount(databasePath, engineId)).toEqual({ count: 1 });
      if (publicationRefuses) {
        commit = vi
          .spyOn(pluginRuntime, "commitStagedPluginRegistry")
          .mockImplementationOnce(() => {
            throw new Error("fixture publication refused before commit");
          });
      }
      const reached = createDeferred();
      observer = holdHealthCleanup(engineId, reached, release);
      const reloadSettled = vi.fn<() => void>();
      reload = reloadPlugin(socket).finally(reloadSettled);
      await awaitGateBeforeSettlement(reached.promise, reload, "reload bypassed cleanup");
      const probe = await rpcReq<InstanceBindingProbeResult>(
        socket,
        INSTANCE_BINDING_PROBE_METHOD,
        {},
      );
      expect(probe.ok, probe.error?.message).toBe(true);
      expect(probe.payload?.reloadSettled).toBe(false);
      expect(reloadSettled).not.toHaveBeenCalled();
      release.resolve();
      const result = await reload;
      expect(result.ok).toBe(!publicationRefuses);
      if (publicationRefuses) {
        expect(result.error?.message).toContain("fixture publication refused before commit");
      }
      expect(readPersistedCount(databasePath, engineId)).toEqual({ count: 0 });
    } finally {
      release.resolve();
      try {
        await Promise.allSettled(reload ? [reload] : []);
        await closePluginGateway(server, socket);
      } finally {
        observer?.mockRestore();
        commit?.mockRestore();
      }
    }
  },
);
