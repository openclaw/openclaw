import fs from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { upsertAcpSessionMeta } from "../acp/runtime/session-meta-write.js";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import { makeModel } from "../agents/embedded-agent-runner/model.test-harness.js";
import { buildStatusCommandOverviewRows } from "../commands/status-overview-rows.ts";
import { collectStatusLocalSnapshot } from "../commands/status.agent-local.js";
import { createStatusCommandOverviewRowsParams } from "../commands/status.test-support.ts";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { readSessionStoreSummaryReadOnly } from "../config/sessions/session-accessor.sqlite-summary.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { spyOnSessionStoreSummaries } from "../config/sessions/session-store-summary.test-support.js";
import type { SessionAcpMeta, SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import { getStatusSummary } from "../status/summary.js";
import { statusSummaryRuntime } from "../status/summary.runtime.js";
import {
  createDirectOutboundTestAdapter,
  createOutboundTestPlugin,
  createTestRegistry,
} from "../test-utils/channel-plugins.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { formatStatusSummary } from "../tui/tui-status-summary.js";

const readStatusSummary = (config: OpenClawConfig, includeSensitive = true) =>
  getStatusSummary({ config, includeSensitive, includeChannelSummary: false });

async function closeAgentStores(root?: string) {
  await closeOpenClawAgentDatabasesAsync(root);
  closeOpenClawAgentDatabasesForTest(root);
}

const previousRegistry = getActivePluginRegistry();
let state: OpenClawTestState;
const defaultStore = () =>
  resolveSessionStorePathCore(undefined, { agentId: "main", env: state.env });
const seedSession = (
  name: string,
  entry: Partial<SessionEntry>,
  agentId = "main",
  storePath = defaultStore(),
) =>
  replaceSessionEntry(
    { agentId, storePath, sessionKey: `agent:${agentId}:${name}` },
    { sessionId: `${agentId}-${name}`, updatedAt: 1, ...entry },
  );

function registerTelegramFixture() {
  const telegram = createOutboundTestPlugin({
    id: "telegram",
    outbound: createDirectOutboundTestAdapter({ channel: "telegram" }),
    messaging: {
      targetPrefixes: ["telegram"],
      inferTargetChatType: ({ to }) => (/^(?:telegram:)?\d+$/.test(to) ? "direct" : undefined),
    },
  });
  telegram.config.resolveAllowFrom = ({ cfg }) => cfg.channels?.telegram?.allowFrom ?? [];
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "telegram", plugin: telegram, source: "test" }]),
  );
}

beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "openclaw-status-read-only-" });
  setActivePluginRegistry(createTestRegistry());
});

afterEach(async () => {
  vi.restoreAllMocks();
  cliBackendsTesting.resetDepsForTest();
  await state.cleanup();
});

afterAll(() => (previousRegistry ? setActivePluginRegistry(previousRegistry) : undefined));

it("refreshes batched status metadata after ACP updates and removal", async () => {
  const cfg: OpenClawConfig = {
    agents: { ownership: "explicit", entries: { main: {}, research: {} } },
  };
  await state.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg);
  const meta: SessionAcpMeta = {
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: "first",
    mode: "persistent",
    state: "idle",
    lastActivityAt: 100,
  };
  const scopes = ["main", "research"].map((agentId) => ({
    cfg,
    agentId,
    sessionKey: `agent:${agentId}:acp:status`,
    skipMaintenance: true,
  }));
  const candidates = [];
  for (const scope of scopes) {
    const entry = expectDefined(
      await upsertAcpSessionMeta({ ...scope, mutate: () => meta }),
      "seeded ACP session",
    );
    candidates.push({ sessionKey: scope.sessionKey, entry });
  }
  const before = await statusSummaryRuntime.readSessionRuntimeMetadata(cfg, candidates);
  expect(before.map((entry) => entry?.runtimeSessionName)).toEqual(["first", "first"]);
  await upsertAcpSessionMeta({
    ...scopes[0]!,
    mutate: () => ({ ...meta, runtimeSessionName: "updated" }),
  });
  await upsertAcpSessionMeta({ ...scopes[1]!, mutate: () => null });
  const after = await statusSummaryRuntime.readSessionRuntimeMetadata(cfg, candidates);
  expect(after.map((entry) => entry?.runtimeSessionName ?? null)).toEqual(["updated", null]);
  expect(before.map((entry) => entry?.runtimeSessionName)).toEqual(["first", "first"]);
});

