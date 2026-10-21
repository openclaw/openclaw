import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, expect, it as baseIt, vi } from "vitest";
import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import * as diagnosticReadiness from "../../commands/gateway-diagnostic-readiness.js";
import { healthCommand } from "../../commands/health.js";
import { collectStatusLocalSnapshot } from "../../commands/status.agent-local.js";
import type { StatusScanOverviewResult } from "../../commands/status.scan-overview.ts";
import {
  baseStatusGatewaySnapshot,
  baseStatusOverviewSurface,
  createStatusCommandReportDataParams,
  createStatusScanResultFixture,
} from "../../commands/status.test-support.ts";
import { createTestRuntime } from "../../commands/test-runtime-config-helpers.js";
import * as configRuntime from "../../config/config.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import * as sessionReadRuntime from "../../config/sessions/session-entry-read-runtime.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { spyOnSessionStoreSummaries } from "../../config/sessions/session-store-summary.test-support.js";
import { historyLane } from "../../config/sessions/session-transcript-worker-resources.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDefaultProactiveJob } from "../../cron/default-proactive-job.js";
import { saveProactiveJobsForTest } from "../../cron/proactive-job.test-support.js";
import { recordAgentDatabaseAdmissions } from "../../state/agent-database-admission.js";
import { withAgentDatabaseCloseFence } from "../../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { prepareStatusSessionStores } from "../../status/session-stores.js";
import { beginAgentDeletionJournal } from "../../test-utils/agent-deletion-journal.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import * as gatewayCall from "../call.js";
import {
  buildHealthAgentSummaries,
  collectGatewayHealthSnapshot,
  resolveHealthAgentOrder,
} from "./collector.js";

vi.mock("../../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: () => [],
}));

const fixtureService = {
  label: "fixture",
  installed: false,
  loadState: { status: "unknown", detail: "fixture" },
  managedByOpenClaw: false,
  externallyManaged: false,
  loadedText: "unknown",
  loaded: false,
  runtime: undefined,
  runtimeShort: "not running",
} satisfies Awaited<
  ReturnType<typeof import("../../commands/status-runtime-shared.ts").resolveStatusServiceSummaries>
>[0];

async function summarizeStore(storePath: string, agentId: string) {
  const cfg: OpenClawConfig = {
    agents: { ownership: "explicit", entries: { [agentId]: {} } },
    session: { store: storePath },
  };
  const agents = await buildHealthAgentSummaries(cfg, resolveHealthAgentOrder(cfg));
  return expectDefined(agents[0], "health agent summary").sessions;
}

async function readStatusSessionStores(...args: Parameters<typeof prepareStatusSessionStores>) {
  return (await prepareStatusSessionStores(...args)).publish();
}

function holdWorkerSummary(pause: (count: number) => Promise<void>) {
  const run = historyLane.pool.run.bind(historyLane.pool);
  vi.spyOn(historyLane.pool, "run").mockImplementation(async (...args) => {
    const result = await run(...args);
    if (
      result.ok &&
      typeof result.value !== "boolean" &&
      !Array.isArray(result.value) &&
      result.value.kind === "session-store-summary"
    ) {
      await pause(result.value.summary.count);
    }
    return result;
  });
}

async function renderHealth(
  cfg: OpenClawConfig,
  health: Awaited<ReturnType<typeof collectGatewayHealthSnapshot>>,
) {
  vi.spyOn(gatewayCall, "callGateway").mockResolvedValueOnce(health);
  vi.spyOn(diagnosticReadiness, "waitForGatewayDiagnostic").mockResolvedValueOnce(1000);
  const runtime = createTestRuntime();
  await healthCommand({ config: cfg }, runtime);
  return stripAnsi(runtime.log.mock.calls.flat().join("\n"));
}

function deleteAgent(state: OpenClawTestState, operationId: string) {
  beginAgentDeletionJournal({
    agentId: "deleting",
    operationId,
    agentDir: state.agentDir("deleting"),
    sessionsDir: state.sessionsDir("deleting"),
    workspaceDir: state.workspaceDir,
    deleteFiles: true,
  });
}

