import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { recordPersistedContextEngineQuarantine } from "../context-engine/quarantine-health.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import * as pluginStateWorker from "../plugin-state/plugin-state-worker-client.js";
import * as pluginRuntime from "../plugins/runtime.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import {
  clearInstanceBindingProbeCoordinators,
  INSTANCE_BINDING_PROBE_METHOD,
  type InstanceBindingProbeResult,
} from "./server-plugins.lifecycle.test-fixtures.js";
import {
  installInstanceBindingConfigIo,
  prepareInstanceBindingFixture,
} from "./server-plugins.lifecycle.test-support.js";
import {
  connectWebchatClient,
  installGatewayTestHooks,
  rpcReq,
  startTestGatewayServer,
} from "./test-helpers.server.js";

vi.doUnmock("../plugins/loader.js");
installGatewayTestHooks({ scope: "suite" });
installInstanceBindingConfigIo();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// Post-ready maintenance refreshes the derived registry under the plugin lifecycle lease, and
// plugins.reload refuses a busy lease instead of queueing. Tests await that refresh first.
async function observePostReadyStartupMaintenance(): Promise<{ settled: Promise<void> }> {
  const startupPlugins = await import("./server-startup-plugins.js");
  const runMaintenance = startupPlugins.runGatewayPostReadyStartupMaintenance;
  const settled = createDeferred();
  const observer = vi
    .spyOn(startupPlugins, "runGatewayPostReadyStartupMaintenance")
    .mockImplementation((params) => {
      const maintenance = runMaintenance(params);
      maintenance.then(settled.resolve, settled.resolve);
      return maintenance;
    });
  onTestFinished(() => observer.mockRestore());
  return { settled: settled.promise };
}

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

it.each([false, true])(
  "joins accepted activation cleanup through Gateway close (publication throws=%s)",
  { timeout: 600_000 },
  async (publicationThrows) => {
    const { coordinator, restoreChannelRuntimeLoader } = await prepareInstanceBindingFixture(
      tempDirs.make("openclaw-activation-health-"),
    );
    const engineId = "gateway-activation-health";
    coordinator.contextEngineId = engineId;
    await recordPersistedContextEngineQuarantine({
      engineId,
      operation: "resolve",
      reason: "previous failure",
      failedAt: new Date(123),
    });
    const databasePath = resolveOpenClawStateSqlitePath();
    expect(readPersistedCount(databasePath, engineId)).toEqual({ count: 1 });
    const reached = createDeferred();
    const release = createDeferred();
    const clear = pluginStateWorker.clearRuntimeHealthInWorker;
    const observer = vi
      .spyOn(pluginStateWorker, "clearRuntimeHealthInWorker")
      .mockImplementation(async (params) => {
        await clear(params);
        if (params.selection.kind === "context-engine" && params.selection.engineId === engineId) {
          reached.resolve();
          await release.promise;
        }
      });
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
    let server: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;
    let closing: Promise<void> | undefined;
    try {
      const claim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
      server = await startTestGatewayServer(claim, {
        auth: { mode: "none" },
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });
      let startupSettled = false;
      const startup = server.startupSettled.then(
        () => {
          startupSettled = true;
          return undefined;
        },
        (error: unknown) => {
          startupSettled = true;
          return error;
        },
      );
      expect(
        await Promise.race([reached.promise.then(() => "worker"), startup.then(() => "settled")]),
      ).toBe("worker");
      let closed = false;
      closing = server.close({ reason: "close during activation cleanup" }).then(() => {
        closed = true;
      });
      await setImmediate();
      expect(startupSettled).toBe(false);
      expect(closed).toBe(false);
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
        restoreChannelRuntimeLoader?.();
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
    const { coordinator, restoreChannelRuntimeLoader } = await prepareInstanceBindingFixture(
      tempDirs.make("openclaw-reload-health-"),
    );
    const engineId = "gateway-reload-health";
    coordinator.contextEngineId = engineId;
    coordinator.reportReloadSettlement = true;
    let server: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;
    let socket: Awaited<ReturnType<typeof connectWebchatClient>> | undefined;
    let reload: ReturnType<typeof rpcReq> | undefined;
    const release = createDeferred();
    let observer: { mockRestore: () => void } | undefined;
    let commit: { mockRestore: () => void } | undefined;
    try {
      const maintenance = await observePostReadyStartupMaintenance();
      const claim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
      server = await startTestGatewayServer(claim, {
        auth: { mode: "none" },
        controlUiEnabled: false,
        sidecarStartup: "start",
      });
      await server.startupSettled;
      await maintenance.settled;
      socket = await connectWebchatClient({ port: claim.port, scopes: ["operator.admin"] });
      await recordPersistedContextEngineQuarantine({
        engineId,
        operation: "resolve",
        reason: "previous failure",
        failedAt: new Date(123),
      });
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
      const clear = pluginStateWorker.clearRuntimeHealthInWorker;
      observer = vi
        .spyOn(pluginStateWorker, "clearRuntimeHealthInWorker")
        .mockImplementation(async (params) => {
          const selected =
            params.selection.kind === "context-engine" && params.selection.engineId === engineId;
          await clear(params);
          if (selected) {
            reached.resolve();
            await release.promise;
          }
        });
      let reloadSettled = false;
      reload = rpcReq(socket, "plugins.reload", {
        plugins: [{ pluginId: "instance-binding-probe" }],
      }).then((result) => {
        reloadSettled = true;
        return result;
      });
      const phase = await Promise.race([
        reached.promise.then(() => "worker"),
        reload.then(() => "settled"),
      ]);
      expect(phase).toBe("worker");
      const probe = await rpcReq<InstanceBindingProbeResult>(
        socket,
        INSTANCE_BINDING_PROBE_METHOD,
        {},
      );
      expect(probe.ok, probe.error?.message).toBe(true);
      expect(probe.payload?.reloadSettled).toBe(false);
      expect(reloadSettled).toBe(false);
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
        socket?.close();
        await server?.close({ reason: "reload health cleanup" });
      } finally {
        observer?.mockRestore();
        commit?.mockRestore();
        restoreChannelRuntimeLoader?.();
        clearInstanceBindingProbeCoordinators();
        delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
      }
    }
  },
);