it.each<{ ownerConfigured: boolean; target: "owner" | undefined; waitingForRoute: boolean }>`
  ownerConfigured | target       | waitingForRoute
  ${false}        | ${undefined} | ${true}
  ${true}         | ${undefined} | ${false}
  ${true}         | ${"owner"}   | ${false}
`(
  "checks the owner route without writing sessions ($ownerConfigured, $target)",
  async ({ ownerConfigured, target, waitingForRoute }) => {
    if (ownerConfigured) {
      registerTelegramFixture();
    }
    const databasePath = state.path("openclaw-agent.sqlite");
    const summary = await readStatusSummary({
      ...(target ? { agents: { defaults: { heartbeat: { target } } } } : {}),
      ...(ownerConfigured
        ? {
            commands: { ownerAllowFrom: ["telegram:123"] },
            channels: { telegram: { allowFrom: ["123"] } },
          }
        : {}),
      session: { store: databasePath },
    });
    expect(summary.heartbeat.agents[0]?.waitingForRoute).toBe(waitingForRoute);
    expect(fs.existsSync(databasePath)).toBe(false);
  },
);

it.each(["sessions.json", "shared.sqlite"])(
  "reports each agent's activity and reads each physical session store once for %s",
  async (fileName) => {
    const storePath = state.path(fileName);
    const config = {
      agents: {
        ownership: "explicit" as const,
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: {}, ops: {} },
      },
      session: { store: storePath },
    };
    for (const agentId of ["main", "ops"]) {
      const logicalPath = resolveSessionStorePathCore(config.session.store, { agentId });
      await seedSession(
        "main",
        { sessionId: `${agentId}-session`, updatedAt: agentId === "main" ? 10 : 20 },
        agentId,
        logicalPath,
      );
    }
    await closeAgentStores(state.root);
    const expectedPaths = ["main", "ops"].map(
      (agentId) => resolveSqliteTargetFromSessionStorePath(storePath, { agentId }).path,
    );
    const uniquePaths = [...new Set(expectedPaths)];
    const { calls: readSummary } = spyOnSessionStoreSummaries();
    vi.spyOn(Date, "now").mockReturnValue(100);
    const summary = await readStatusSummary(config);
    expect(summary.sessions).toMatchObject({
      count: 2,
      paths: uniquePaths,
      byAgent: ["main", "ops"].map((agentId, i) => ({
        agentId,
        path: expectedPaths[i],
        count: 1,
        recent: [{ agentId, key: `agent:${agentId}:main` }],
      })),
    });
    expect(readSummary).toHaveBeenCalledTimes(uniquePaths.length);

    readSummary.mockClear();
    const { agentStatus: local } = await collectStatusLocalSnapshot(config);
    expect(local).toMatchObject({
      totalSessions: 2,
      agents: ["main", "ops"].map((id, i) => ({
        id,
        sessionsCount: 1,
        lastUpdatedAt: (i + 1) * 10,
        lastActiveAgeMs: 90 - i * 10,
      })),
    });
    expect(readSummary).toHaveBeenCalledTimes(uniquePaths.length);
    expect(uniquePaths.every((databasePath) => fs.existsSync(databasePath))).toBe(true);
  },
);

it("does not reread ambient config while projecting prepared session runtime state", async () => {
  await state.cleanup();
  state = await createOpenClawTestState({ layout: "split" });
  const storePath = state.path("sessions.json");
  const config = { session: { store: storePath } };
  await state.writeConfig({ session: {} });
  await seedSession("main", { sessionId: "prepared-config", updatedAt: 10 }, "main", storePath);
  await closeAgentStores(state.root);
  clearRuntimeConfigSnapshot();
  const readFileSync = vi.spyOn(fs, "readFileSync");
  await readStatusSummary(config);
  expect(readFileSync.mock.calls.filter(([file]) => file === state.configPath)).toHaveLength(0);
});

it("shares one local session snapshot across the complete status scan", async () => {
  const config = {
    agents: { defaults: { heartbeat: { every: "0m" } }, entries: { main: {} } },
    gateway: { mode: "remote" as const, remote: { url: "ws://127.0.0.1:1", token: "fixture" } },
    plugins: { enabled: false },
  };
  await state.writeConfig(config);
  for (let index = 1; index <= 12; index += 1) {
    await seedSession(`scan-${index}`, {
      updatedAt: index,
      skillsSnapshot: { prompt: "private fixture", skills: [] },
    });
  }
  const { calls: readSummary } = spyOnSessionStoreSummaries();
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
  for (const stage of ["config", "gateway-probe", "session-stores", "summary"]) {
    expect(timings).toContain(`"stage":"status.${stage}"`);
  }
});

