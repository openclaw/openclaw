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
  createOpenClawTestState,
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

it.each([
  {
    name: "generated title",
    displayName: "Usage worktree",
    label: undefined,
    expected: "Usage worktree",
  },
  {
    name: "explicit rename",
    displayName: "Generated title",
    label: "My renamed chat",
    expected: "My renamed chat",
  },
  { name: "unnamed session", displayName: undefined, label: undefined, expected: undefined },
])(
  "projects the $name through overview and selected usage",
  async ({ displayName, label, expected }) => {
    const state = await createOpenClawTestState({ label: "usage-session-title" });
    try {
      await state.writeConfig({
        agents: { ownership: "explicit", entries: { main: {} } },
        plugins: { enabled: false },
      });
      const config = getRuntimeConfig();
      const key = "agent:main:dashboard:usage-title";
      const sessionId = "usage-title-instance";
      const timestamp = Date.now();
      const scope = {
        agentId: "main",
        sessionKey: key,
        sessionId,
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      };
      await upsertSessionEntryCore(scope, { sessionId, updatedAt: timestamp, displayName, label });
      await persistSessionTranscriptTurn(scope, {
        cwd: state.workspaceDir,
        updateMode: "none",
        messages: [{ message: usageMessage(17, timestamp), now: timestamp }],
      });
      // Wait for the real accounting projection before testing its presentation metadata.
      await loadSessionCostSummary({ agentId: "main", sessionId, sessionTarget: scope, config });

      for (const specificKey of [undefined, key]) {
        const respond = vi.fn();
        await expectDefined(
          usageHandlers["sessions.usage"],
          "usage handler",
        )({
          params: {
            ...(specificKey ? { key: specificKey } : {}),
            range: "all",
            groupBy: "instance",
          },
          context: { getRuntimeConfig: () => config },
          respond,
        } as unknown as Parameters<(typeof usageHandlers)["sessions.usage"]>[0]);
        expect(respond).toHaveBeenCalledOnce();
        const [ok, payload] = expectDefined(respond.mock.calls[0], "usage response");
        expect(ok).toBe(true);
        const result = payload as SessionsUsageResult;
        expect(result.sessions).toHaveLength(1);
        expect(result.sessions[0]).toMatchObject({
          key,
          sessionId,
          agentId: "main",
          label: expected,
          usage: { totalTokens: 17, totalCost: 0.01 },
        });
        expect(result.totals).toMatchObject({ totalTokens: 17, totalCost: 0.01 });
      }
    } finally {
      await state.cleanup();
    }
  },
);

