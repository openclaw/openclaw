import { expect, it, vi, onTestFinished } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { readConfigFileSnapshot } from "../config/io.js";
import { copyConfigResolutionFacts } from "../config/resolution-facts.js";
import { getRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  assignSessionOwner,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createAgentDatabaseInspectionRefusal,
  preparePendingAgentDatabase,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { startGatewayConfigReloader, type GatewayReloadPlan } from "./config-reload.js";
import { installWatcherMock } from "./config-reload.watcher.test-support.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { listProjectedSessions } from "./session-utils-list.js";

// The threaded projection fixture has no Gateway host broker; lease behavior has its own suite.
vi.mock("../plugins/plugin-lifecycle-lease.js", () => ({
  hasPluginLifecycleLease: () => false,
  runOutsidePluginLifecycleLease: (run: () => unknown) => run(),
  withPluginLifecycleLease: async (
    _options: unknown,
    run: (lease: { assertOwned: () => void }) => Promise<unknown>,
  ) => run({ assertOwned() {} }),
}));

it("retains resident rows across projection-neutral commits and unchanged admission", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const count = Number(process.env.OPENCLAW_PROJECTION_BENCH_ROWS ?? 16);
    await state.writeConfig({
      agents: { entries: { main: {} } },
      channels: { slack: { streaming: { mode: "off" } } },
    });
    const readSnapshot = () => readConfigFileSnapshot({ observe: false });
    const initial = await readSnapshot();
    expect(initial.valid, JSON.stringify(initial.issues)).toBe(true);
    let cfg = initial.config;
    setRuntimeConfigSnapshot(cfg);
    for (let index = 0; index < count; index++) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: `agent:main:config-${index}` },
        {
          sessionId: `config-${index}`,
          updatedAt: index + 1,
        },
      );
    }
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({
      cfg,
      getConfig: () => getRuntimeConfigSnapshot()!,
      modelCatalog: [],
    });
    const watcher = installWatcherMock();
    onTestFinished(watcher.restore);
    let applied = createDeferred<GatewayReloadPlan>();
    let dirtyAtCommit = 0;
    const commit: Parameters<typeof startGatewayConfigReloader>[0]["onHotReload"] = async (
      plan,
      next,
      ownership,
    ) => {
      await ownership.checkpoint();
      ownership.markRuntimeCommitted(next, plan);
      return "applied";
    };
    const reloader = startGatewayConfigReloader({
      scheduler: createTestGatewayScheduler("fake-timers"),
      initialConfig: cfg,
      initialCompareConfig: initial.sourceConfig,
      initialSnapshotRawHash: initial.hash ?? null,
      initialAuthoredConfig: initial.parsed,
      initialSnapshotValid: initial.valid,
      initialSnapshotIssues: initial.issues,
      testDebounceMs: 0,
      readSnapshot,
      promoteSnapshot: async () => true,
      watchPath: state.configPath,
      initialPluginInstallRecords: {},
      readPluginInstallRecords: async () => ({}),
      onHotReload: commit,
      onNoopConfigCommit: commit,
      onRuntimeConfigCommitted: (_plan, next) => {
        cfg = next;
        setRuntimeConfigSnapshot(cfg);
        dirtyAtCommit = projection.dirtyRowCount;
      },
      onConfigApplied: (plan) => applied.resolve(plan),
      onRestart: () => {
        throw new Error("fixture changes must hot apply");
      },
      log: {
        info: vi.fn(),
        warn: (message) => applied.reject(new Error(message)),
        error: (message) => applied.reject(new Error(message)),
      },
    });
    try {
      await reloader.ready;
      const readmit = async () => {
        const refusal = createAgentDatabaseInspectionRefusal({
          agentId: "main",
          paths: [resolveOpenClawAgentSqlitePath({ agentId: "main" })],
          pending: true,
          reason: "Reverification",
        });
        recordAgentDatabaseAdmissions([refusal], { source: "startup" });
        await preparePendingAgentDatabase(refusal, { assertCurrent() {} }, async () => {});
      };
      await projection.ensureMaterialized();
      for (const event of [
        "channel streaming",
        "ui.prefs",
        "unchanged admission",
        "agent roster",
      ] as const) {
        const before = projection.materializedCount;
        const started = performance.now();
        if (event === "unchanged admission") {
          await readmit();
        } else {
          const next: OpenClawConfig = {
            ...cfg,
            ...(event === "channel streaming"
              ? { channels: { slack: { streaming: { mode: "partial" as const } } } }
              : event === "ui.prefs"
                ? { ui: { prefs: { sidebarEntries: ["sessions"] } } }
                : {
                    agents: {
                      ...cfg.agents,
                      ownership: "explicit",
                      entries: { main: {}, other: {} },
                    },
                  }),
          };
          applied = createDeferred<GatewayReloadPlan>();
          await state.writeConfig(next);
          watcher.emit("change", state.configPath);
          const plan = await applied.promise;
          expect(plan.restartGateway).toBe(false);
        }
        const dirtyRows =
          event === "unchanged admission" ? projection.dirtyRowCount : dirtyAtCommit;
        const result = await listProjectedSessions({ projection, opts: { limit: 247 } });
        await projection.ensureMaterialized();
        const materializations = projection.materializedCount - before;
        console.log(
          JSON.stringify({
            event,
            count,
            dirtyRows,
            materializations,
            elapsedMs: performance.now() - started,
          }),
        );
        expect(result.totalCount).toBe(count);
        expect.soft(dirtyRows, event).toBe(event === "agent roster" ? count : 0);
        expect.soft(materializations, event).toBe(event === "agent roster" ? count : 0);
        expect(projection.state.cfg).toBe(cfg);
      }
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: "agent:main:config-0" },
        {
          sessionId: "config-0",
          updatedAt: count + 1,
          archivedAt: 1,
        },
      );
      assignSessionOwner(
        { agentId: "main", sessionKey: "agent:main:config-0" },
        { owner: { type: "agent", id: "main" }, assignedBy: { type: "system", id: "test" } },
      );
      const resident = await listProjectedSessions({
        projection,
        opts: { archived: "all", limit: 247 },
      });
      const residentRows = resident.sessions.map(({ snapshotAt: _snapshotAt, ...row }) => row);
      for (const [operation, model] of [
        ["add", "unit-test/talk-a"],
        ["change", "unit-test/talk-b"],
        ["remove", undefined],
      ] as const) {
        const event = `talk.realtime.model:${operation}`;
        const before = projection.materializedCount;
        const started = performance.now();
        applied = createDeferred<GatewayReloadPlan>();
        await state.writeConfig({
          ...cfg,
          talk: { realtime: model === undefined ? {} : { model } },
        });
        watcher.emit("change", state.configPath);
        const plan = await applied.promise;
        expect(plan.restartGateway).toBe(false);
        const dirtyRows = dirtyAtCommit;
        const result = await listProjectedSessions({
          projection,
          opts: { archived: "all", limit: 247 },
        });
        const materializations = projection.materializedCount - before;
        console.log(
          JSON.stringify({
            event,
            count,
            dirtyRows,
            materializations,
            elapsedMs: performance.now() - started,
          }),
        );
        expect(result.totalCount).toBe(count);
        expect(result.sessions.map(({ snapshotAt: _snapshotAt, ...row }) => row)).toEqual(
          residentRows,
        );
        expect.soft(dirtyRows, event).toBe(0);
        expect.soft(materializations, event).toBe(0);
        expect(projection.state.cfg).toBe(cfg);
      }
      const beforeRename = projection.materializedCount;
      const previousConfig = cfg;
      cfg = {
        ...cfg,
        agents: {
          ...cfg.agents,
          entries: {
            ...cfg.agents?.entries,
            main: { ...cfg.agents?.entries?.main, identity: { name: "After" } },
          },
        },
      };
      copyConfigResolutionFacts(previousConfig, cfg);
      setRuntimeConfigSnapshot(cfg);
      const renamed = await listProjectedSessions({
        projection,
        opts: { archived: "all", limit: 247 },
      });
      expect(renamed.sessions[0]?.owner?.actor.label).toBe("After");
      expect(projection.materializedCount).toBe(beforeRename);
      await readmit();
      const retained = await listProjectedSessions({
        projection,
        opts: { archived: "all", limit: 247 },
      });
      expect(retained.sessions[0]?.owner?.actor.label).toBe("After");
      expect(projection.dirtyRowCount).toBe(0);
      expect(projection.materializedCount).toBe(beforeRename);
    } finally {
      await reloader.stop();
      projection.dispose();
      release();
    }
  });
});