function createReadGate() {
  const entered = createDeferred();
  const release = createDeferred();
  return {
    async pause() {
      entered.resolve();
      await release.promise;
    },
    async finish<P extends Promise<unknown>>(pending: P, change: () => void): Promise<Awaited<P>> {
      try {
        await awaitGateBeforeSettlement(entered.promise, pending, "Read skipped publication gate");
        change();
        release.resolve();
        return await pending;
      } finally {
        release.resolve();
        await pending.catch(() => {});
      }
    },
  };
}

async function seedAgents(cfg: OpenClawConfig, updatedAt = 1) {
  setRuntimeConfigSnapshot(cfg);
  for (const { id: agentId } of resolveHealthAgentOrder(cfg).ordered) {
    await sessionAccessor.upsertSessionEntryCore(
      { agentId, sessionKey: `agent:${agentId}:main`, storePath: cfg.session?.store },
      { sessionId: `${agentId}-session`, updatedAt },
    );
  }
}

function deletionConfig(withDefault = false): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      entries: { deleting: {}, survivor: {} },
      ...(withDefault ? { defaults: { systemAgent: { agentId: "deleting" } } } : {}),
    },
  };
}

function expectStatusSessions(
  status: Awaited<ReturnType<typeof readStatusSessionStores>>,
  ids: string[],
  shared: boolean,
) {
  expect(status.byAgent.map(({ agent }) => agent.id)).toEqual(ids);
  expect(status.count).toBe(ids.length + (shared ? 1 : 0));
  expect(status.recent.map(({ sessionKey }) => sessionKey).toSorted()).toEqual(
    [...ids.map((id) => `agent:${id}:main`), ...(shared ? ["agent:retired:main"] : [])].toSorted(),
  );
}

async function prepareDeletionStatusOverview(
  cfg: OpenClawConfig,
): Promise<StatusScanOverviewResult> {
  const local = await collectStatusLocalSnapshot(cfg);
  return {
    ...createStatusScanResultFixture({ cfg, sourceConfig: cfg, env: process.env }),
    skipColdStartNetworkChecks: false,
    runtimeDegradation: null,
    channelsStatus: null,
    gatewaySnapshot: { ...baseStatusGatewaySnapshot, gatewayReachable: false },
    agentStatus: local,
    sessionStores: local.sessionStores,
  };
}

const it = baseIt.extend<{ state: OpenClawTestState }>({
  state: async ({ task: _task }, use) =>
    withOpenClawTestState({ label: "health-publication" }, use),
});

const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-health-session-store-");

afterEach(async () => {
  vi.restoreAllMocks();
  recordAgentDatabaseAdmissions([], { source: "startup" });
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeStateDatabaseForTest();
});

it("scopes template stores and recovers from transient reads", async () => {
  const stateDir = tempDirs.make();
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const storeTemplate = path.join(stateDir, "stores", "{agentId}/sessions.json");
  const storePath = (agentId: string) =>
    resolveSessionStorePathCore(storeTemplate, { agentId, env });
  const databasePath = (agentId: string) =>
    resolveSqliteTargetFromSessionStorePath(storePath(agentId), { agentId, env }).path;
  expect(storePath("helper")).toBe(path.join(stateDir, "stores", "helper", "sessions.json"));
  await sessionAccessor.upsertSessionEntryCore(
    { agentId: "helper", env, sessionKey: "agent:helper:main", storePath: storePath("helper") },
    { sessionId: "session-1", updatedAt: 10 },
  );
  await closeOpenClawAgentDatabasesAsync(stateDir);
  closeOpenClawAgentDatabasesForTest(stateDir);

  vi.spyOn(configRuntime, "getRuntimeConfig").mockReturnValue({
    agents: { ownership: "explicit", entries: { helper: {}, third: {} } },
    session: { store: storeTemplate },
  });
  const { calls: reads } = spyOnSessionStoreSummaries();
  const collect = () => collectGatewayHealthSnapshot({ audience: "admin", probe: false });
  const summary = await collect();
  expect(summary.agents).toMatchObject([
    { agentId: "helper", sessions: { count: 1, path: databasePath("helper") } },
    { agentId: "third", sessions: { count: 0, path: databasePath("third") } },
  ]);
  expect(fs.existsSync(expectDefined(summary.agents[0], "populated agent").sessions.path)).toBe(
    true,
  );
  expect(summary.sessions).toEqual(summary.agents[0]?.sessions);
  expect(reads).toHaveBeenCalledTimes(2);

  reads
    .mockClear()
    .mockRejectedValueOnce(Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }));
  expect((await collect()).agents.map((agent) => agent.sessions.count)).toEqual([0, 0]);
  expect(reads).toHaveBeenCalledTimes(2);
  expect((await collect()).agents.map((agent) => agent.sessions.count)).toEqual([1, 0]);

  const fatal = new Error("invalid session state");
  reads.mockRejectedValueOnce(fatal);
  await expect(collect()).rejects.toBe(fatal);
});

