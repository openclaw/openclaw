import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeEach, describe, expect, it as baseIt, vi } from "vitest";
import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
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
import * as combinedStore from "../../config/sessions/combined-store-gateway-read.js";
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
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { recordAgentDatabaseAdmissions } from "../../state/agent-database-admission.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import {
  registerOpenClawAgentDatabaseAsyncResource,
  withAgentDatabaseCloseFence,
} from "../../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { prepareStatusSessionStores } from "../../status/session-stores.js";
import { beginAgentDeletionJournal } from "../../test-utils/agent-deletion-journal.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import * as gatewayCall from "../call.js";
import { createSessionLifecyclePublisher } from "../server-chat-lifecycle-publication.js";
import { createSessionEventSubscriberRegistry } from "../server-chat-state.js";
import { drainSessionEventPublications } from "../session-event-prepared-row.js";
import type { SessionRowProjection } from "../session-row-projection.js";
import { createTestProjection } from "../session-row-projection.read-fixture.test-support.js";
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
  const cfg = sessionConfig([agentId], storePath);
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
    async after<T>(pending: Promise<T>, hold = true) {
      const result = await pending;
      if (hold) {
        await this.pause();
      }
      return result;
    },
    async run<T>(
      pending: Promise<unknown> | undefined,
      action: (resume: () => void) => Promise<T>,
    ): Promise<T> {
      try {
        if (pending) {
          await awaitGateBeforeSettlement(entered.promise, pending, "Read skipped gate");
        }
        return await action(release.resolve);
      } finally {
        release.resolve();
        await pending?.catch(() => {});
      }
    },
    finish<T>(pending: Promise<T>, change: () => void): Promise<T> {
      return this.run(pending, async (resume) => {
        change();
        resume();
        return await pending;
      });
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

function writeSession(
  agentId: string,
  key: string,
  updatedAt: number,
  storePath?: string,
  sessionId = key,
) {
  replaceSessionEntrySync({ agentId, sessionKey: key, storePath }, { sessionId, updatedAt });
}

function seedWindows(storePath: string, times: Record<string, number>, reverse = false) {
  const suffixes = Array.from({ length: 12 }, (_, index) => String(index).padStart(2, "0"));
  for (const [agentId, updatedAt] of Object.entries(times)) {
    for (const suffix of reverse ? suffixes.toReversed() : suffixes) {
      writeSession(agentId, `agent:${agentId}:${suffix}`, updatedAt, storePath);
    }
  }
  return suffixes;
}

function sessionConfig(
  agentIds = ["deleting", "survivor"],
  store?: string,
  defaultAgentId?: string,
): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      entries: Object.fromEntries(agentIds.map((id) => [id, {}])),
      ...(defaultAgentId ? { defaults: { systemAgent: { agentId: defaultAgentId } } } : {}),
    },
    ...(store ? { session: { store } } : {}),
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
    const cfg = sessionConfig(
      timing === "only-agent" ? ["deleting"] : undefined,
      shared ? state.statePath("shared.sqlite") : undefined,
      timing === "late-health" ? "deleting" : undefined,
    );
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
    const gate = createReadGate();
    const read = sessionReadRuntime.withSessionStoreReaderInWorker;
    const laterRead = vi
      .spyOn(sessionReadRuntime, "withSessionStoreReaderInWorker")
      .mockImplementation((...args) =>
        gate.after(read(...args), late && args[0].agentId === "survivor"),
      );
    holdWorkerSummary(async () => {
      if (timing === "during-read") {
        await gate.pause();
      }
    });
    const collect = () => collectGatewayHealthSnapshot({ audience: "admin", probe: false });
    const pendingStatus =
      timing === "during-read" || (late && timing !== "late-health")
        ? readStatusSessionStores(cfg, ordered, 10)
        : undefined;
    const pendingHealth = timing === "late-health" ? collect() : undefined;
    const pending = pendingStatus ?? pendingHealth;
    await gate.run(pending, async (resume) => {
      deleteAgent(state, "health-deletion");
      await withAgentDatabaseCloseFence(
        { agentId: "deleting", rootPath: path.dirname(state.agentDir("deleting")) },
        async () => {
          resume();
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
    });
    laterRead.mockRestore();
  },
);

