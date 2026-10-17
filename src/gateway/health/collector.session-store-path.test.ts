import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import * as diagnosticReadiness from "../../commands/gateway-diagnostic-readiness.js";
import { healthCommand } from "../../commands/health.js";
import { collectStatusLocalSnapshot } from "../../commands/status.agent-local.js";
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
import { recordAgentDatabaseAdmissions } from "../../state/agent-database-admission.js";
import { withAgentDatabaseCloseFence } from "../../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { prepareStatusSessionStores } from "../../status/session-stores.js";
import { beginAgentDeletionJournal } from "../../test-utils/agent-deletion-journal.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
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

describe("health session store paths", () => {
  const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-health-session-store-");

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await closeStateDatabaseForTest();
  });

  it("scopes template stores and recovers from transient reads", async () => {
    const stateDir = tempDirs.make();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const storeTemplate = path.join(stateDir, "stores", "{agentId}/sessions.json");
    const populatedAgentId = "helper";
    const populatedStorePath = resolveSessionStorePathCore(storeTemplate, {
      agentId: populatedAgentId,
      env,
    });
    const populatedDatabasePath = resolveSqliteTargetFromSessionStorePath(populatedStorePath, {
      agentId: populatedAgentId,
      env,
    }).path;

    expect(populatedStorePath).toBe(
      path.join(stateDir, "stores", populatedAgentId, "sessions.json"),
    );
    await sessionAccessor.upsertSessionEntryCore(
      {
        agentId: populatedAgentId,
        env,
        sessionKey: `agent:${populatedAgentId}:main`,
        storePath: populatedStorePath,
      },
      { sessionId: "session-1", updatedAt: 10 },
    );
    await closeOpenClawAgentDatabasesAsync(stateDir);
    closeOpenClawAgentDatabasesForTest(stateDir);

    const populated = await summarizeStore(populatedStorePath, populatedAgentId);
    const emptyAgentId = "third";
    const emptyStorePath = resolveSessionStorePathCore(storeTemplate, {
      agentId: emptyAgentId,
      env,
    });
    const empty = await summarizeStore(emptyStorePath, emptyAgentId);

    expect(populated).toMatchObject({ count: 1, path: populatedDatabasePath });
    expect(fs.existsSync(populated.path)).toBe(true);
    expect(empty).toMatchObject({
      count: 0,
      path: resolveSqliteTargetFromSessionStorePath(emptyStorePath, {
        agentId: emptyAgentId,
        env,
      }).path,
    });

    vi.spyOn(configRuntime, "getRuntimeConfig").mockReturnValue({
      agents: { ownership: "explicit", entries: { helper: {}, third: {} } },
      session: { store: storeTemplate },
    });
    const { calls: reads } = spyOnSessionStoreSummaries();
    const collect = () => collectGatewayHealthSnapshot({ audience: "admin", probe: false });
    const summary = await collect();
    expect(summary.agents.map((agent) => [agent.agentId, agent.sessions.count])).toEqual([
      [populatedAgentId, 1],
      [emptyAgentId, 0],
    ]);
    expect(summary.sessions).toEqual(summary.agents[0]?.sessions);
    expect(reads).toHaveBeenCalledTimes(2);

    reads
      .mockClear()
      .mockRejectedValueOnce(
        Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }),
      );
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
      const replied = createDeferred();
      const release = createDeferred();
      const run = historyLane.pool.run.bind(historyLane.pool);
      const held = vi.spyOn(historyLane.pool, "run").mockImplementation(async (...args) => {
        const result = await run(...args);
        if (
          result.ok &&
          typeof result.value !== "boolean" &&
          !Array.isArray(result.value) &&
          result.value.kind === "session-store-summary"
        ) {
          expect(result.value.summary.count).toBe(1);
          replied.resolve();
          await release.promise;
        }
        return result;
      });
      const pending = summarizeStore(storePath, "main");
      try {
        await awaitGateBeforeSettlement(replied.promise, pending, "Summary bypassed its worker");
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
        release.resolve();
        if (change === "admission-refused") {
          await expect(pending).resolves.toMatchObject({ count: 0, recent: [] });
        } else {
          await expect(pending).rejects.toThrow(/revoked|no longer current/);
        }
      } finally {
        release.resolve();
        await pending.catch(() => {});
        held.mockRestore();
        recordAgentDatabaseAdmissions([], { source: "startup" });
      }
    },
  );

  it.each([
    "before-read",
    "during-read",
    "only-agent",
    "late-status",
    "late-health",
    "late-shared-status",
  ] as const)(
    "omits committed deletions without aborting health or status (%s)",
    async (timing) => {
      await withOpenClawTestState({ label: "health-agent-deletion" }, async (state) => {
        const late = timing.startsWith("late-");
        const shared = timing === "late-shared-status";
        const cfg: OpenClawConfig = {
          agents: {
            ownership: "explicit",
            entries: timing === "only-agent" ? { deleting: {} } : { deleting: {}, survivor: {} },
            ...(timing === "late-health"
              ? { defaults: { systemAgent: { agentId: "deleting" }, heartbeat: { every: "1m" } } }
              : {}),
          },
          ...(shared ? { session: { store: state.statePath("shared.sqlite") } } : {}),
        };
        setRuntimeConfigSnapshot(cfg);
        const { ordered } = resolveHealthAgentOrder(cfg);
        for (const { id } of ordered) {
          await sessionAccessor.upsertSessionEntryCore(
            { agentId: id, sessionKey: `agent:${id}:main`, storePath: cfg.session?.store },
            { sessionId: `${id}-session`, updatedAt: 10 },
          );
        }
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
        const run = historyLane.pool.run.bind(historyLane.pool);
        const held = vi.spyOn(historyLane.pool, "run").mockImplementation(async (...args) => {
          const result = await run(...args);
          if (
            timing === "during-read" &&
            result.ok &&
            typeof result.value !== "boolean" &&
            !Array.isArray(result.value) &&
            result.value.kind === "session-store-summary"
          ) {
            replied.resolve();
            await release.promise;
          }
          return result;
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
          beginAgentDeletionJournal({
            agentId: "deleting",
            operationId: "health-deletion",
            agentDir: state.agentDir("deleting"),
            sessionsDir: state.sessionsDir("deleting"),
            workspaceDir: state.workspaceDir,
            deleteFiles: true,
          });
          await withAgentDatabaseCloseFence(
            { agentId: "deleting", rootPath: path.dirname(state.agentDir("deleting")) },
            async () => {
              release.resolve();
              const expectedIds = timing === "only-agent" ? [] : ["survivor"];
              const expectedCount = expectedIds.length + (shared ? 1 : 0);
              const expectedRecent = [
                ...expectedIds.map((id) => `agent:${id}:main`),
                ...(shared ? ["agent:retired:main"] : []),
              ];
              if (pendingStatus) {
                const status = await pendingStatus;
                expect(status.byAgent.map(({ agent }) => agent.id)).toEqual(expectedIds);
                expect(status.count).toBe(expectedCount);
                expect(status.recent.map(({ sessionKey }) => sessionKey).toSorted()).toEqual(
                  expectedRecent.toSorted(),
                );
              }
              if (pendingHealth) {
                const health = await pendingHealth;
                expect(health.agents.map((agent) => agent.agentId)).toEqual(expectedIds);
                expect(health.sessions.count).toBe(expectedIds.length);
                expect(health.sessions.recent.map(({ key }) => key)).toEqual(
                  expectedIds.map((id) => `agent:${id}:main`),
                );
                vi.spyOn(gatewayCall, "callGateway").mockResolvedValueOnce(health);
                vi.spyOn(diagnosticReadiness, "waitForGatewayDiagnostic").mockResolvedValueOnce(
                  1000,
                );
                const runtime = createTestRuntime();
                await healthCommand({ config: cfg }, runtime);
                const output = stripAnsi(runtime.log.mock.calls.flat().join("\n"));
                expect(output).toContain("Heartbeat interval: 1m (survivor)");
                expect(output).toContain("Session store (survivor):");
                expect(health.defaultAgentId).toBe("survivor");
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
              const status = await readStatusSessionStores(cfg, ordered, 10);
              expect(status.byAgent.map(({ agent }) => agent.id)).toEqual(expectedIds);
              expect(status.count).toBe(expectedCount);
              expect(status.recent.map(({ sessionKey }) => sessionKey).toSorted()).toEqual(
                expectedRecent.toSorted(),
              );
            },
          );
        } finally {
          release.resolve();
          await pending?.catch(() => {});
          held.mockRestore();
          laterRead.mockRestore();
        }
      });
    },
  );

  it.each(["desktop", "certificate"] as const)(
    "publishes status after deletion during the final %s preparation",
    async (phase) => {
      await withOpenClawTestState({ label: "status-final-publication" }, async (state) => {
        const cfg: OpenClawConfig = {
          agents: {
            ownership: "explicit",
            entries: { deleting: {}, survivor: {} },
            ...(phase === "desktop" ? { defaults: { systemAgent: { agentId: "deleting" } } } : {}),
          },
        };
        setRuntimeConfigSnapshot(cfg);
        for (const id of ["deleting", "survivor"]) {
          await sessionAccessor.upsertSessionEntryCore(
            { agentId: id, sessionKey: `agent:${id}:main` },
            { sessionId: `${id}-session`, updatedAt: 1 },
          );
        }
        const desktop = await import("../desktop/host-source.js");
        const certificate = await import("../../secrets/egress-proxy/registry.js");
        const { getStatusSummary } = await import("../../status/summary.js");
        const entered = createDeferred();
        const release = createDeferred();
        const inspect = desktop.inspectHostDesktop;
        vi.spyOn(desktop, "inspectHostDesktop").mockImplementation(async (params) => {
          const result = await inspect(params);
          if (phase === "desktop") {
            entered.resolve();
            await release.promise;
          }
          return result;
        });
        vi.spyOn(certificate, "getSecretEgressCertificateStatus").mockImplementation(async () => {
          if (phase === "certificate") {
            entered.resolve();
            await release.promise;
          }
          return { state: "ready", caExpiresAt: "2099-01-01T00:00:00.000Z", failedCertificates: 0 };
        });
        const pending = getStatusSummary({
          config: cfg,
          includeSensitive: false,
          includeChannelSummary: false,
          includeCliProjection: true,
        });
        try {
          await awaitGateBeforeSettlement(
            entered.promise,
            pending,
            "Status skipped final preparation",
          );
          beginAgentDeletionJournal({
            agentId: "deleting",
            operationId: "status-publication",
            agentDir: state.agentDir("deleting"),
            sessionsDir: state.sessionsDir("deleting"),
            workspaceDir: state.workspaceDir,
            deleteFiles: true,
          });
          release.resolve();
          const summary = await pending;
          expect(summary.sessions.byAgent.map(({ agentId }) => agentId)).toEqual(["survivor"]);
          expect(summary.sessions.count).toBe(1);
          expect(summary.heartbeat.agents.map(({ agentId }) => agentId)).toEqual(["survivor"]);
          expect(summary.cliProjection?.agents.rows.map(({ id }) => id)).toEqual(["survivor"]);
          expect(summary.heartbeat.defaultAgentId).toBe("survivor");
          expect(summary.cliProjection?.agents.defaultId).toBe(
            phase === "desktop" ? "survivor" : null,
          );
          expect(summary.cliProjection?.agents.selectionRequired).toBe(phase !== "desktop");
          expect(cfg.agents?.defaults?.systemAgent?.agentId).toBe(
            phase === "desktop" ? "deleting" : undefined,
          );
        } finally {
          release.resolve();
          await pending.catch(() => {});
        }
      });
    },
  );

  it.each([true, false])(
    "refills shared-store recent sessions and excludes deleted namespaces (configured: %s)",
    async (configured) => {
      await withOpenClawTestState({ label: "status-shared-publication" }, async (state) => {
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
        beginAgentDeletionJournal({
          agentId: "deleting",
          operationId: "shared-publication",
          agentDir: state.agentDir("deleting"),
          sessionsDir: state.sessionsDir("deleting"),
          workspaceDir: state.workspaceDir,
          deleteFiles: true,
        });
        const result = await readStatusSessionStores(cfg, resolveHealthAgentOrder(cfg).ordered, 10);
        expect(result.byAgent.map(({ agent }) => agent.id)).toEqual(["survivor"]);
        expect(result.count).toBe(24);
        expect(result.recent.map(({ sessionKey }) => sessionKey)).toEqual(
          Array.from(
            { length: 10 },
            (_, index) => `agent:survivor:${String(index).padStart(2, "0")}`,
          ),
        );
      });
    },
  );

  it.each(["snapshot", "read-error"] as const)(
    "handles deletion of a shared store's sole configured reader (%s)",
    async (outcome) => {
      await withOpenClawTestState({ label: "status-shared-sole-reader" }, async (state) => {
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
        const entered = createDeferred();
        const release = createDeferred();
        const failure = new Error("invalid session state");
        const { calls } = spyOnSessionStoreSummaries();
        calls.mockImplementation(async (read) => {
          const summary = await read();
          entered.resolve();
          await release.promise;
          if (outcome === "read-error") {
            throw failure;
          }
          return summary;
        });
        const pending = readStatusSessionStores(cfg, resolveHealthAgentOrder(cfg).ordered, 10);
        try {
          await awaitGateBeforeSettlement(entered.promise, pending, "Summary skipped the store");
          beginAgentDeletionJournal({
            agentId: "deleting",
            operationId: "shared-sole-reader",
            agentDir: state.agentDir("deleting"),
            sessionsDir: state.sessionsDir("deleting"),
            workspaceDir: state.workspaceDir,
            deleteFiles: true,
          });
          release.resolve();
          if (outcome === "read-error") {
            await expect(pending).rejects.toBe(failure);
          } else {
            const summary = await pending;
            expect(summary.byAgent).toEqual([]);
            expect(summary.count).toBe(1);
            expect(summary.recent.map(({ sessionKey }) => sessionKey)).toEqual([
              "agent:survivor:main",
            ]);
            const refreshed = await readStatusSessionStores(
              cfg,
              resolveHealthAgentOrder(cfg).ordered,
              10,
            );
            expect(refreshed.count).toBe(1);
            expect(refreshed.recent.map(({ sessionKey }) => sessionKey)).toEqual([
              "agent:survivor:main",
            ]);
          }
        } finally {
          release.resolve();
          await pending.catch(() => {});
        }
      });
    },
  );
});