it("keeps an authored context cap through a runtime provider alias", async () => {
  const cliBackend = {
    id: "claude-cli",
    modelProvider: "anthropic",
    config: { command: "claude" },
    bundleMcp: false,
  };
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: ({ backend }) =>
      backend === "claude-cli" ? { pluginId: "anthropic", backend: cliBackend } : undefined,
    resolvePluginSetupRegistry: () => {
      throw new Error("setup registry should not load for a targeted runtime alias");
    },
    resolveRuntimeCliBackends: () => [],
  });
  const model = { ...makeModel("claude-opus-5"), contextWindow: 1_000_000, contextTokens: 272_000 };
  const config = {
    agents: { defaults: { model: "anthropic/claude-opus-5" } },
    models: {
      providers: { anthropic: { baseUrl: "https://api.anthropic.com", models: [model] } },
    },
    session: { store: defaultStore() },
  };
  await seedSession("main", {
    modelProvider: "claude-cli",
    model: "claude-opus-5",
    agentHarnessId: "claude-cli",
    contextTokens: 272_000,
    contextTokensSource: "resolved",
    totalTokens: 121_000,
    totalTokensFresh: true,
    totalTokensVersion: 1,
  });
  await closeAgentStores(state.root);
  const summary = await readStatusSummary(config);
  expect(summary.sessions.recent[0]).toMatchObject({ contextTokens: 272_000, percentUsed: 44 });
});

it.each([false, true])(
  "labels archived and retired shared-store rows as stored (all archived: %s)",
  async (allArchived) => {
    const storePath = state.path("shared.sqlite");
    const config = {
      agents: { defaults: { heartbeat: { every: "0m" } }, entries: { main: {}, ops: {} } },
      session: { store: storePath },
    };
    for (const [agentId, name, archived] of [
      ["main", "current", allArchived],
      ["main", "history", true],
      ["ops", "history", true],
      ["retired", "history", true],
    ] as const) {
      await seedSession(name, archived ? { archivedAt: 2 } : {}, agentId, storePath);
    }
    await closeAgentStores(state.root);
    const stored = readSessionStoreSummaryReadOnly(
      { agentId: "main", storePath },
      { agentIds: ["main", "ops"], recentLimit: 10 },
    );
    expect(stored.count).toBe(4);
    expect(stored.recent.filter(({ entry }) => entry.archivedAt !== undefined)).toHaveLength(
      allArchived ? 4 : 3,
    );
    const summary = await readStatusSummary(config);
    expect(summary.sessions.count).toBe(4);
    expect(summary.sessions.paths).toEqual([storePath]);
    expect(summary.sessions.byAgent.map(({ agentId, count }) => [agentId, count])).toEqual([
      ["main", 2],
      ["ops", 1],
    ]);
    const rows = buildStatusCommandOverviewRows(createStatusCommandOverviewRowsParams({ summary }));
    expect(rows.find(({ Item }) => Item === "Sessions")?.Value).toMatch(/^4 stored · default /);
    const tuiLines = formatStatusSummary(summary);
    expect(tuiLines).toContain("Stored sessions: 4");
    expect(tuiLines).not.toContain("Active sessions: 4");
  },
);

it("keeps session payload hydration off the status caller", async () => {
  const config = {
    agents: { defaults: { heartbeat: { every: "0m" } }, entries: { main: {} } },
  };
  for (let index = 1; index <= 24; index += 1) {
    await seedSession(`history-${index}`, {
      sessionId: `status-history-${index}`,
      updatedAt: index,
      pluginExtensions: {
        fixture: { history: Array.from({ length: 64 }, () => "x".repeat(128)) },
      },
    });
  }
  await readStatusSummary(config);
  const clone = vi.spyOn(globalThis, "structuredClone");
  const parse = vi.spyOn(JSON, "parse");
  const parsedSessionPayloads = () =>
    parse.mock.calls.filter(([json]) => json.includes('"sessionId":"status-history-'));
  const summary = await readStatusSummary(config);
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
  const hidden = await readStatusSummary(config, false);
  expect(hidden.sessions.count).toBe(24);
  expect(parsedSessionPayloads()).toHaveLength(0);
});