it.each(["admission-refused", "owner-closed"] as const)(
  "does not publish a delayed worker summary after %s",
  async (change) => {
    const stateDir = tempDirs.make();
    const storePath = resolveSessionStorePathCore(undefined, {
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    await sessionAccessor.upsertSessionEntryCore(
      { agentId: "main", storePath, sessionKey: "agent:main:delayed" },
      { sessionId: "delayed-session", updatedAt: 1 },
    );
    const gate = createReadGate();
    holdWorkerSummary(async (count) => {
      expect(count).toBe(1);
      await gate.pause();
    });
    const pending = gate.finish(summarizeStore(storePath, "main"), () => {
      if (change === "admission-refused") {
        recordAgentDatabaseAdmissions(
          [
            {
              agentId: "main",
              paths: [storePath],
              code: "agent-database-inspection-pending",
              reason: "fixture admission changed",
              repairHint: "finish fixture inspection",
            },
          ],
          { source: "startup" },
        );
      } else {
        closeOpenClawAgentDatabasesForTest();
      }
    });
    if (change === "admission-refused") {
      await expect(pending).resolves.toMatchObject({ count: 0, recent: [] });
    } else {
      await expect(pending).rejects.toThrow(/revoked|no longer current/);
    }
  },
);

it.for([
  "before-read",
  "during-read",
  "only-agent",
  "late-status",
  "late-health",
  "late-shared-status",
] as const)(
  "omits committed deletions without aborting health or status (%s)",
  async (timing, { state }) => {
    const late = timing.startsWith("late-");
    const shared = timing === "late-shared-status";
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: timing === "only-agent" ? { deleting: {} } : { deleting: {}, survivor: {} },
        ...(timing === "late-health" ? { defaults: { systemAgent: { agentId: "deleting" } } } : {}),
      },
      ...(shared ? { session: { store: state.statePath("shared.sqlite") } } : {}),
    };
    if (timing === "late-health") {
      await saveProactiveJobsForTest(
        state.statePath("cron", "jobs.json"),
        ["deleting", "survivor"].map((agentId) =>
          createDefaultProactiveJob(cfg, agentId, 1, 60_000),
        ),
      );
    }
    await seedAgents(cfg, 10);
    const { ordered } = resolveHealthAgentOrder(cfg);
    if (shared) {
      await sessionAccessor.upsertSessionEntryCore(
        { agentId: "retired", sessionKey: "agent:retired:main", storePath: cfg.session?.store },
        { sessionId: "retired-session", updatedAt: 5 },
      );
    }
    const preparedLocal =
      timing === "late-health" ? await collectStatusLocalSnapshot(cfg) : undefined;
    const replied = createDeferred();
    const release = createDeferred();
    const read = sessionReadRuntime.withSessionStoreReaderInWorker;
    const laterRead = vi
      .spyOn(sessionReadRuntime, "withSessionStoreReaderInWorker")
      .mockImplementation(async (...args) => {
        const result = await read(...args);
        if (late && args[0].agentId === "survivor") {
          replied.resolve();
          await release.promise;
        }
        return result;
      });
    holdWorkerSummary(async () => {
      if (timing === "during-read") {
        replied.resolve();
        await release.promise;
      }
    });
    const collect = () => collectGatewayHealthSnapshot({ audience: "admin", probe: false });
    const pendingStatus =
      timing === "during-read" || (late && timing !== "late-health")
        ? readStatusSessionStores(cfg, ordered, 10)
        : undefined;
    const pendingHealth = timing === "late-health" ? collect() : undefined;
    const pending = pendingStatus ?? pendingHealth;
    void pending?.catch(() => {});
    try {
      if (pending) {
        await awaitGateBeforeSettlement(
          replied.promise,
          pending,
          "Summary settled before the deletion gate",
        );
      }
      deleteAgent(state, "health-deletion");
      await withAgentDatabaseCloseFence(
        { agentId: "deleting", rootPath: path.dirname(state.agentDir("deleting")) },
        async () => {
          release.resolve();
          const expectedIds = timing === "only-agent" ? [] : ["survivor"];
          if (pendingStatus) {
            expectStatusSessions(await pendingStatus, expectedIds, shared);
          }
          if (pendingHealth) {
            const health = await pendingHealth;
            expect(health.agents.map((agent) => agent.agentId)).toEqual(expectedIds);
            expect(health.sessions.count).toBe(expectedIds.length);
            expect(health.sessions.recent.map(({ key }) => key)).toEqual(
              expectedIds.map((id) => `agent:${id}:main`),
            );
            const output = await renderHealth(cfg, health);
            expect(output).toContain("Heartbeat interval: 1m (survivor)");
            expect(output).toContain("Session store (survivor):");
            const fallbackOutput = await renderHealth(cfg, {
              ...health,
              agents: [],
              defaultAgentId: "deleting",
            });
            expect(fallbackOutput).toContain("Heartbeat interval: 1m (survivor)");
            expect(fallbackOutput).toContain("Agents: survivor (default)");
            expect(fallbackOutput).toContain("Session store (survivor):");
            expect(fallbackOutput).not.toContain("Session store (deleting):");
            expect(health.defaultAgentId).toBe("survivor");
            expect(health.agents.find((agent) => agent.agentId === "survivor")?.isDefault).toBe(
              true,
            );
            expect(resolveHealthAgentOrder(cfg).defaultAgentId).toBe("deleting");
            expect(preparedLocal?.defaultId).toBe("deleting");
            expect(preparedLocal?.publish()).toMatchObject({
              defaultId: "survivor",
              agents: [{ id: "survivor" }],
            });
          }
          const health = await collect();
          expect(health.agents.map((agent) => agent.agentId)).toEqual(expectedIds);
          expect(health.sessions.count).toBe(expectedIds.length);
          expectStatusSessions(
            await readStatusSessionStores(cfg, ordered, 10),
            expectedIds,
            shared,
          );
        },
      );
    } finally {
      release.resolve();
      await pending?.catch(() => {});
      laterRead.mockRestore();
    }
  },
);

