import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { getRuntimeConfig } from "../../config/config.js";
import { encodeSessionArchiveContent } from "../../config/sessions/archive-compression.js";
import { loadCombinedSessionStoreForGatewayCore } from "../../config/sessions/combined-store-gateway.js";
import {
  listSessionTranscriptInstances,
  loadSessionEntryReadOnly,
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { SessionSystemPromptReport } from "../../config/sessions/types.js";
import { discoverAllSessions, loadSessionCostSummary } from "../../infra/session-cost-usage.js";
import type { AssistantMessage } from "../../llm/types.js";
import type { SessionsUsageResult } from "../../shared/usage-types.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { SYSTEM_AGENT_ID } from "../../system-agent/agent-id.js";
import {
  type OpenClawTestState,
  withOpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import type { RespondFn } from "./types.js";
import { usageHandlers } from "./usage.js";

function usageMessage(tokens: number, timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Recorded usage" }],
    api: "openai-responses",
    provider: "fixture",
    model: "usage-model",
    stopReason: "stop",
    timestamp,
    usage: {
      input: tokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: tokens,
      cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
    },
  };
}

async function requestUsage(params: Record<string, unknown>, method = "sessions.usage") {
  const respond = vi.fn<RespondFn>();
  const handler = expectDefined(usageHandlers[method], "usage handler");
  await handler({
    req: { type: "req", id: "usage", method },
    params,
    respond,
    client: null,
    isWebchatConnect: () => false,
    context: createDirectChatContext({ getRuntimeConfig }),
  });
  expect(respond).toHaveBeenCalledOnce();
  return expectDefined(respond.mock.calls[0], "usage response");
}

async function readUsage(params: Record<string, unknown>) {
  const [ok, payload] = await requestUsage(params);
  expect(ok).toBe(true);
  return payload as SessionsUsageResult;
}

async function withUsageState(run: (state: OpenClawTestState) => Promise<void>) {
  await withOpenClawTestState({ label: "usage-owner" }, async (state) => {
    await state.writeConfig({
      agents: { ownership: "explicit", entries: { main: {}, opus: {} } },
      plugins: { enabled: false },
    });
    await run(state);
  });
}

function contextReport(generatedAt: number, ordinal = 0): SessionSystemPromptReport {
  return {
    source: "run",
    generatedAt,
    systemPrompt: {
      chars: 100 + ordinal,
      projectContextChars: ordinal,
      nonProjectContextChars: 100,
    },
    injectedWorkspaceFiles: [],
    skills: { promptChars: 65_536, entries: [] },
    tools: { listChars: ordinal, schemaChars: 0, entries: [] },
  };
}

it("hydrates context metadata only for emitted usage rows while aggregating every match", async () => {
  await withUsageState(async (state) => {
    const config = getRuntimeConfig();
    const ada = ensureProfileForEmail("ada@example.test");
    const bob = ensureProfileForEmail("bob@example.test");
    const timestamp = Date.now() - 60_000;
    const fixtures = ["main", "opus"].flatMap((agentId, agentIndex) =>
      Array.from({ length: 8 }, (_, index) => {
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
        agentId: fixture.agentId,
        sessionId: fixture.sessionId,
        sessionKey: fixture.key,
        storePath: path.join(state.sessionsDir(fixture.agentId), "sessions.json"),
      };
      await upsertSessionEntryCore(scope, {
        sessionId: fixture.sessionId,
        label: fixture.label,
        createdActor: {
          type: "human",
          source: "profile",
          id: fixture.agentId === "main" ? ada.id : bob.id,
        },
        updatedAt: fixture.updatedAt,
        skillsSnapshot: { prompt: fixture.promptMarker + "x".repeat(65_536), skills: [] },
        systemPromptReport: fixture.report,
      });
      await persistSessionTranscriptTurn(scope, {
        cwd: state.workspaceDir,
        updateMode: "none",
        messages: [
          { message: usageMessage(fixture.tokens, fixture.updatedAt), now: fixture.updatedAt },
        ],
      });
      fixture.updatedAt = expectDefined(
        loadSessionEntryReadOnly({ ...scope, projection: "list" }),
        "persisted usage fixture",
      ).updatedAt;
    }
    // Refresh outside the observation window so transcript work cannot hide metadata overreads.
    for (const agentId of ["main", "opus"]) {
      for (const { sessionId, sessionFile } of await discoverAllSessions({ agentId })) {
        await loadSessionCostSummary({ agentId, sessionId, sessionFile, config });
      }
    }
    const newest = expectDefined(fixtures.at(-1), "newest usage row");
    const secondNewest = expectDefined(fixtures.at(-2), "second newest usage row");
    const older = expectDefined(fixtures[3], "older main usage row");
    const withoutReport = expectDefined(fixtures[0], "usage row without context report");
    const adaFixtures = fixtures.filter((fixture) => fixture.agentId === "main");
    const adaNewest = expectDefined(adaFixtures.at(-1), "newest Ada usage row");
    const adaCreatorKey = JSON.stringify(["profile", ada.id]);
    for (const scenario of [
      { selected: [newest], includeContextWeight: false },
      { selected: [newest], includeContextWeight: true },
      { selected: [older], includeContextWeight: true, key: older.key },
      { selected: [withoutReport], includeContextWeight: true, key: withoutReport.key },
      { selected: [newest, secondNewest], includeContextWeight: false },
      { selected: [adaNewest], includeContextWeight: false, creatorKey: adaCreatorKey },
      { selected: [adaNewest], includeContextWeight: true, creatorKey: adaCreatorKey },
    ]) {
      let payload: unknown;
      const reads = ["main", "opus"].map((agentId) =>
        trackSqliteStatementExecutions(
          openOpenClawAgentDatabase({ agentId }).db,
          ["entries"],
          (sql) => (/from\s+"session_nodes"/i.test(sql) ? "entries" : null),
        ),
      );
      const parse = vi.spyOn(JSON, "parse");
      let parsedPrompts: string[];
      try {
        payload = await readUsage({
          ...(scenario.key ? { key: scenario.key } : { agentScope: "all" }),
          range: "all",
          limit: scenario.selected.length,
          includeContextWeight: scenario.includeContextWeight,
          creatorKey: scenario.creatorKey,
        });
        parsedPrompts = fixtures
          .filter((fixture) =>
            parse.mock.calls.some(([json]) => json.includes(fixture.promptMarker)),
          )
          .map((fixture) => fixture.promptMarker);
        expect(reads.reduce((bytes, read) => bytes + read.textBytes.entries, 0)).toBeLessThan(
          65_536 * scenario.selected.length * 4,
        );
      } finally {
        parse.mockRestore();
        for (const read of reads) {
          read.restore();
        }
      }
      const matches = scenario.key
        ? scenario.selected
        : scenario.creatorKey
          ? adaFixtures
          : fixtures;
      expect(payload).toMatchObject({
        sessions: scenario.selected.map((fixture) => ({
          key: fixture.key,
          agentId: fixture.agentId,
          sessionId: fixture.sessionId,
          label: fixture.label,
          updatedAt: fixture.updatedAt,
          usage: { totalTokens: fixture.tokens, totalCost: 0.01 },
          hasContextWeight: Boolean(fixture.report),
          ...(scenario.includeContextWeight ? { contextWeight: fixture.report ?? null } : {}),
        })),
        totals: { totalTokens: matches.reduce((total, fixture) => total + fixture.tokens, 0) },
        aggregates: { sessionCount: matches.length },
      });
      if (!scenario.includeContextWeight) {
        expect(JSON.stringify(payload)).not.toContain('"contextWeight":');
      }
      const emittedPrompts = new Set(scenario.selected.map((fixture) => fixture.promptMarker));
      expect
        .soft(
          parsedPrompts.filter((marker) => !emittedPrompts.has(marker)),
          "large saved prompts outside the emitted usage page must remain unparsed",
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
    const config = getRuntimeConfig();
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
      const target = loadCombinedSessionStoreForGatewayCore(config, {
        agentId,
      }).targetsBySessionKey.get(key);
      expect(target?.agentId).toBe(agentId);
      expect(target?.storeTarget).toEqual({ agentId: "main", storePath });
      const params = { range: "all", key, includeContextWeight: true };
      for (const requestedAgent of [undefined, agentId]) {
        const payload = await readUsage({ ...params, agentId: requestedAgent });
        expect(payload).toMatchObject({
          sessions: [{ key, agentId, hasContextWeight: true, contextWeight }],
        });
      }
    }
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
      const config = getRuntimeConfig();
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

      const projected = loadCombinedSessionStoreForGatewayCore(config);
      expect(projected.targetsBySessionKey.get(mainKey)?.agentId).toBe("main");
      if (opusKey) {
        expect(projected.targetsBySessionKey.get(opusKey)?.agentId).toBe(owner);
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
      const scopeFor = (agentId: string, sessionKey: string) => ({
        agentId,
        sessionKey,
        storePath: path.join(state.sessionsDir(agentId), "sessions.json"),
      });
      const mainScope = scopeFor("main", mainKey);
      const opusScope = scopeFor("opus", opusKey);
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
        await persistSessionTranscriptTurn(
          { ...scope, sessionId },
          {
            cwd: state.workspaceDir,
            updateMode: "none",
            messages: [{ message: usageMessage(tokens, timestamp), now: timestamp }],
          },
        );
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
        await upsertSessionEntryCore(scopeFor("main", directKey), {
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
      await loadSessionCostSummary({
        agentId: mainScope.agentId,
        sessionId: currentId,
        sessionTarget: { ...mainScope, sessionId: currentId },
        config,
      });

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
          usage: expect.objectContaining({ totalTokens: mainTokens }),
        });
        if (!specificKey) {
          expect(result.sessions.find(({ key }) => key === opusKey)).toMatchObject({
            key: opusKey,
            agentId: "opus",
            sessionId: firstId,
            usage: expect.objectContaining({ totalTokens: 100 }),
          });
          if (directOwner) {
            expect(result.sessions.find(({ key }) => key === directKey)).toMatchObject({
              agentId: "main",
              sessionId: firstId,
              usage: expect.objectContaining({ totalTokens: 10 }),
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