it("hydrates context metadata only for emitted usage rows while aggregating every match", async () => {
  const state = await createOpenClawTestState({ label: "usage-page-metadata" });
  try {
    await state.writeConfig({
      agents: { ownership: "explicit", entries: { main: {}, opus: {} } },
      plugins: { enabled: false },
    });
    const config = getRuntimeConfig();
    const ada = ensureProfileForEmail("ada@example.test");
    const bob = ensureProfileForEmail("bob@example.test");
    const timestamp = Date.now() - 60_000;
    const fixtures = ["main", "opus"].flatMap((agentId, agentIndex) =>
      Array.from({ length: 8 }, (_, index) => {
        const ordinal = agentIndex * 8 + index;
        const report: SessionSystemPromptReport | undefined =
          ordinal === 0
            ? undefined
            : {
                source: "run",
                generatedAt: timestamp + ordinal,
                systemPrompt: {
                  chars: 100 + ordinal,
                  projectContextChars: ordinal,
                  nonProjectContextChars: 100,
                },
                injectedWorkspaceFiles: [],
                skills: { promptChars: 65_536, entries: [] },
                tools: { listChars: ordinal, schemaChars: 0, entries: [] },
              };
        return {
          agentId,
          sessionId: `usage-page-${index}`,
          key: `agent:${agentId}:usage-page-${index}`,
          label: `${agentId} usage ${index}`,
          updatedAt: timestamp + ordinal,
          tokens: agentIndex * 100 + index + 1,
          promptMarker: `usage-page-prompt-${agentId}-${index}:`,
          report,
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
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Recorded usage" }],
        api: "openai-responses",
        provider: "fixture",
        model: "usage-model",
        stopReason: "stop",
        timestamp: fixture.updatedAt,
        usage: {
          input: fixture.tokens,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: fixture.tokens,
          cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
        },
      };
      await persistSessionTranscriptTurn(scope, {
        cwd: state.workspaceDir,
        updateMode: "none",
        messages: [{ message, now: fixture.updatedAt }],
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
    const totalTokens = fixtures.reduce((total, fixture) => total + fixture.tokens, 0);
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
      const respond = vi.fn<RespondFn>();
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
        await expectDefined(
          usageHandlers["sessions.usage"],
          "usage handler",
        )({
          params: {
            ...(scenario.key ? { key: scenario.key } : { agentScope: "all" }),
            range: "all",
            limit: scenario.selected.length,
            includeContextWeight: scenario.includeContextWeight,
            creatorKey: scenario.creatorKey,
          },
          context: createDirectChatContext({ getRuntimeConfig: () => config }),
          req: { type: "req", id: "usage-page-metadata", method: "sessions.usage" },
          client: null,
          isWebchatConnect: () => false,
          respond,
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
      expect(respond).toHaveBeenCalledOnce();
      const [ok, payload] = expectDefined(respond.mock.calls[0], "usage response");
      expect(ok).toBe(true);
      expect(payload).toMatchObject({
        sessions: scenario.selected.map((fixture) => ({
          key: fixture.key,
          agentId: fixture.agentId,
          sessionId: fixture.sessionId,
          label: fixture.label,
          updatedAt: fixture.updatedAt,
          usage: { totalTokens: fixture.tokens },
          hasContextWeight: Boolean(fixture.report),
          ...(scenario.includeContextWeight ? { contextWeight: fixture.report ?? null } : {}),
        })),
        totals: {
          totalTokens: scenario.key
            ? scenario.selected[0]?.tokens
            : scenario.creatorKey
              ? adaFixtures.reduce((total, fixture) => total + fixture.tokens, 0)
              : totalTokens,
        },
        aggregates: {
          sessionCount: scenario.key
            ? 1
            : scenario.creatorKey
              ? adaFixtures.length
              : fixtures.length,
        },
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
  } finally {
    await state.cleanup();
  }
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
      const contextWeight = {
        source: "run" as const,
        generatedAt: agentId === "ops" ? 10 : 20,
        systemPrompt: { chars: 100, projectContextChars: 40, nonProjectContextChars: 60 },
        injectedWorkspaceFiles: [],
        skills: { promptChars: 0, entries: [] },
        tools: { listChars: 0, schemaChars: 0, entries: [] },
      };
      replaceSessionEntrySync(
        { agentId, sessionKey: key, storePath },
        { sessionId: `${agentId}-usage`, updatedAt: 1, systemPromptReport: contextWeight },
      );
      const target = loadCombinedSessionStoreForGatewayCore(config, {
        agentId,
      }).targetsBySessionKey.get(key);
      expect(target?.agentId).toBe(agentId);
      expect(target?.storeTarget).toEqual({ agentId: "main", storePath });
      const respond = vi.fn<RespondFn>();
      await expectDefined(
        usageHandlers["sessions.usage"],
        "usage handler",
      )({
        req: { type: "req", id: agentId, method: "sessions.usage" },
        params: { range: "all", key, agentId, includeContextWeight: true },
        respond,
        client: null,
        isWebchatConnect: () => false,
        context: createDirectChatContext({ getRuntimeConfig: () => config }),
      });
      expect(respond).toHaveBeenCalledOnce();
      const [ok, payload] = expectDefined(respond.mock.calls[0], "shared usage response");
      expect(ok).toBe(true);
      expect(payload).toMatchObject({
        sessions: [{ key, agentId, hasContextWeight: true, contextWeight }],
      });
    }
  });
});

it.each([
  { owner: "opus", key: undefined },
  { owner: "opus", key: "agent:opus:slack:dm" },
  { owner: "opus", key: "global" },
  { owner: SYSTEM_AGENT_ID, key: `agent:${SYSTEM_AGENT_ID}:usage` },
])(
  "keeps independent same-id transcripts with $owner store key $key through the real usage handler",
  async ({ owner, key: opusKey }) => {
    const state = await createOpenClawTestState({ label: "usage-owner-integration" });
    try {
      await state.writeConfig({
        agents: { ownership: "explicit", entries: { main: {}, opus: {} } },
        plugins: { enabled: false },
      });
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
      const respond = vi.fn();
      const request = {
        params: { agentScope: "all", range: "all", limit: 50 },
        context: { getRuntimeConfig: () => config },
        respond,
      } as unknown as Parameters<(typeof usageHandlers)["sessions.usage"]>[0];
      await expectDefined(usageHandlers["sessions.usage"], "usage handler")(request);
      expect(respond).toHaveBeenCalledOnce();
      const [ok, payload] = expectDefined(respond.mock.calls[0], "usage response");
      expect(ok).toBe(true);
      const result = payload as SessionsUsageResult;
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
            const detail = vi.fn();
            await expectDefined(
              usageHandlers[method],
              "usage detail handler",
            )({
              ...request,
              params: {
                key: selected.key,
                ...(explicitOwner ? { agentId: selected.agentId } : {}),
              },
              respond: detail,
            });
            const [detailOk, detailPayload, detailError] = expectDefined(
              detail.mock.calls[0],
              "usage detail response",
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
    } finally {
      await state.cleanup();
    }
  },
);

it.each([
  { name: "SQLite history", artifact: undefined, directOwner: false, currentArtifact: false },
  {
    name: "a direct owner for a historical instance",
    artifact: undefined,
    directOwner: true,
    currentArtifact: false,
  },
  {
    name: "mixed JSONL and SQLite history",
    artifact: "plain",
    directOwner: false,
    currentArtifact: false,
  },
  {
    name: "mixed compressed JSONL and SQLite history",
    artifact: "zstd",
    directOwner: false,
    currentArtifact: false,
  },
  {
    name: "current JSONL discovered after SQLite history",
    artifact: undefined,
    directOwner: false,
    currentArtifact: true,
  },
])(
  "keeps family usage with $name before the current SQLite transcript exists",
  async ({ artifact, directOwner, currentArtifact }) => {
    const state = await createOpenClawTestState({ label: "usage-empty-current-family" });
    try {
      await state.writeConfig({
        agents: { ownership: "explicit", entries: { main: {}, opus: {} } },
        plugins: { enabled: false },
      });
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
        const encoded =
          artifact === "zstd"
            ? encodeSessionArchiveContent(content)
            : { bytes: Buffer.from(content), suffix: "" };
        expect(encoded.suffix).toBe(artifact === "zstd" ? ".zst" : "");
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
        const respond = vi.fn();
        await expectDefined(
          usageHandlers["sessions.usage"],
          "usage handler",
        )({
          params: {
            ...(specificKey ? { key: specificKey } : { agentScope: "all" }),
            range: "all",
            groupBy: "family",
            limit: 50,
          },
          context: { getRuntimeConfig: () => config },
          respond,
        } as unknown as Parameters<(typeof usageHandlers)["sessions.usage"]>[0]);
        expect(respond).toHaveBeenCalledOnce();
        const [ok, payload] = expectDefined(respond.mock.calls[0], "usage response");
        expect(ok).toBe(true);
        const result = payload as SessionsUsageResult;
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
    } finally {
      await state.cleanup();
    }
  },
);