it.for(["desktop", "certificate"] as const)(
  "publishes status after deletion during the final %s preparation",
  async (phase, { state }) => {
    const cfg = deletionConfig(phase === "desktop");
    await seedAgents(cfg);
    const desktop = await import("../desktop/host-source.js");
    const certificate = await import("../../secrets/egress-proxy/registry.js");
    const { getStatusSummary } = await import("../../status/summary.js");
    const gate = createReadGate();
    const inspect = desktop.inspectHostDesktop;
    vi.spyOn(desktop, "inspectHostDesktop").mockImplementation(async (params) => {
      const result = await inspect(params);
      if (phase === "desktop") {
        await gate.pause();
      }
      return result;
    });
    vi.spyOn(certificate, "getSecretEgressCertificateStatus").mockImplementation(async () => {
      if (phase === "certificate") {
        await gate.pause();
      }
      return { state: "ready", caExpiresAt: "2099-01-01T00:00:00.000Z", failedCertificates: 0 };
    });
    const pending = getStatusSummary({
      config: cfg,
      includeSensitive: false,
      includeChannelSummary: false,
      includeCliProjection: true,
    });
    const summary = await gate.finish(pending, () => deleteAgent(state, "status-publication"));
    expect(summary).toMatchObject({
      sessions: { count: 1, byAgent: [{ agentId: "survivor" }] },
      heartbeat: { defaultAgentId: "survivor", agents: [{ agentId: "survivor" }] },
      cliProjection: {
        agents: {
          rows: [{ id: "survivor" }],
          defaultId: phase === "desktop" ? "survivor" : null,
          selectionRequired: phase !== "desktop",
        },
      },
    });
    expect(cfg.agents?.defaults?.systemAgent?.agentId).toBe(
      phase === "desktop" ? "deleting" : undefined,
    );
  },
);

