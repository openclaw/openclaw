import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import { buildStatusCommandOverviewRows } from "../commands/status-overview-rows.ts";
import { collectStatusLocalSnapshot } from "../commands/status.agent-local.js";
import { createStatusCommandOverviewRowsParams } from "../commands/status.test-support.ts";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  replaceSessionEntry,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { readSessionStoreSummaryReadOnly } from "../config/sessions/session-accessor.sqlite-summary.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { spyOnSessionStoreSummaries } from "../config/sessions/session-store-summary.test-support.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import { getStatusSummary } from "../status/summary.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { formatStatusSummary } from "../tui/tui-status-summary.js";

describe("getStatusSummary read-only session access", () => {
  const previousRegistry = getActivePluginRegistry();
  const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-status-session-stores-");

  beforeEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  afterEach(async () => {
    cliBackendsTesting.resetDepsForTest();
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await closeStateDatabaseForTest();
  });

  afterAll(() => {
    if (previousRegistry) {
      setActivePluginRegistry(previousRegistry);
    }
  });

  it("does not create session state while reporting an absent proactive automation", async () => {
    const tempDir = tempDirs.make();
    const databasePath = path.join(tempDir, "openclaw-agent.sqlite");

    const summary = await getStatusSummary({
      includeChannelSummary: false,
      config: { session: { store: databasePath } },
    });

    expect(summary.heartbeat.agents[0]).toMatchObject({ enabled: false, waitingForRoute: false });
    expect(fs.existsSync(databasePath)).toBe(false);
  });

  it.each(["sessions.json", "shared.sqlite"])(
    "reports each agent's activity and reads each physical session store once for %s",
    async (fileName) => {
      const tempDir = tempDirs.make();
      const storePath = path.join(tempDir, fileName);
      const config = {
        agents: {
          ownership: "explicit" as const,
          defaults: { systemAgent: { agentId: "main" } },
          entries: { main: {}, ops: {} },
        },
        session: { store: storePath },
      };

      try {
        for (const agentId of ["main", "ops"]) {
          const logicalPath = resolveSessionStorePathCore(config.session.store, { agentId });
          await replaceSessionEntry(
            { agentId, sessionKey: `agent:${agentId}:main`, storePath: logicalPath },
            { sessionId: `${agentId}-session`, updatedAt: agentId === "main" ? 10 : 20 },
          );
        }
        await closeOpenClawAgentDatabasesAsync(tempDir);
        closeOpenClawAgentDatabasesForTest(tempDir);

        const expectedPaths = ["main", "ops"].map(
          (agentId) => resolveSqliteTargetFromSessionStorePath(storePath, { agentId }).path,
        );
        const uniquePaths = [...new Set(expectedPaths)];
        const { calls: readSummary, restore: restoreSummary } = spyOnSessionStoreSummaries();
        const now = vi.spyOn(Date, "now").mockReturnValue(100);
        try {
          const summary = await getStatusSummary({ includeChannelSummary: false, config });

          expect(summary.sessions.count).toBe(2);
          expect(summary.sessions.paths).toEqual(uniquePaths);
          expect(
            summary.sessions.byAgent.map((agent) => [
              agent.agentId,
              agent.path,
              agent.count,
              agent.recent.map((session) => [session.agentId, session.key]),
            ]),
          ).toEqual([
            ["main", expectedPaths[0], 1, [["main", "agent:main:main"]]],
            ["ops", expectedPaths[1], 1, [["ops", "agent:ops:main"]]],
          ]);
          expect(readSummary).toHaveBeenCalledTimes(uniquePaths.length);

          readSummary.mockClear();
          const { agentStatus: local } = await collectStatusLocalSnapshot(config);
          expect(local.totalSessions).toBe(2);
          expect(
            local.agents.map((agent) => [
              agent.id,
              agent.sessionsCount,
              agent.lastUpdatedAt,
              agent.lastActiveAgeMs,
            ]),
          ).toEqual([
            ["main", 1, 10, 90],
            ["ops", 1, 20, 80],
          ]);
          expect(readSummary).toHaveBeenCalledTimes(uniquePaths.length);
          expect(uniquePaths.every((databasePath) => fs.existsSync(databasePath))).toBe(true);
        } finally {
          restoreSummary();
          now.mockRestore();
        }
      } finally {
        await closeOpenClawAgentDatabasesAsync(tempDir);
        closeOpenClawAgentDatabasesForTest(tempDir);
        await closeStateDatabaseForTest();
      }
    },
  );

  it("does not reread ambient config while projecting prepared session runtime state", async () => {
    await withOpenClawTestState(
      { prefix: "openclaw-status-prepared-config-", layout: "split" },
      async (state) => {
        const storePath = state.path("sessions.json");
        const config = { session: { store: storePath } };
        await state.writeConfig({ session: {} });
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: "agent:main:main", storePath },
          { sessionId: "prepared-config", updatedAt: 10 },
        );
        await closeOpenClawAgentDatabasesAsync(state.root);
        closeOpenClawAgentDatabasesForTest(state.root);
        clearRuntimeConfigSnapshot();
        const readFileSync = vi.spyOn(fs, "readFileSync");
        try {
          await getStatusSummary({ includeChannelSummary: false, config });
          expect(
            readFileSync.mock.calls.filter(([file]) => file === state.configPath),
          ).toHaveLength(0);
        } finally {
          readFileSync.mockRestore();
        }
      },
    );
  });

  it("shares one local session snapshot across the complete status scan", async () => {
    await withOpenClawTestState({ prefix: "openclaw-status-scan-snapshot-" }, async (state) => {
      const config = {
        agents: { entries: { main: {} } },
        gateway: { mode: "remote" as const, remote: { url: "ws://127.0.0.1:1", token: "fixture" } },
        plugins: { enabled: false },
      };
      await state.writeConfig(config);
      const storePath = resolveSessionStorePathCore(undefined, { agentId: "main", env: state.env });
      for (let index = 1; index <= 12; index += 1) {
        replaceSessionEntrySync(
          { agentId: "main", storePath, sessionKey: `agent:main:scan-${index}` },
          {
            sessionId: `scan-${index}`,
            updatedAt: index,
            skillsSnapshot: { prompt: "private fixture", skills: [] },
          },
        );
      }
      const { calls: readSummary, restore: restoreSummary } = spyOnSessionStoreSummaries();
      try {
        const { scanStatus } = await import("../commands/status.scan.js");
        const timeline = state.path("status-timeline.jsonl");
        const scan = await withEnvAsync(
          { OPENCLAW_DIAGNOSTICS: "timeline", OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: timeline },
          () => scanStatus({ timeoutMs: 100, gatewayProbeDeadlineMs: performance.now() + 100 }),
        );
        expect(scan.agentStatus.totalSessions).toBe(12);
        expect(scan.agentStatus.agents[0]?.lastUpdatedAt).toBe(12);
        expect(scan.summary.sessions.count).toBe(12);
        expect(scan.summary.sessions.recent.map(({ key }) => key)).toEqual(
          Array.from({ length: 10 }, (_, index) => `agent:main:scan-${12 - index}`),
        );
        expect(readSummary).toHaveBeenCalledOnce();
        expect(JSON.stringify(scan)).not.toContain("private fixture");
        expect(scan).not.toHaveProperty("sessionStores");
        (await import("../infra/diagnostics-timeline.js")).flushDiagnosticsTimeline();
        const timings = fs.readFileSync(timeline, "utf8");
        for (const stage of [
          "status.config",
          "status.gateway-probe",
          "status.session-stores",
          "status.summary",
        ]) {
          expect(timings).toContain(`"stage":"${stage}"`);
        }
      } finally {
        restoreSummary();
      }
    });
  });

  it("keeps an authored context cap through a runtime provider alias", async () => {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: ({ backend }) =>
        backend === "claude-cli"
          ? {
              pluginId: "anthropic",
              backend: {
                id: "claude-cli",
                modelProvider: "anthropic",
                config: { command: "claude" },
                bundleMcp: false,
              },
            }
          : undefined,
      resolvePluginSetupRegistry: () => {
        throw new Error("setup registry should not load for a targeted runtime alias");
      },
      resolveRuntimeCliBackends: () => [],
    });
    await withOpenClawTestState({ prefix: "openclaw-status-runtime-alias-cap-" }, async (state) => {
      const storePath = resolveSessionStorePathCore(undefined, {
        agentId: "main",
        env: state.env,
      });
      const config = {
        agents: { defaults: { model: "anthropic/claude-opus-5" } },
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://api.anthropic.com",
              models: [
                {
                  id: "claude-opus-5",
                  name: "Claude Opus 5",
                  reasoning: true,
                  input: ["text" as const],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 1_000_000,
                  contextTokens: 272_000,
                  maxTokens: 8_192,
                },
              ],
            },
          },
        },
        session: { store: storePath },
      };
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:main", storePath },
        {
          sessionId: "runtime-alias-authored-cap",
          updatedAt: 10,
          modelProvider: "claude-cli",
          model: "claude-opus-5",
          agentHarnessId: "claude-cli",
          contextTokens: 272_000,
          contextTokensSource: "resolved",
          totalTokens: 121_000,
          totalTokensFresh: true,
          totalTokensVersion: 1,
        },
      );
      await closeOpenClawAgentDatabasesAsync(state.root);
      closeOpenClawAgentDatabasesForTest(state.root);

      const summary = await getStatusSummary({ includeChannelSummary: false, config });
      const session = summary.sessions.recent[0];

      expect(session?.contextTokens).toBe(272_000);
      expect(session?.percentUsed).toBe(44);
    });
  });

  it.each([false, true])(
    "labels archived and retired shared-store rows as stored (all archived: %s)",
    async (allArchived) => {
      await withOpenClawTestState({ prefix: "openclaw-status-stored-count-" }, async (state) => {
        const storePath = state.path("shared.sqlite");
        const config = {
          agents: {
            entries: { main: {}, ops: {} },
          },
          session: { store: storePath },
        };
        for (const [agentId, name, archived] of [
          ["main", "current", allArchived],
          ["main", "history", true],
          ["ops", "history", true],
          ["retired", "history", true],
        ] as const) {
          replaceSessionEntrySync(
            { agentId, storePath, sessionKey: `agent:${agentId}:${name}` },
            {
              sessionId: `${agentId}-${name}`,
              updatedAt: 1,
              ...(archived ? { archivedAt: 2 } : {}),
            },
          );
        }
        await closeOpenClawAgentDatabasesAsync(state.root);
        closeOpenClawAgentDatabasesForTest(state.root);

        const stored = readSessionStoreSummaryReadOnly(
          { agentId: "main", storePath },
          { agentIds: ["main", "ops"], recentLimit: 10 },
        );
        expect(stored.count).toBe(4);
        expect(stored.recent.filter(({ entry }) => entry.archivedAt !== undefined)).toHaveLength(
          allArchived ? 4 : 3,
        );
        const summary = await getStatusSummary({ config, includeChannelSummary: false });
        expect(summary.sessions.count).toBe(4);
        expect(summary.sessions.paths).toEqual([storePath]);
        expect(summary.sessions.byAgent.map(({ agentId, count }) => [agentId, count])).toEqual([
          ["main", 2],
          ["ops", 1],
        ]);
        const rows = buildStatusCommandOverviewRows(
          createStatusCommandOverviewRowsParams({ summary }),
        );
        expect(rows.find(({ Item }) => Item === "Sessions")?.Value).toMatch(/^4 stored · default /);
        const tuiLines = formatStatusSummary(summary);
        expect(tuiLines).toContain("Stored sessions: 4");
        expect(tuiLines).not.toContain("Active sessions: 4");
      });
    },
  );

  it("keeps session payload hydration off the status caller", async () => {
    await withOpenClawTestState({ prefix: "openclaw-status-recent-window-" }, async (state) => {
      const config = {
        agents: { entries: { main: {} } },
      };
      const storePath = resolveSessionStorePathCore(undefined, {
        agentId: "main",
        env: state.env,
      });
      for (let index = 1; index <= 24; index += 1) {
        replaceSessionEntrySync(
          { agentId: "main", storePath, sessionKey: `agent:main:history-${index}` },
          {
            sessionId: `status-history-${index}`,
            updatedAt: index,
            pluginExtensions: {
              fixture: { history: Array.from({ length: 64 }, () => "x".repeat(128)) },
            },
          },
        );
      }
      await getStatusSummary({ config, includeChannelSummary: false });
      const clone = vi.spyOn(globalThis, "structuredClone");
      const parse = vi.spyOn(JSON, "parse");
      const parsedSessionPayloads = () =>
        parse.mock.calls.filter(([json]) => json.includes('"sessionId":"status-history-'));
      try {
        const summary = await getStatusSummary({ config, includeChannelSummary: false });

        expect(parsedSessionPayloads()).toHaveLength(0);
        expect(summary.sessions.count).toBe(24);
        expect(summary.sessions.byAgent[0]?.count).toBe(24);
        expect(summary.sessions.recent.map(({ key }) => key)).toEqual(
          Array.from({ length: 10 }, (_, index) => `agent:main:history-${24 - index}`),
        );
        expect(
          clone.mock.calls.filter(([value]) => {
            const sessionId = (value as { sessionId?: unknown })?.sessionId;
            return typeof sessionId === "string" && sessionId.startsWith("status-history-");
          }),
        ).toHaveLength(0);

        parse.mockClear();
        const hidden = await getStatusSummary({
          config,
          includeChannelSummary: false,
          includeSensitive: false,
        });
        expect(hidden.sessions.count).toBe(24);
        expect(parsedSessionPayloads()).toHaveLength(0);
      } finally {
        parse.mockRestore();
        clone.mockRestore();
      }
    });
  });
});
