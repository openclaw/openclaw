import { expect, it, vi, onTestFinished } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { readConfigFileSnapshot } from "../config/io.js";
import { copyConfigResolutionFacts } from "../config/resolution-facts.js";
import { getRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { assignSessionOwner } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createAgentDatabaseInspectionRefusal,
  preparePendingAgentDatabase,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { startGatewayConfigReloader, type GatewayReloadPlan } from "./config-reload.js";
import { ownedConfigReloadOptions } from "./config-reload.test-support.js";
import { installWatcherMock } from "./config-reload.watcher.test-support.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { seedRow } from "./session-row-projection.read-fixture.test-support.js";
import { listProjectedSessions } from "./session-utils-list.js";

type ReloadOptions = Parameters<typeof startGatewayConfigReloader>[0];

// The threaded projection fixture has no Gateway host broker; lease behavior has its own suite.
vi.mock("../plugins/plugin-lifecycle-lease.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-lifecycle-lease.js")>()),
  hasPluginLifecycleLease: () => false,
  withPluginLifecycleLease: async (
    _options: unknown,
    run: (lease: { assertCurrent: () => void; assertOwned: () => void }) => Promise<unknown>,
  ) => run({ assertCurrent() {}, assertOwned() {} }),
}));

it("retains resident rows across projection-neutral commits and unchanged admission", () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const count = 16;
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
      const sessionId = `config-${index}`;
      seedRow(`agent:main:${sessionId}`, { sessionId, updatedAt: index + 1 });
    }
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(retainSessionListForegroundWork());
    const projection = await createSessionRowProjection({
      cfg,
      getConfig: () => getRuntimeConfigSnapshot()!,
      modelCatalog: [],
    });
    cleanup.defer(() => projection.dispose());
    const watcher = installWatcherMock();
    onTestFinished(watcher.restore);
    let applied = createDeferred<GatewayReloadPlan>();
    const commit: ReloadOptions["onHotReload"] = async (plan, next, ownership) => {
      await ownership.checkpoint();
      ownership.markRuntimeCommitted(next, plan);
      return "applied";
    };
    const initialReload = await ownedConfigReloadOptions(initial, state.configPath);
    const { subscribeToWrites: _, ...initialOptions } = initialReload;
    const reject = (message: string) => applied.reject(new Error(message));
    const reloader = startGatewayConfigReloader({
      ...initialOptions,
      readSnapshot,
      promoteSnapshot: async () => true,
      onHotReload: commit,
      onNoopConfigCommit: commit,
      onRuntimeConfigCommitted: (_plan, next) => {
        cfg = next;
        setRuntimeConfigSnapshot(cfg);
      },
      onConfigApplied: (plan) => applied.resolve(plan),
      onRestart: () => {
        throw new Error("fixture changes must hot apply");
      },
      log: {
        info: vi.fn(),
        warn: reject,
        error: reject,
      },
    });
    cleanup.defer(() => reloader.stop());
    const reload = async (update: OpenClawConfig) => {
      applied = createDeferred<GatewayReloadPlan>();
      await state.writeConfig({ ...cfg, ...update });
      watcher.emit("change", state.configPath);
      expect((await applied.promise).restartGateway).toBe(false);
    };
    const list = (archived?: "all") =>
      listProjectedSessions({ projection, opts: { archived, limit: 247 } });
    const verifyRows = async (
      event: string,
      change: () => Promise<unknown>,
      expected = 0,
      archived?: "all",
    ) => {
      const before = projection.materializedCount;
      await change();
      const result = await list(archived);
      await projection.ensureMaterialized();
      expect(result.totalCount).toBe(count);
      expect.soft(projection.materializedCount - before, event).toBe(expected);
      return result;
    };
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
    await reloader.ready;
    await projection.ensureMaterialized();
    await list();
    for (const [event, update, expected] of [
      ["channel streaming", { channels: { slack: { streaming: { mode: "partial" } } } }, 0],
      ["ui.prefs", { ui: { prefs: { sidebarEntries: ["sessions"] } } }, 0],
      ["unchanged admission", undefined, 0],
      [
        "agent roster",
        { agents: { ...cfg.agents, ownership: "explicit", entries: { main: {}, other: {} } } },
        count,
      ],
    ] satisfies [string, OpenClawConfig | undefined, number][]) {
      await verifyRows(event, () => (update ? reload(update) : readmit()), expected);
    }
    const scope = { agentId: "main", sessionKey: "agent:main:config-0" };
    seedRow(scope.sessionKey, {
      sessionId: "config-0",
      updatedAt: count + 1,
      archivedAt: 1,
    });
    assignSessionOwner(scope, {
      owner: { type: "agent", id: "main" },
      assignedBy: { type: "system", id: "test" },
    });
    const residentRows = (await list("all")).sessions.map(
      ({ snapshotAt: _snapshotAt, ...row }) => row,
    );
    for (const model of ["unit-test/talk-a", "unit-test/talk-b", undefined]) {
      const result = await verifyRows(
        `Talk model: ${model}`,
        () => reload({ talk: { realtime: model === undefined ? {} : { model } } }),
        0,
        "all",
      );
      expect(result.sessions.map(({ snapshotAt: _snapshotAt, ...row }) => row)).toEqual(
        residentRows,
      );
    }
    const beforeRename = projection.materializedCount;
    const previousConfig = cfg;
    const renamed = { ...cfg.agents?.entries?.main, identity: { name: "After" } };
    cfg = {
      ...cfg,
      agents: { ...cfg.agents, entries: { ...cfg.agents?.entries, main: renamed } },
    };
    copyConfigResolutionFacts(previousConfig, cfg);
    setRuntimeConfigSnapshot(cfg);
    expect((await list("all")).sessions[0]?.owner?.actor.label).toBe("After");
    expect(projection.materializedCount).toBe(beforeRename);
    await readmit();
    expect((await list("all")).sessions[0]?.owner?.actor.label).toBe("After");
    expect(projection.dirtyRowCount).toBe(0);
    expect(projection.materializedCount).toBe(beforeRename);
  }));