it.for(["text", "json"] as const)(
  "publishes local %s status after final backup preparation",
  async (format, { state }) => {
    const cfg = deletionConfig(true);
    await seedAgents(cfg);
    const { executeStatusScanFromOverview } = await import("../../commands/status.scan-execute.ts");
    const scan = await executeStatusScanFromOverview({
      overview: await prepareDeletionStatusOverview(cfg),
      pluginCompatibility: [],
    });
    const backup = await import("../../state/backup-run-records.js");
    const engines = await import("../../commands/status-database-engines.js");
    const runtime = await import("../../commands/status-runtime-shared.ts");
    const { buildStatusCommandReportLines } =
      await import("../../commands/status.command-report.ts");
    const fastScan = await import("../../commands/status.scan.fast-json.js");
    const { runStatusJsonCommand } = await import("../../commands/status-json-command.ts");
    const runtimeOutput = await import("../../runtime.js");
    const updateStatus = await import("../../infra/update-run-status.js");
    vi.spyOn(fastScan, "scanStatusJsonFast").mockResolvedValue(scan);
    vi.spyOn(updateStatus, "readUpdateRunStatus").mockResolvedValue({});
    const jsonWrite = vi.spyOn(runtimeOutput, "writeRuntimeJson");
    const gate = createReadGate();
    const readBackup = backup.readBackupRunFreshness;
    vi.spyOn(backup, "readBackupRunFreshness").mockImplementation(async (env) => {
      const result = await readBackup(env);
      await gate.pause();
      return result;
    });
    // The regression owns session publication; unrelated service/engine I/O stays synthetic.
    vi.spyOn(engines, "resolveStatusDatabaseEngines").mockResolvedValue({
      source: "admitted",
      stores: [],
    });
    vi.spyOn(runtime, "resolveStatusRuntimeSnapshot").mockResolvedValue({
      securityAudit: undefined,
      usage: undefined,
      health: undefined,
      lastHeartbeat: null,
      gatewayService: fixtureService,
      nodeService: fixtureService,
    });
    const pending =
      format === "text"
        ? buildStatusCommandReportLines(
            createStatusCommandReportDataParams({
              ...scan,
              surface: { ...baseStatusOverviewSurface, ...scan },
              opts: {},
              health: undefined,
              lastHeartbeat: null,
              securityAudit: undefined,
              usageLines: undefined,
              pairingRecovery: null,
            }),
          )
        : runStatusJsonCommand({
            runtime: createTestRuntime(),
            opts: { gatewayProbeDeadlineMs: 0 },
          });
    const result = await gate.finish(pending, () =>
      deleteAgent(state, `status-${format}-publication`),
    );
    if (Array.isArray(result)) {
      const output = stripAnsi(result.join("\n"));
      expect(output).toContain("agent:survivor:main");
      expect(output).not.toContain("agent:deleting:main");
      expect(output).toContain("1 stored");
    } else {
      expect(expectDefined(jsonWrite.mock.lastCall, "status JSON output")[1]).toMatchObject({
        sessions: { count: 1, byAgent: [{ agentId: "survivor" }] },
        agents: { totalSessions: 1, agents: [{ id: "survivor" }] },
      });
    }
  },
);