it.for(["desktop", "certificate"] as const)(
  "publishes status after deletion during the final %s preparation",
  async (phase, { state }) => {
    const cfg = sessionConfig(undefined, undefined, phase === "desktop" ? "deleting" : undefined);
    await seedAgents(cfg);
    const desktop = await import("../desktop/host-source.js");
    const certificate = await import("../../secrets/egress-proxy/registry.js");
    const { getStatusSummary } = await import("../../status/summary.js");
    const gate = createReadGate();
    const inspect = desktop.inspectHostDesktop;
    vi.spyOn(desktop, "inspectHostDesktop").mockImplementation((params) =>
      gate.after(inspect(params), phase === "desktop"),
    );
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
    const cfg = sessionConfig(undefined, undefined, "deleting");
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
    vi.spyOn(backup, "readBackupRunFreshness").mockImplementation((env) =>
      gate.after(readBackup(env)),
    );
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
    const result = await gate.finish<void | string[]>(pending, () =>
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
    const cfg = sessionConfig();
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
    const cfg = sessionConfig(configured ? ["survivor", "deleting"] : ["survivor"], storePath);
    setRuntimeConfigSnapshot(cfg);
    seedWindows(storePath, { survivor: 20, deleting: 30, retired: 10 });
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
    const cfg = sessionConfig(["deleting"], storePath);
    setRuntimeConfigSnapshot(cfg);
    for (const agentId of ["deleting", "survivor"]) {
      writeSession(agentId, `agent:${agentId}:main`, 1, storePath, `${agentId}-session`);
    }
    const gate = createReadGate();
    const failure = new Error("invalid session state");
    const { calls } = spyOnSessionStoreSummaries();
    calls.mockImplementation(async (read) => {
      const summary = await gate.after(read());
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

describe("resident session projection", () => {
  // Keep WAL maintenance outside the request SQL budget.
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => vi.useRealTimers());
  const test = baseIt.extend<{ state: OpenClawTestState }>({
    state: async ({ task: _task }, use) => withOpenClawTestState({ scenario: "minimal" }, use),
  });

  async function settleProjection(projection: SessionRowProjection) {
    do {
      await projection.ensureMaterialized();
    } while (projection.needsMaterialization);
  }

  function readHealth(cfg: OpenClawConfig, projection: SessionRowProjection) {
    return buildHealthAgentSummaries(cfg, resolveHealthAgentOrder(cfg), projection);
  }

  function sessionSummary(count: number, ...entries: [key: string, updatedAt: number][]) {
    return { count, recent: entries.map(([key, updatedAt]) => ({ key, updatedAt })) };
  }

  function summarizeStatus(status: Awaited<ReturnType<typeof readStatusSessionStores>>) {
    const keys = (rows: typeof status.recent) => rows.map((row) => row.sessionKey);
    return {
      paths: status.paths.length,
      count: status.count,
      recent: keys(status.recent),
      byAgent: status.byAgent.map(({ agent, count, recent }) => [agent.id, count, keys(recent)]),
    };
  }

  test("reuses idle health sessions while refreshing heartbeat, age and changed rows", async ({
    state,
  }) => {
    const cfg = sessionConfig(["main"], undefined, "main");
    setRuntimeConfigSnapshot(cfg);
    writeSession("main", "agent:main:first", 100);
    const job = createDefaultProactiveJob(cfg, "main", 1, 60_000);
    const cronPath = state.statePath("cron", "jobs.json");
    await saveProactiveJobsForTest(cronPath, [job]);
    using projection = await createTestProjection({ cfg });
    await settleProjection(projection);
    const select = vi.spyOn(projection, "selectEntries");
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    expect(await readHealth(cfg, projection)).toMatchObject([
      {
        heartbeat: { enabled: true, everyMs: 60_000 },
        sessions: { count: 1, recent: [{ key: "agent:main:first", age: 900 }] },
      },
    ]);
    expect(select).toHaveBeenCalledTimes(1);

    job.schedule = { kind: "every", everyMs: 120_000, anchorMs: 1 };
    await saveProactiveJobsForTest(cronPath, [job]);
    now.mockReturnValue(2_000);
    expect(await readHealth(cfg, projection)).toMatchObject([
      {
        heartbeat: { enabled: true, everyMs: 120_000 },
        sessions: { count: 1, recent: [{ key: "agent:main:first", age: 1_900 }] },
      },
    ]);
    expect(select).toHaveBeenCalledTimes(1);

    writeSession("main", "agent:main:second", 200);
    await settleProjection(projection);
    select.mockImplementationOnce(() => {
      throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    });
    expect((await readHealth(cfg, projection))[0]?.sessions.count).toBe(0);
    const current = await readHealth(cfg, projection);
    expect(current[0]?.sessions).toMatchObject(
      sessionSummary(2, ["agent:main:second", 200], ["agent:main:first", 100]),
    );
    expect(select).toHaveBeenCalledTimes(3);
    await readHealth(cfg, projection);
    expect(select).toHaveBeenCalledTimes(3);
  });

  test("projects receipt-owned jobs for the whole fleet without re-walking the roster per agent", async ({
    state,
  }) => {
    const agentCount = 200;
    const entries = Object.fromEntries(
      Array.from({ length: agentCount }, (_, index) => [`agent-${index}`, {}]),
    );
    const plain = {
      agents: { ownership: "explicit", entries },
      session: { store: state.statePath("health-sessions.sqlite") },
    } satisfies OpenClawConfig;
    const job = createDefaultProactiveJob(plain, "agent-7", 1, 45 * 60 * 1000);
    await saveProactiveJobsForTest(state.statePath("cron", "jobs.json"), [job]);
    let rosterReads = 0;
    const agents = new Proxy(plain.agents, {
      get(target, property, receiver) {
        if (property === "entries") {
          rosterReads += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const summaries = await buildHealthAgentSummaries(
      { ...plain, agents },
      resolveHealthAgentOrder(plain),
    );

    expect(summaries).toHaveLength(agentCount);
    expect(rosterReads).toBeLessThan(agentCount);
    expect(summaries.filter((summary) => summary.heartbeat.enabled)).toMatchObject([
      { agentId: "agent-7", heartbeat: { enabled: true, everyMs: 2_700_000, target: "owner" } },
    ]);
  });
  test.for(["before-read", "during-topology"])(
    "reads surviving health summaries when an unrelated agent closes %s",
    async (phase, { state }) => {
      const cfg: OpenClawConfig = { agents: { entries: { main: {}, retiring: {} } } };
      setRuntimeConfigSnapshot(cfg);
      for (const agentId of ["main", "retiring"]) {
        writeSession(agentId, `agent:${agentId}:main`, 1, undefined, `${agentId}-session`);
      }
      using projection = await createTestProjection({ cfg, modelCatalog: [] });
      const closing = createDeferred();
      const release = createDeferred();
      let closed: Promise<unknown> | undefined;
      let unregister: (() => void) | undefined;
      try {
        await settleProjection(projection);
        const retiringPath = resolveOpenClawAgentSqlitePath({ agentId: "retiring" });
        const startClosing = () => {
          beginAgentDeletionJournal({
            agentId: "retiring",
            operationId: "delete-retiring",
            agentDir: path.dirname(retiringPath),
            workspaceDir: state.statePath("workspace-retiring"),
            sessionsDir: state.statePath("agents", "retiring", "sessions"),
            deleteFiles: false,
          });
          unregister = registerOpenClawAgentDatabaseAsyncResource({
            agentId: "retiring",
            path: retiringPath,
            revoke: closing.resolve,
            close: () => release.promise,
          });
          closed = closeOpenClawAgentDatabaseByPathAsync(retiringPath, "retiring");
        };
        if (phase === "during-topology") {
          const prepare = combinedStore.prepareCombinedSessionStoreForGatewayAsync;
          vi.spyOn(
            combinedStore,
            "prepareCombinedSessionStoreForGatewayAsync",
          ).mockImplementationOnce(async (...args) => {
            const captured = await prepare(...args);
            startClosing();
            await closing.promise;
            return captured;
          });
          sessionChanges.emit({ all: true, scope: "stores" });
        } else {
          startClosing();
          await closing.promise;
        }
        const summaries = await readHealth(cfg, projection);
        expect(summaries.map(({ agentId, sessions }) => [agentId, sessions.count])).toEqual([
          ["main", 1],
        ]);
        expect(summaries[0]?.sessions.recent[0]?.key).toBe("agent:main:main");
        const subscribers = createSessionEventSubscriberRegistry();
        subscribers.subscribe("observer");
        const broadcast = vi.fn();
        const publisher = createSessionLifecyclePublisher({
          broadcastToConnIds: broadcast,
          sessionEventSubscribers: subscribers,
          getSessionRowProjection: () => projection,
          persistGatewaySessionLifecycleEventForEvent: async () => {},
          loadGatewaySessionLifecycleSnapshotForEvent: (key, options) => ({
            row:
              options?.sessionRows?.describe({ key, agentId: options.agentId ?? "main" })
                ?.materialized.row ?? null,
          }),
        });
        publisher.publish({
          phase: "end",
          sessionKey: "agent:main:main",
          agentId: "main",
          clientRunId: "survivor-run",
          event: {
            runId: "survivor-run",
            sessionId: "main-session",
            seq: 1,
            stream: "lifecycle",
            ts: 2,
            data: { phase: "end" },
          },
          persistence: Promise.resolve(),
          projection,
        });
        await Promise.resolve();
        await drainSessionEventPublications(projection);
        expect(broadcast).toHaveBeenCalledWith(
          "sessions.changed",
          expect.objectContaining({
            phase: "end",
            sessionKey: "agent:main:main",
            sessionId: "main-session",
          }),
          new Set(["observer"]),
          expect.any(Object),
        );
      } finally {
        release.resolve();
        await closed;
        unregister?.();
      }
    },
  );

  test("serves dirty summaries without display joins and clean repeats without SQL", async ({
    signal,
    state,
  }) => {
    const storePath = state.statePath("health-selection.sqlite");
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {} } },
      session: { store: storePath },
    };
    setRuntimeConfigSnapshot(cfg);
    const first = "agent:main:first";
    const second = "agent:main:second";
    const added = "agent:main:added";
    writeSession("main", first, 10, storePath);
    writeSession("main", second, 20, storePath);
    using projection = await createTestProjection({ cfg });
    const release = createDeferred();
    const displayJoined = createDeferred();
    let held: Promise<void> | undefined;
    let health: ReturnType<typeof buildHealthAgentSummaries> | undefined;
    try {
      await settleProjection(projection);
      writeSession("main", first, 25, storePath);
      expect(projection.dirtyRowCount).toBeGreaterThan(0);
      const dirtyStatus = await readStatusSessionStores(cfg, [{ id: "main" }], 10, { projection });
      expect(dirtyStatus.byAgent[0]?.recent[0]?.entry.updatedAt).toBe(25);
      await settleProjection(projection);
      held = projection.withSelectionPreparation(() => release.promise);
      sessionChanges.emit({ all: true, scope: "catalog" });
      writeSession("main", first, 30, storePath);
      writeSession("main", added, 40, storePath);
      expect(projection.dirtyRowCount).toBeGreaterThan(0);
      const ensureMaterialized = projection.ensureMaterialized;
      vi.spyOn(projection, "ensureMaterialized").mockImplementation(() => {
        // Observe the real blocked join so the regression fails without a wall-clock race.
        displayJoined.resolve();
        return ensureMaterialized();
      });
      health = readHealth(cfg, projection);
      const outcome = await withinTest(
        Promise.race([
          health.then((agents) => ({ kind: "summary", agents })),
          displayJoined.promise.then(() => ({ kind: "display-join" })),
        ]),
        signal,
      );
      expect(outcome).toMatchObject({
        kind: "summary",
        agents: [
          {
            agentId: "main",
            sessions: sessionSummary(3, [added, 40], [first, 30], [second, 20]),
          },
        ],
      });
      expect(projection.dirtyRowCount).toBeGreaterThan(0);
    } finally {
      release.resolve();
      await Promise.allSettled([held, health]);
      await settleProjection(projection);
    }
    const sql = observeMainThreadSql();
    expect((await readHealth(cfg, projection))[0]?.sessions).toMatchObject(
      sessionSummary(3, [added, 40], [first, 30], [second, 20]),
    );
    await readHealth(cfg, projection);
    sql.expectIdle();
  });

  test("keeps shared-store counts and windows SQL-free after agent admission", async ({
    state,
  }) => {
    const storePath = state.statePath("shared-sessions.sqlite");
    let cfg = sessionConfig(["main"], storePath, "main");
    setRuntimeConfigSnapshot(cfg);
    const agentIds = ["main", "worker"];
    const suffixes = seedWindows(storePath, { main: 10, worker: 20 }, true);
    const sessionKeys = agentIds.flatMap((id) => suffixes.map((suffix) => `agent:${id}:${suffix}`));
    using projection = await createTestProjection({ cfg, getConfig: () => cfg });
    await settleProjection(projection);
    expect((await readHealth(cfg, projection)).map(({ agentId }) => agentId)).toEqual(["main"]);
    cfg = sessionConfig(["main", "worker"], storePath, "main");
    setRuntimeConfigSnapshot(cfg);
    sessionChanges.emit({ all: true, scope: "config" });
    await settleProjection(projection);
    const sql = observeMainThreadSql();
    const agents = agentIds.map((id) => ({ id }));
    for (const limit of [-2.5, 0, 0.5, 5, 5.7, 10, Infinity, Number.NaN]) {
      expect(
        summarizeStatus(await readStatusSessionStores(cfg, agents, limit, { projection })),
      ).toEqual({
        paths: 1,
        count: 24,
        recent: [...sessionKeys.slice(12), ...sessionKeys.slice(0, 12)].slice(0, limit),
        byAgent: agentIds.map((id) => [
          id,
          12,
          suffixes.slice(0, limit).map((s) => `agent:${id}:${s}`),
        ]),
      });
    }
    for (const limit of [0, 5]) {
      const subset = await readStatusSessionStores(
        cfg,
        [{ id: "main" }, { id: "empty" }, { id: "main" }],
        limit,
        { projection },
      );
      expect(summarizeStatus(subset)).toMatchObject({
        count: 24,
        recent: sessionKeys.slice(12, 12 + limit),
        byAgent: [
          ["main", 12, sessionKeys.slice(0, limit)],
          ["empty", 0, []],
          ["main", 12, sessionKeys.slice(0, limit)],
        ],
      });
    }
    const health = await readHealth(cfg, projection);
    expect(health.map((agent) => agent.agentId)).toEqual(agentIds);
    for (const agent of health) {
      expect(agent.sessions.count).toBe(12);
      expect(agent.sessions.recent.map((row) => row.key)).toEqual(
        suffixes.slice(0, 5).map((suffix) => `agent:${agent.agentId}:${suffix}`),
      );
    }
    sql.expectIdle();
  });
});
