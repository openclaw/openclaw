import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { captureRuntimeConfigAsyncReader, getRuntimeConfig } from "../../config/config.js";
import { encodeSessionArchiveContent } from "../../config/sessions/archive-compression.js";
import {
  listSessionTranscriptInstances,
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { applySessionEntryOperation } from "../../config/sessions/session-accessor.sqlite-entry.js";
import {
  historyLane,
  projectionLane,
  targetDiscoveryLane,
} from "../../config/sessions/session-transcript-worker-resources.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { createPersistCronSessionEntry } from "../../cron/isolated-agent/run-session-state.js";
import { prepareCronSession } from "../../cron/isolated-agent/session.js";
import { refreshCostUsageCacheForAgent } from "../../infra/session-cost-usage-aggregation.js";
import { discoverAllSessions, loadSessionCostSummary } from "../../infra/session-cost-usage.js";
import { buildUsageOverview } from "../../shared/usage-overview.js";
import type { SessionsUsageResult } from "../../shared/usage-types.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { SYSTEM_AGENT_ID } from "../../system-agent/agent-id.js";
import {
  type OpenClawTestState,
  withOpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createResidentSessionRowReader } from "../session-row-projection.test-support.js";
import { loadUsageSessionSummaries } from "./usage-session-loading.js";
import * as usageSessionSelection from "./usage-session-selection.js";
import {
  contextReport,
  invokeUsage,
  usageMessage,
  usageReply,
  writeUsage,
} from "./usage.test-support.js";

let sessionRows: ReturnType<typeof createResidentSessionRowReader>;

beforeEach(() => {
  const reader = createResidentSessionRowReader();
  sessionRows = reader;
  onTestFinished(() => reader.dispose());
});

function sessionScope(state: OpenClawTestState, agentId: string, sessionKey: string) {
  return { agentId, sessionKey, storePath: path.join(state.sessionsDir(agentId), "sessions.json") };
}

async function warmUsage(agentIds: string[]) {
  for (const agentId of agentIds) {
    for (const { sessionId, sessionFile } of await discoverAllSessions({ agentId })) {
      await loadSessionCostSummary({ agentId, sessionId, sessionFile, config: getRuntimeConfig() });
    }
  }
}

function warmTarget(scope: ReturnType<typeof sessionScope>, sessionId: string) {
  return loadSessionCostSummary({
    config: getRuntimeConfig(),
    agentId: scope.agentId,
    sessionId,
    sessionTarget: { ...scope, sessionId },
  });
}

async function seedUsage(
  state: OpenClawTestState,
  scope: ReturnType<typeof sessionScope>,
  sessionId: string,
  tokens: number,
  timestamp: number,
  entry: Partial<SessionEntry> = {},
) {
  await upsertSessionEntryCore(scope, { sessionId, updatedAt: timestamp, ...entry });
  await writeUsage({ ...scope, sessionId }, state.workspaceDir, tokens, timestamp);
}

async function withoutSql<T>(read: () => Promise<T>): Promise<T> {
  const sql = observeHostDataSql();
  try {
    const result = await read();
    expect(sql.queries).toEqual([]);
    return result;
  } finally {
    sql.restore();
  }
}

async function requestUsage(params: Record<string, unknown>, method = "sessions.usage") {
  const projection = await sessionRows.ready();
  return usageReply(
    await invokeUsage(method, params, getRuntimeConfig(), {
      context: bindSessionRowProjection(
        createDirectChatContext({ getRuntimeConfig }),
        () => projection,
      ),
    }),
  );
}

async function readUsage(params: Record<string, unknown>) {
  const [ok, payload, error] = await requestUsage(params);
  expect(ok, JSON.stringify({ params, error })).toBe(true);
  return payload as SessionsUsageResult;
}

async function withUsageState(run: (state: OpenClawTestState) => Promise<void>) {
  await withOpenClawTestState({ label: "usage-owner" }, async (state) => {
    await state.writeConfig({
      agents: { ownership: "explicit", entries: { main: {}, opus: {} } },
      plugins: { enabled: false },
    });
    await captureRuntimeConfigAsyncReader()();
    try {
      await run(state);
    } finally {
      await sessionRows.dispose();
    }
  });
}

it("preserves global session addition order across agents before overview pagination", async () => {
  await withUsageState(async (state) => {
    const config = getRuntimeConfig();
    const startMs = Date.UTC(2026, 8, 18);
    const sessions = [];
    for (const [index, cost] of [0.2, 0.1, 0.3].entries()) {
      const agentId = index === 1 ? "opus" : "main";
      const sessionId = `ordered-${index}`;
      const sessionFile = state.path(`${sessionId}.jsonl`);
      await fs.writeFile(
        sessionFile,
        `${JSON.stringify({
          type: "message",
          id: sessionId,
          parentId: null,
          message: usageMessage(1, startMs, cost),
        })}\n`,
      );
      sessions.push({
        key: sessionId,
        agentId,
        sessionId,
        sessionFile,
        channel: "same-channel",
        creatorKey: "same-creator",
        updatedAt: 30 - index * 10,
        instances: [{ sessionId, sessionFile }],
      });
    }
    for (const agentId of ["main", "opus"]) {
      await refreshCostUsageCacheForAgent({
        config,
        agentId,
        sessionFiles: sessions
          .filter((session) => session.agentId === agentId)
          .flatMap((session) => session.instances.map((instance) => instance.sessionFile)),
      });
    }
    const loaded = await loadUsageSessionSummaries({
      read: (load) => load(),
      entries: sessions,
      config,
      startMs,
      endMs: startMs + 86_400_000 - 1,
      dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
    });
    const result = {
      ...buildUsageOverview({
        rows: sessions.map((session, index) =>
          Object.assign({}, session, { usage: loaded.summaries[index] ?? null }),
        ),
        options: { offset: 1 },
        dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
      }),
      cacheStatus: loaded.cacheStatus,
    };
    expect(result.cacheStatus?.status).toBe("fresh");
    const expectedCost = 0.6000000000000001;
    expect(result.totals.totalCost).toBe(expectedCost);
    expect(result.aggregates.byModel[0]?.totals.totalCost).toBe(expectedCost);
    expect(result.aggregates.byChannel[0]?.totals.totalCost).toBe(expectedCost);
    expect(result.aggregates.byCreator?.[0]?.totals.totalCost).toBe(expectedCost);
    expect(result.aggregates.costDaily?.[0]?.totalCost).toBe(expectedCost);
    expect(result.aggregates.daily[0]?.cost).toBe(expectedCost);
    expect(result.overview.tableTotals.cost).toBe(expectedCost);
    expect(result.sessions.map((session) => session.key)).toEqual(["ordered-1", "ordered-2"]);
    expect(result.overview).toMatchObject({ total: 3, offset: 1, limit: 50 });
  });
});

it("keeps same-key overview context reports with their selected agent", async () => {
  await withUsageState(async (state) => {
    const config = getRuntimeConfig();
    const timestamp = Date.now() - 60_000;
    const candidates: usageSessionSelection.UsageSessionSelection[] = [];
    const reports = [contextReport(timestamp, 1), contextReport(timestamp, 2)];
    for (const [index, agentId] of ["main", "opus"].entries()) {
      const sessionId = `${agentId}-global-context`;
      const scope = sessionScope(state, agentId, "global");
      await seedUsage(state, scope, sessionId, index + 1, timestamp, {
        systemPromptReport: reports[index],
      });
      await warmTarget(scope, sessionId);
      candidates.push(
        ...(await usageSessionSelection.selectUsageSessions({
          config,
          projection: await sessionRows.ready(),
          agentId,
          specificKey: null,
          groupingMode: "instance",
          startMs: 0,
          endMs: Date.now(),
        })),
      );
    }
    expect(candidates.map(({ agentId, key }) => [agentId, key])).toEqual([
      ["main", "global"],
      ["opus", "global"],
    ]);
    // Federation picks one public sentinel today; assembly must retain each physical owner supplied by selection.
    using _ = vi
      .spyOn(usageSessionSelection, "selectUsageSessions")
      .mockResolvedValueOnce(candidates);
    const result = await readUsage({
      agentScope: "all",
      range: "all",
      projection: "overview",
      includeContextWeight: true,
    });
    expect(result.sessions).toHaveLength(2);
    for (const [index, agentId] of ["main", "opus"].entries()) {
      expect(result.sessions.find((row) => row.agentId === agentId)).toMatchObject({
        key: "global",
        agentId,
        sessionId: `${agentId}-global-context`,
        hasContextWeight: true,
        contextWeight: reports[index],
      });
    }
  });
});

it("keeps prior cron runs attributed through guarded replacement and the real usage handler", async () => {
  await withUsageState(async (state) => {
    const config = getRuntimeConfig();
    const sessionKey = "agent:main:cron:usage-history";
    const scope = { agentId: "main", sessionKey };
    const sessionIds: string[] = [];
    const timestamp = Date.now() - 60_000;
    for (const tokens of [10, 20, 30]) {
      const cronSession = await prepareCronSession({
        cfg: config,
        ...scope,
        nowMs: timestamp,
        forceNew: true,
      });
      await createPersistCronSessionEntry({
        cronSession,
        agentSessionKey: sessionKey,
        workspaceDir: state.workspaceDir,
        persistSessionEntry: async ({ storePath, operation }) => {
          return await applySessionEntryOperation({ ...scope, storePath }, operation, {
            fallbackEntry: operation.next,
            replaceEntry: true,
          });
        },
      })();
      const sessionId = cronSession.sessionEntry.sessionId;
      sessionIds.push(sessionId);
      await writeUsage({ ...scope, sessionId }, state.workspaceDir, tokens, timestamp);
    }
    expect(loadSessionEntryReadOnly(scope)).toMatchObject({
      usageFamilyKey: sessionKey,
      usageFamilySessionIds: sessionIds,
      createdActor: { type: "system" },
    });
    await warmUsage(["main"]);
    for (const groupBy of ["instance", "family"]) {
      const result = await withoutSql(() => readUsage({ range: "all", agentId: "main", groupBy }));
      expect(result.totals.totalTokens).toBe(60);
      expect(result.totals.totalCost).toBeCloseTo(0.03);
      expect(result.sessions).toHaveLength(groupBy === "instance" ? 3 : 1);
      expect(result.sessions.every((row) => row.createdActor?.type === "system")).toBe(true);
      expect(result.aggregates.byCreator).toMatchObject([
        { actor: { type: "system" }, totals: { totalTokens: 60, totalCost: 0.03 } },
      ]);
    }
    for (const method of ["sessions.usage.timeseries", "sessions.usage.logs"]) {
      const [ok, payload] = await withoutSql(() => requestUsage({ key: sessionKey }, method));
      expect(ok).toBe(true);
      expect(payload).toMatchObject(
        method === "sessions.usage.timeseries"
          ? { points: [expect.objectContaining({ totalTokens: 30 })] }
          : { logs: [expect.objectContaining({ role: "assistant", tokens: 30 })] },
      );
    }
  });
});

it("uses committed metadata for selected usage and families with an empty current window", async () => {
  await withUsageState(async (state) => {
    const key = "agent:main:usage-receipts";
    const scope = sessionScope(state, "main", key);
    const timestamp = Date.now() - 60_000;
    const firstId = "usage-receipts-first";
    await seedUsage(state, scope, firstId, 17, timestamp, { label: "Before rename" });
    await warmTarget(scope, firstId);
    const params = { range: "all", key };
    expect((await readUsage(params)).sessions).toMatchObject([
      { key, sessionId: firstId, label: "Before rename", usage: { totalTokens: 17 } },
    ]);

    await patchSessionEntryCore(scope, () => ({ label: "After rename" }));
    expect((await readUsage(params)).sessions).toMatchObject([
      { key, sessionId: firstId, label: "After rename", usage: { totalTokens: 17 } },
    ]);

    const currentId = "usage-receipts-current";
    await upsertSessionEntryCore(scope, {
      sessionId: currentId,
      updatedAt: timestamp + 1,
      label: "Replacement",
    });
    await warmTarget(scope, currentId);
    for (const selector of [{ key }, { agentId: "main" }]) {
      const result = await readUsage({ range: "all", groupBy: "family", ...selector });
      expect(result.sessions).toMatchObject([
        {
          key,
          sessionId: currentId,
          currentSessionId: currentId,
          label: "Replacement",
          includedSessionIds: [currentId, firstId],
          usage: { totalTokens: 17 },
        },
      ]);
      expect(result.totals.totalTokens).toBe(17);
    }
  });
});

it("hydrates context metadata only for emitted usage rows while aggregating every match", async () => {
  await withUsageState(async (state) => {
    const ada = ensureProfileForEmail("ada@example.test");
    const bob = ensureProfileForEmail("bob@example.test");
    const timestamp = Date.now() - 60_000;
    const fixtures = ["main", "opus"].flatMap((agentId, agentIndex) =>
      Array.from({ length: agentId === "main" ? 8 : 51 }, (_, index) => {
        const ordinal = agentIndex * 8 + index;
        return {
          agentId,
          sessionId: `usage-page-${index}`,
          key: `agent:${agentId}:dashboard:usage-page-${index}`,
          label: ordinal === 0 ? undefined : `${agentId} usage ${index}`,
          updatedAt: timestamp + ordinal,
          tokens: agentIndex * 100 + index + 1,
          promptMarker: `usage-page-prompt-${agentId}-${index}:`,
          report: ordinal === 0 ? undefined : contextReport(timestamp + ordinal, ordinal),
        };
      }),
    );
    for (const fixture of fixtures) {
      const scope = {
        ...sessionScope(state, fixture.agentId, fixture.key),
        sessionId: fixture.sessionId,
      };
      await seedUsage(state, scope, fixture.sessionId, fixture.tokens, fixture.updatedAt, {
        label: fixture.label,
        createdActor: {
          type: "human",
          source: "profile",
          id: fixture.agentId === "main" ? ada.id : bob.id,
        },
        skillsSnapshot: { prompt: fixture.promptMarker + "x".repeat(65_536), skills: [] },
        systemPromptReport: fixture.report,
      });
      fixture.updatedAt = expectDefined(
        loadSessionEntryReadOnly({ ...scope, projection: "list" }),
        "persisted usage fixture",
      ).updatedAt;
    }
    // Refresh outside the observation window so transcript work cannot hide metadata overreads.
    await warmUsage(["main", "opus"]);
    const adaFixtures = fixtures.filter((fixture) => fixture.agentId === "main");
    const row = (index: number) => expectDefined(fixtures.at(index), `usage row ${index}`);
    const newest = row(-1);
    const adaNewest = expectDefined(adaFixtures.at(-1), "newest Ada usage row");
    const adaCreatorKey = JSON.stringify(["profile", ada.id]);
    const scenarios: Array<
      [typeof fixtures, boolean, { key?: string; creatorKey?: string; projection?: "overview" }?]
    > = [
      [[newest], false],
      [[newest], true],
      [[row(3)], true, { key: row(3).key }],
      [[row(0)], true, { key: row(0).key }],
      [[newest, row(-2)], false],
      [[adaNewest], false, { creatorKey: adaCreatorKey }],
      [[adaNewest], true, { creatorKey: adaCreatorKey }],
      [adaFixtures.toReversed(), true, { creatorKey: adaCreatorKey, projection: "overview" }],
    ];
    for (const [selected, includeContextWeight, filters = {}] of scenarios) {
      let payload: unknown;
      const transferredPrompts = new Set<string>();
      const transfers = [historyLane, projectionLane, targetDiscoveryLane].map(({ pool }) => {
        const run = pool.run.bind(pool);
        return vi.spyOn(pool, "run").mockImplementation(async (...args) => {
          const reply = await run(...args);
          const bytes = JSON.stringify(reply);
          for (const fixture of fixtures) {
            if (bytes.includes(fixture.promptMarker)) {
              transferredPrompts.add(fixture.promptMarker);
            }
          }
          return reply;
        });
      });
      try {
        payload = await readUsage({
          ...(filters.key ? {} : { agentScope: "all" }),
          range: "all",
          limit: selected.length,
          includeContextWeight,
          ...filters,
        });
      } finally {
        for (const transfer of transfers) {
          transfer.mockRestore();
        }
      }
      const matches = filters.key ? selected : filters.creatorKey ? adaFixtures : fixtures;
      expect(payload).toMatchObject({
        sessions: selected.map((fixture) => ({
          key: fixture.key,
          agentId: fixture.agentId,
          sessionId: fixture.sessionId,
          label: fixture.label,
          updatedAt: fixture.updatedAt,
          usage: { totalTokens: fixture.tokens, totalCost: 0.01 },
          hasContextWeight: Boolean(fixture.report),
          ...(includeContextWeight ? { contextWeight: fixture.report ?? null } : {}),
        })),
        totals: { totalTokens: matches.reduce((total, fixture) => total + fixture.tokens, 0) },
        aggregates: { sessionCount: matches.length },
      });
      if (!includeContextWeight) {
        expect(JSON.stringify(payload)).not.toContain('"contextWeight":');
      }
      const emittedPrompts = new Set(selected.map((fixture) => fixture.promptMarker));
      expect
        .soft(
          [...transferredPrompts].filter((marker) => !emittedPrompts.has(marker)),
          "large saved prompts outside the emitted usage page must not cross the worker boundary",
        )
        .toEqual([]);
    }
  });
});

it("reads selected reports from the physical owner of shared-store sentinels and qualified rows", async () => {
  await withOpenClawTestState({ label: "usage-shared-context" }, async (state) => {
    const storePath = state.statePath("shared.sqlite");
    await state.writeConfig({
      agents: {
        ownership: "explicit",
        entries: { main: {}, ops: {}, worker: {} },
        defaults: { sessionStore: { agentId: "ops" } },
      },
      session: { store: storePath },
      plugins: { enabled: false },
    });
    await captureRuntimeConfigAsyncReader()();
    openOpenClawAgentDatabase({ agentId: "main", path: storePath });
    for (const [agentId, key] of [
      ["ops", "global"],
      ["worker", "agent:worker:usage"],
    ] as const) {
      const contextWeight = contextReport(agentId === "ops" ? 10 : 20);
      replaceSessionEntrySync(
        { agentId, sessionKey: key, storePath },
        { sessionId: `${agentId}-usage`, updatedAt: 1, systemPromptReport: contextWeight },
      );
      const params = { range: "all", key, includeContextWeight: true };
      for (const requestedAgent of [undefined, agentId]) {
        const payload = await readUsage({ ...params, agentId: requestedAgent });
        expect(payload).toMatchObject({
          sessions: [{ key, agentId, hasContextWeight: true, contextWeight }],
        });
      }
    }
    await sessionRows.dispose();
  });
});

it.each([
  { owner: "opus", key: undefined },
  { owner: "opus", key: "global" },
  { owner: SYSTEM_AGENT_ID, key: `agent:${SYSTEM_AGENT_ID}:usage` },
])(
  "keeps independent same-id transcripts with $owner store key $key through the real usage handler",
  async ({ owner, key: opusKey }) => {
    await withUsageState(async (state) => {
      const sessionId = "shared-usage-session";
      const mainKey = "agent:main:telegram:dm";
      for (const agentId of ["main", owner]) {
        const key = agentId === "main" ? mainKey : opusKey;
        const scope = {
          agentId,
          sessionId,
          sessionKey: key ?? `agent:${agentId}:${sessionId}`,
          storePath: path.join(state.sessionsDir(agentId), "sessions.json"),
        };
        if (key) {
          await upsertSessionEntryCore(scope, {
            sessionId,
            updatedAt: Date.now(),
            displayName: `${agentId} generated chat`,
            ...(agentId === "main" ? {} : { label: `${agentId} chat` }),
          });
        }
        await persistSessionTranscriptTurn(scope, {
          cwd: state.workspaceDir,
          updateMode: "none",
          messages: [
            {
              message: { role: "user", content: `${agentId} turn`, timestamp: Date.now() },
              now: Date.now(),
            },
          ],
        });
      }

      const result = await readUsage({ agentScope: "all", range: "all", limit: 50 });
      expect(result.sessions).toHaveLength(2);
      expect(result.sessions.map(({ key, agentId, label }) => ({ key, agentId, label }))).toEqual(
        expect.arrayContaining([
          { key: mainKey, agentId: "main", label: "main generated chat" },
          {
            key: opusKey ?? `agent:${owner}:${sessionId}`,
            agentId: owner,
            label: opusKey ? `${owner} chat` : undefined,
          },
        ]),
      );
      if (opusKey) {
        const selected = expectDefined(
          result.sessions.find((session) => session.agentId === owner),
          "selected usage owner",
        );
        for (const method of ["sessions.usage.timeseries", "sessions.usage.logs"] as const) {
          for (const explicitOwner of owner === SYSTEM_AGENT_ID ? [false, true] : [true]) {
            const [detailOk, detailPayload, detailError] = await requestUsage(
              { key: selected.key, ...(explicitOwner ? { agentId: selected.agentId } : {}) },
              method,
            );
            if (owner === SYSTEM_AGENT_ID && explicitOwner) {
              expect(detailOk).toBe(false);
              expect(detailError).toMatchObject({ message: `Unknown agent id "${owner}"` });
            } else {
              expect.soft(detailOk, method).toBe(true);
              if (detailOk) {
                expect(detailPayload, method).toMatchObject(
                  method === "sessions.usage.logs"
                    ? { logs: [expect.objectContaining({ content: `${owner} turn` })] }
                    : { sessionId },
                );
              }
            }
          }
        }
      }
    });
  },
);

it.each(["direct owner", "compressed history", "current JSONL"])(
  "keeps family usage with %s before the current SQLite transcript exists",
  async (mode) => {
    const directOwner = mode === "direct owner";
    const artifact = mode === "compressed history";
    const currentArtifact = mode === "current JSONL";
    await withUsageState(async (state) => {
      const config = getRuntimeConfig();
      const mainKey = "agent:main:chat";
      const opusKey = "agent:opus:chat";
      const directKey = "agent:main:chat:run:retained";
      const archiveManager = SessionManager.inMemory(state.workspaceDir);
      const firstId = artifact ? archiveManager.getSessionId() : "family-first";
      const secondId = "family-second";
      const currentId = currentArtifact ? archiveManager.getSessionId() : "family-current";
      const timestamp = Date.now();
      const mainScope = sessionScope(state, "main", mainKey);
      const opusScope = sessionScope(state, "opus", opusKey);
      const writeArtifact = async (tokens: number) => {
        archiveManager.appendMessage(usageMessage(tokens, timestamp));
        const content = [archiveManager.getHeader(), ...archiveManager.getEntries()]
          .map((entry) => JSON.stringify(entry))
          .join("\n");
        const encoded = artifact
          ? encodeSessionArchiveContent(content)
          : { bytes: Buffer.from(content), suffix: "" };
        expect(encoded.suffix).toBe(artifact ? ".zst" : "");
        const filePath = path.join(
          state.sessionsDir(),
          `${archiveManager.getSessionId()}.jsonl.reset.2026-08-01T00-00-00.000Z${encoded.suffix}`,
        );
        await fs.mkdir(state.sessionsDir(), { recursive: true });
        await fs.writeFile(filePath, encoded.bytes);
        return filePath;
      };
      for (const [scope, sessionId, tokens] of [
        [mainScope, firstId, 10],
        [mainScope, secondId, 20],
        [opusScope, firstId, 100],
      ] as const) {
        await upsertSessionEntryCore(scope, {
          sessionId,
          displayName: `${scope.agentId} chat`,
          updatedAt: timestamp,
        });
        if (artifact && scope.agentId === "main" && sessionId === firstId) {
          await writeArtifact(tokens);
          continue;
        }
        await writeUsage({ ...scope, sessionId }, state.workspaceDir, tokens, timestamp);
      }
      const current = await upsertSessionEntryCore(mainScope, {
        sessionId: currentId,
        updatedAt: timestamp + 1,
      });
      if (currentArtifact) {
        const artifactPath = await writeArtifact(40);
        const older = new Date(timestamp - 60_000);
        await fs.utimes(artifactPath, older, older);
      }
      if (directOwner) {
        // Exact-run continuation nodes retain an instance while their logical root rotates.
        await upsertSessionEntryCore(sessionScope(state, "main", directKey), {
          sessionId: firstId,
          label: "retained run",
          updatedAt: timestamp,
        });
      }
      expect(current?.usageFamilySessionIds).toEqual([firstId, secondId, currentId]);
      expect(
        listSessionTranscriptInstances(mainScope)
          .map(({ sessionId }) => sessionId)
          .toSorted(),
      ).toEqual((artifact ? [secondId] : [firstId, secondId]).toSorted());

      // Warm the real rollups so the handler assertion tests selection, not refresh timing.
      for (const agentId of ["main", "opus"]) {
        const discovered = await discoverAllSessions({ agentId });
        if (currentArtifact && agentId === "main") {
          expect(discovered[0]?.sessionId).not.toBe(currentId);
        }
        for (const { sessionId, sessionFile } of discovered) {
          await loadSessionCostSummary({ agentId, sessionId, sessionFile, config });
        }
      }
      await warmTarget(mainScope, currentId);

      for (const specificKey of [undefined, mainKey]) {
        const result = await readUsage({
          ...(specificKey ? { key: specificKey } : { agentScope: "all" }),
          range: "all",
          groupBy: "family",
          limit: 50,
        });
        // Explicit keys use the canonical stored target; only list discovery reads current JSONL.
        const mainTokens = currentArtifact && !specificKey ? 70 : directOwner ? 20 : 30;
        expect(result.sessions).toHaveLength(specificKey ? 1 : directOwner ? 3 : 2);
        expect(result.sessions.find(({ key }) => key === mainKey)).toMatchObject({
          key: mainKey,
          agentId: "main",
          label: "main chat",
          sessionId: currentId,
          scope: "family",
          includedSessionIds: directOwner ? [currentId, secondId] : [currentId, firstId, secondId],
          usage: { totalTokens: mainTokens },
        });
        if (!specificKey) {
          expect(result.sessions.find(({ key }) => key === opusKey)).toMatchObject({
            key: opusKey,
            agentId: "opus",
            sessionId: firstId,
            usage: { totalTokens: 100 },
          });
          if (directOwner) {
            expect(result.sessions.find(({ key }) => key === directKey)).toMatchObject({
              agentId: "main",
              sessionId: firstId,
              usage: { totalTokens: 10 },
            });
          }
        }
        expect(result.totals.totalTokens).toBe(
          specificKey ? mainTokens : currentArtifact ? 170 : 130,
        );
      }
    });
  },
);