it.for(["engines", "logs", "usage"] as const)(
  "publishes status --all after deletion during %s preparation",
  async (phase, { state }) => {
    const cfg = deletionConfig();
    await seedAgents(cfg);
    const overview = await prepareDeletionStatusOverview(cfg);
    const scan = await import("../../commands/status.scan-overview.ts");
    const runtime = await import("../../commands/status-runtime-shared.ts");
    const nodeMode = await import("../../commands/status.node-mode.js");
    const ports = await import("../../infra/ports-inspect.js");
    const diagnostics = await import("../../daemon/diagnostics.js");
    const logs = await import("../../commands/status-all/gateway.js");
    const rows = await import("../../commands/status-overview-rows.ts");
    const { statusAllCommand } = await import("../../commands/status-all.js");
    const gate = createReadGate();
    const pause = async (current: typeof phase) => {
      if (current === phase) {
        await gate.pause();
      }
    };
    // Keep external diagnostics fixed while the real local summary/report owners run.
    vi.spyOn(scan, "collectStatusScanOverview").mockResolvedValue(overview);
    vi.spyOn(runtime, "resolveStatusServiceSummaries").mockResolvedValue([
      fixtureService,
      fixtureService,
    ]);
    vi.spyOn(nodeMode, "resolveNodeOnlyGatewayInfo").mockResolvedValue({
      gatewayTarget: "fixture.invalid",
      gatewayValue: "fixture node",
      connectionDetails: "Fixture node-only Gateway",
    });
    vi.spyOn(ports, "inspectPortUsage").mockResolvedValue({
      port: 19443,
      status: "free",
      listeners: [],
      hints: [],
    });
    vi.spyOn(diagnostics, "readLastGatewayErrorLine").mockResolvedValue(null);
    vi.spyOn(gatewayCall, "isImplicitLocalGatewayTarget").mockImplementation(async () => {
      await pause("engines");
      return false;
    });
    vi.spyOn(logs, "readFileTailLines").mockImplementation(async () => {
      await pause("logs");
      return [];
    });
    vi.spyOn(runtime, "resolveStatusUsageSummary").mockImplementation(async () => {
      await pause("usage");
      return { updatedAt: 1, providers: [] };
    });
    const renderedRows = vi.spyOn(rows, "buildStatusAllOverviewRows");
    const output = createTestRuntime();
    const pending = statusAllCommand(output, {
      gatewayProbeDeadlineMs: 0,
      usage: phase === "usage",
    });
    await gate.finish(pending, () => deleteAgent(state, `status-all-${phase}-publication`));
    expect(expectDefined(renderedRows.mock.calls[0], "rendered overview")[0]).toMatchObject({
      summary: { sessions: { count: 1, byAgent: [{ agentId: "survivor" }] } },
      agentStatus: { totalSessions: 1, agents: [{ id: "survivor" }] },
    });
    const text = stripAnsi(output.log.mock.calls.flat().join("\n"));
    expect(text).toContain("survivor");
    expect(text).not.toContain("deleting");
  },
);

it.for([true, false])(
  "refills shared-store recent sessions and excludes deleted namespaces (configured: %s)",
  async (configured, { state }) => {
    const storePath = state.statePath("shared.sqlite");
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: configured ? { survivor: {}, deleting: {} } : { survivor: {} },
      },
      session: { store: storePath },
    };
    setRuntimeConfigSnapshot(cfg);
    for (const agentId of ["survivor", "deleting", "retired"]) {
      for (let index = 0; index < 12; index++) {
        const key = `agent:${agentId}:${String(index).padStart(2, "0")}`;
        replaceSessionEntrySync(
          { agentId, sessionKey: key, storePath },
          {
            sessionId: key,
            updatedAt: agentId === "deleting" ? 30 : agentId === "survivor" ? 20 : 10,
          },
        );
      }
    }
    deleteAgent(state, "shared-publication");
    const result = await readStatusSessionStores(cfg, resolveHealthAgentOrder(cfg).ordered, 10);
    expect(result.byAgent.map(({ agent }) => agent.id)).toEqual(["survivor"]);
    expect(result.count).toBe(24);
    expect(result.recent.map(({ sessionKey }) => sessionKey)).toEqual(
      Array.from({ length: 10 }, (_, index) => `agent:survivor:${String(index).padStart(2, "0")}`),
    );
  },
);

it.for(["snapshot", "read-error"] as const)(
  "handles deletion of a shared store's sole configured reader (%s)",
  async (outcome, { state }) => {
    const storePath = state.statePath("shared.sqlite");
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { deleting: {} } },
      session: { store: storePath },
    };
    setRuntimeConfigSnapshot(cfg);
    for (const agentId of ["deleting", "survivor"]) {
      replaceSessionEntrySync(
        { agentId, sessionKey: `agent:${agentId}:main`, storePath },
        { sessionId: `${agentId}-session`, updatedAt: 1 },
      );
    }
    const gate = createReadGate();
    const failure = new Error("invalid session state");
    const { calls } = spyOnSessionStoreSummaries();
    calls.mockImplementation(async (read) => {
      const summary = await read();
      await gate.pause();
      if (outcome === "read-error") {
        throw failure;
      }
      return summary;
    });
    const read = () => readStatusSessionStores(cfg, resolveHealthAgentOrder(cfg).ordered, 10);
    const pending = gate.finish(read(), () => deleteAgent(state, "shared-sole-reader"));
    if (outcome === "read-error") {
      await expect(pending).rejects.toBe(failure);
    } else {
      const expected = { count: 1, recent: [{ sessionKey: "agent:survivor:main" }] };
      expect(await pending).toMatchObject({ ...expected, byAgent: [] });
      expect(await read()).toMatchObject(expected);
    }
  },
);
