import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionsListParams } from "../../../packages/gateway-protocol/src/index.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { notifyPreparedModelRuntimePublication } from "../../agents/prepared-model-runtime.publication-events.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import {
  loadSessionEntry,
  persistSessionTranscriptTurn,
  replaceSessionEntry,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import {
  isSessionTranscriptIndexReconcileRunning,
  reconcileSessionTranscriptIndexes,
  waitForSessionTranscriptIndexReconcile,
} from "../../config/sessions/session-transcript-reconcile.js";
import { mergeSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail, setUserProfileRole } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { invalidateOperatorRolePolicy } from "../operator-role-policy.js";
import { persistGatewaySessionLifecycleEvent } from "../session-lifecycle-state.js";
import { observeSessionRowBackfill } from "../session-row-backfill.test-support.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-store.js";
import {
  identifiedClient,
  initializeSessionReadContext,
  listSessions,
  requestContext,
  sessionReadHandlers,
  seedSessions,
  seedSessionsWithActivityTimes,
} from "./sessions-read-cache.test-support.js";
import type { GatewayRequestContext } from "./types.js";

const { emitSessionsChanged } = await import("./session-change-event.js");

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  resetAgentEventsForTest();
});

afterEach(() => {
  resetAgentEventsForTest();
  vi.restoreAllMocks();
});

describe("resident sessions.list", () => {
  it.each([{}, { search: "live" }, { activeOnly: true }])(
    "refreshes reply activity including previously rejected candidates (%j)",
    async (filter: SessionsListParams) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const config = await seedSessions();
        const context = requestContext(config);
        const client = identifiedClient("owner@example.com");
        const request = { agentId: "main", ...filter, limit: 50 };
        const filtered = Boolean(filter.search || filter.activeOnly);
        const terminalScope = { agentId: "main", sessionKey: "agent:main:active" };
        await replaceSessionEntry(terminalScope, {
          ...loadSessionEntry(terminalScope)!,
          status: "done",
        });
        context.chatAbortControllers.set("retained-terminal", {
          sessionId: "main-active",
          sessionKey: terminalScope.sessionKey,
          agentId: "main",
          projectSessionActive: false,
        } as never);
        if (filtered) {
          expect((await listSessions({ client, context, request })).sessions).toEqual([]);
        }
        const operation = createReplyOperation({
          sessionId: "main-active",
          sessionKey: "agent:main:active",
          resetTriggered: false,
        });
        try {
          const active = await listSessions({ client, context, request });
          expect(active.sessions.find((row) => row.key === terminalScope.sessionKey)).toMatchObject(
            { hasActiveRun: true, status: "running" },
          );
          operation.complete();
          if (!filtered) {
            vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1_000);
          }
          const settled = await listSessions({ client, context, request });
          if (filtered) {
            expect(settled.sessions).toEqual([]);
          } else {
            expect(
              settled.sessions.find((row) => row.key === terminalScope.sessionKey),
            ).toMatchObject({ hasActiveRun: false, status: "done" });
          }
        } finally {
          operation.complete();
        }
      });
    },
  );

  it.each([
    { agentId: "main", archived: false as const, limit: 10 },
    { agentId: "main", archived: true as const, limit: 1 },
    { agentId: "work", archived: "all" as const, limit: 10 },
    { archived: "all" as const, limit: 2 },
  ])("preserves output for filters and pagination: %j", async (request) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      const config = await seedSessions();
      const client = identifiedClient("owner@example.com");
      const expected = await listSessions({
        client,
        context: requestContext(config),
        request,
      });
      const sharedContext = requestContext(config);

      const collapsed = await Promise.all(
        Array.from({ length: 4 }, () => listSessions({ client, context: sharedContext, request })),
      );

      expect(collapsed).toEqual(Array.from({ length: 4 }, () => expected));
    });
  });

  it("serves concurrent requests from resident rows without SQLite", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      const context = requestContext(config);
      const client = identifiedClient("owner@example.com");

      const enriched = observeSessionRowBackfill([
        "agent:main:active",
        "agent:main:draft",
        "agent:main:archived",
        "agent:work:active",
      ]);
      await initializeSessionReadContext(context);
      await listSessions({ client, context, request: { archived: "all", limit: 100 } });
      await enriched;
      const statements = vi.spyOn(DatabaseSync.prototype, "prepare");
      const results = await Promise.all(
        Array.from({ length: 16 }, () =>
          listSessions({ client, context, request: { archived: "all", limit: 100 } }),
        ),
      );

      for (const result of results) {
        expect(result.sessions).toEqual(results[0]?.sessions);
      }
      expect(statements).not.toHaveBeenCalled();
    });
  });

  it("presents current runner availability from resident bindings", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      let runnerAvailable = true;
      const placement = {
        sessionId: "main-active",
        sessionKey: "agent:main:active",
        agentId: "main",
        executionMode: "worker-turn",
        state: "active",
        generation: 4,
        environmentId: "environment-device",
        activeOwnerEpoch: 2,
        workerBundleHash: "a".repeat(64),
        workspaceBaseManifestRef: "manifest-device",
        remoteWorkspaceDir: "/workspace",
        lastTranscriptAckCursor: null,
        lastLiveEventAckCursor: null,
        recoveryError: null,
        terminalReason: null,
        terminalAtMs: null,
        turnClaim: null,
        createdAtMs: 1,
        updatedAtMs: 2,
        stateChangedAtMs: 2,
      } satisfies WorkerSessionPlacementRecord;
      const context = {
        ...requestContext(config),
        workerSessionPlacementService: {
          getMany: () =>
            new Map<string, WorkerSessionPlacementRecord>([[placement.sessionId, placement]]),
        },
        workerPlacementRunnerAvailabilityReader: {
          version: () => Number(!runnerAvailable),
          read: () => ({
            kind: "device" as const,
            status: runnerAvailable ? ("available" as const) : ("offline" as const),
          }),
        },
      } as GatewayRequestContext;
      const client = identifiedClient("owner@example.com");
      const request = { agentId: "main", archived: "all" as const, limit: 100 };

      const available = await listSessions({ client, context, request });
      expect(
        available.sessions.find((session) => session.key === placement.sessionKey)?.placement,
      ).toMatchObject({ runner: { kind: "device", status: "available" } });
      expect((await listSessions({ client, context, request })).sessions).toEqual(
        available.sessions,
      );

      runnerAvailable = false;
      const offline = await listSessions({ client, context, request });
      expect(
        offline.sessions.find((session) => session.key === placement.sessionKey)?.placement,
      ).toMatchObject({ runner: { kind: "device", status: "offline" } });
    });
  });

  it("reprojects rows after completed model catalog publication", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      config.agents = {
        ...config.agents,
        defaults: { model: { primary: "dynamic-router/reasoner" } },
      };
      const startupCatalog: ModelCatalogEntry[] = [
        {
          provider: "dynamic-router",
          id: "reasoner",
          name: "Reasoner",
          reasoning: false,
        },
      ];
      const fullCatalog: ModelCatalogEntry[] = [
        {
          provider: "dynamic-router",
          id: "reasoner",
          name: "Reasoner",
          reasoning: true,
          compat: { supportedReasoningEfforts: ["low", "high", "max"] },
        },
      ];
      let catalog = startupCatalog;
      const context = {
        ...requestContext(config),
        readPreparedGatewayModelCatalog: vi.fn(async () => ({ entries: catalog })),
      };
      const client = identifiedClient("owner@example.com");
      const request = { archived: "all" as const, limit: 100 };

      const first = await listSessions({ client, context, request });
      expect(first.sessions.find((session) => session.agentId === "main")?.thinkingOptions).toEqual(
        ["off"],
      );
      expect((await listSessions({ client, context, request })).sessions).toEqual(first.sessions);

      const mainRequest = { ...request, agentId: "main" };
      const workRequest = { ...request, agentId: "work" };
      const main = await listSessions({ client, context, request: mainRequest });
      const work = await listSessions({ client, context, request: workRequest });
      expect((await listSessions({ client, context, request: mainRequest })).sessions).toEqual(
        main.sessions,
      );
      expect((await listSessions({ client, context, request: workRequest })).sessions).toEqual(
        work.sessions,
      );
      expect((await listSessions({ client, context, request })).sessions).toEqual(first.sessions);
      catalog = fullCatalog;
      notifyPreparedModelRuntimePublication({ phase: "catalog-published" });
      const refreshed = await listSessions({ client, context, request });
      expect(
        refreshed.sessions.find((session) => session.agentId === "main")?.thinkingOptions,
      ).toEqual(expect.arrayContaining(["off", "low", "high", "max"]));
    });
  });

  it("rebuilds configured targets after registry-only register and unregister", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const config = await seedSessions();
      const extraStorePath = path.join(state.stateDir, "extra-main-sessions.json");
      const extraDatabasePath = resolveSqliteTargetFromSessionStorePath(extraStorePath, {
        agentId: "main",
      }).path;
      const extraSessionKey = "agent:main:registry-only";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: extraSessionKey, storePath: extraStorePath },
        {
          sessionId: "registry-only",
          updatedAt: 500,
          createdActor: { type: "human", source: "profile", id: "owner@example.com" },
          visibility: "shared",
        },
      );
      closeOpenClawAgentDatabaseByPath(extraDatabasePath);
      unregisterOpenClawAgentDatabase({ agentId: "main", env: state.env, path: extraDatabasePath });

      const context = requestContext(config);
      const client = identifiedClient("owner@example.com");
      const request = { archived: "all" as const, configuredAgentsOnly: true, limit: 100 };
      const first = await listSessions({ client, context, request });
      expect(first.sessions.map((session) => session.key)).not.toContain(extraSessionKey);
      expect((await listSessions({ client, context, request })).sessions).toEqual(first.sessions);

      registerOpenClawAgentDatabase({ agentId: "main", env: state.env, path: extraDatabasePath });
      const registered = await listSessions({ client, context, request });
      expect(registered.sessions.map((session) => session.key)).toContain(extraSessionKey);
      expect((await listSessions({ client, context, request })).sessions).toEqual(
        registered.sessions,
      );

      unregisterOpenClawAgentDatabase({ agentId: "main", env: state.env, path: extraDatabasePath });
      const unregistered = await listSessions({ client, context, request });
      expect(unregistered.sessions.map((session) => session.key)).not.toContain(extraSessionKey);
    });
  });

  it("excludes incognito stores across their open and closed generations", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const config = await seedSessions();
      const context = requestContext(config);
      const client = identifiedClient("owner@example.com");
      client.connect.scopes = [...(client.connect.scopes ?? []), "operator.admin"];
      const request = { archived: "all" as const, configuredAgentsOnly: true, limit: 100 };
      const childKey = "agent:guest:subagent:incognito-residency";
      const first = await listSessions({ client, context, request });
      expect(first.sessions.map((session) => session.key)).not.toContain(childKey);
      expect((await listSessions({ client, context, request })).sessions).toEqual(first.sessions);

      const incognitoPath = resolveIncognitoOpenClawAgentSqlitePath({
        agentId: "guest",
        env: state.env,
      });
      const database = openOpenClawAgentDatabase({
        agentId: "guest",
        env: state.env,
        path: incognitoPath,
      });
      const entry = {
        sessionId: "incognito-residency",
        updatedAt: 600,
        incognito: true,
        parentSessionKey: "agent:main:active",
      };
      database.db
        .prepare(
          "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at, parent_session_key) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          childKey,
          entry.sessionId,
          JSON.stringify(entry),
          entry.updatedAt,
          entry.parentSessionKey,
        );
      database.db
        .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
        .run(childKey);

      const opened = await listSessions({ client, context, request });
      expect(opened.sessions.map((session) => session.key)).not.toContain(childKey);

      expect(closeOpenClawAgentDatabaseByPath(incognitoPath)).toBe(true);
      const closed = await listSessions({ client, context, request });
      expect(closed.sessions.map((session) => session.key)).not.toContain(childKey);
    });
  });

  it("refreshes the resident row after terminal lifecycle persistence", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      const context = requestContext(config);
      const client = identifiedClient("owner@example.com");
      const request = { archived: "all" as const, limit: 100 };
      const clock = vi.spyOn(Date, "now").mockReturnValue(60_400);

      const first = await listSessions({ client, context, request });
      clock.mockReturnValue(60_401);
      expect((await listSessions({ client, context, request })).sessions).toEqual(
        first.sessions.map((row) => Object.assign({}, row, { snapshotAt: 60_401 })),
      );

      // Terminal persistence must update resident rows after the run has ended.
      await persistGatewaySessionLifecycleEvent({
        sessionKey: "agent:main:active",
        agentId: "main",
        event: {
          ts: 60_500,
          runId: "run-terminal-resident",
          data: { phase: "end", startedAt: 60_000, endedAt: 60_450 },
        },
      });
      const settled = await listSessions({ client, context, request });
      expect(settled.sessions.find((row) => row.key === "agent:main:active")).toMatchObject({
        status: "done",
        endedAt: 60_450,
        runtimeMs: 450,
      });
    });
  });

  it("refreshes row previews after a committed transcript update", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      const context = requestContext(config);
      const client = identifiedClient("owner@example.com");
      const request = { archived: "all" as const, limit: 100, includeLastMessage: true };
      const clock = vi.spyOn(Date, "now").mockReturnValue(60_400);

      const first = await listSessions({ client, context, request });
      clock.mockReturnValue(60_401);

      await persistSessionTranscriptTurn(
        { agentId: "main", sessionId: "main-active", sessionKey: "agent:main:active" },
        {
          messages: [{ message: { role: "assistant", content: "Fresh committed preview" } }],
          touchSessionEntry: false,
        },
      );
      emitSessionTranscriptUpdate({
        target: { agentId: "main", sessionId: "main-active", sessionKey: "agent:main:active" },
      });
      await vi.waitFor(() =>
        expect(
          getSessionRowProjection(context)?.snapshot(
            { agentId: "main", key: "agent:main:active" },
            { includeLastMessage: true },
          ).row?.lastMessagePreview,
        ).toBe("Fresh committed preview"),
      );
      const refreshed = await listSessions({ client, context, request });
      expect(
        first.sessions.find((row) => row.key === "agent:main:active")?.lastMessagePreview,
      ).toBeUndefined();
      expect(
        refreshed.sessions.find((row) => row.key === "agent:main:active")?.lastMessagePreview,
      ).toBe("Fresh committed preview");
    });
  });

  it("refreshes reconciled previews without repairing legacy titles", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const config = await seedSessions();
      const sessionKey = "agent:main:active";
      const sessionId = "main-active";
      await persistSessionTranscriptTurn(
        { agentId: "main", sessionId, sessionKey },
        {
          messages: [
            { message: { role: "user", content: "active prompt" } },
            { message: { role: "assistant", content: "active reply" } },
          ],
          touchSessionEntry: false,
        },
      );
      await waitForSessionTranscriptIndexReconcile({ agentId: "main", env: state.env });
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      database.db
        .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
        .run(sessionId);
      const storedEntry = loadSessionEntry({ agentId: "main", sessionKey });
      expect(storedEntry?.displayName).toBeUndefined();
      const context = requestContext(config);
      const client = identifiedClient("owner@example.com");
      const request = {
        agentId: "main",
        archived: "all" as const,
        includeDerivedTitles: true,
        includeLastMessage: true,
        limit: 100,
      };

      const backfilled = observeSessionRowBackfill([sessionKey]);
      const degraded = await listSessions({ client, context, request });
      const degradedRow = degraded.sessions.find((session) => session.key === sessionKey);
      expect(degradedRow?.derivedTitle).toBeUndefined();
      expect(degradedRow?.lastMessagePreview).toBeUndefined();

      await backfilled;
      const reconcileTarget = { agentId: database.agentId, path: database.path, env: state.env };
      expect(isSessionTranscriptIndexReconcileRunning(reconcileTarget)).toBe(false);
      expect(
        database.db
          .prepare("SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?")
          .get(sessionId),
      ).toMatchObject({ needs_rebuild: 1 });
      await expect(reconcileSessionTranscriptIndexes(reconcileTarget)).resolves.toEqual({
        reconciledSessions: 1,
      });
      await vi.waitFor(async () =>
        expect(
          (await listSessions({ client, context, request })).sessions.find(
            (row) => row.key === sessionKey,
          )?.lastMessagePreview,
        ).toBe("active reply"),
      );
      const healed = await listSessions({ client, context, request });
      expect(healed.sessions.find((session) => session.key === sessionKey)).toMatchObject({
        derivedTitle: undefined,
        lastMessagePreview: "active reply",
      });

      expect((await listSessions({ client, context, request })).sessions).toEqual(healed.sessions);
      expect(loadSessionEntry({ agentId: "main", sessionKey })).toEqual(storedEntry);
    });
  });

  it("admits a newly committed session after the roster was loaded", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      const context = requestContext(config);
      const client = identifiedClient("owner@example.com");
      const request = { archived: "all" as const, limit: 100 };

      const first = await listSessions({ client, context, request });
      expect(first.sessions.map((row) => row.key)).not.toContain("agent:main:external");
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:external" },
        {
          sessionId: "main-external",
          updatedAt: 500,
          createdActor: { type: "human", source: "profile", id: "owner@example.com" },
          visibility: "shared",
        },
      );
      const refreshed = await listSessions({ client, context, request });

      expect(refreshed.sessions.map((session) => session.key)).toContain("agent:main:external");
    });
  });

  it("presents agent-status expiry at each clock boundary", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const config = await seedSessions();
      for (const [name, expiresAt] of [
        ["active", 1_100],
        ["draft", 1_200],
      ] as const) {
        const scope = { agentId: "main", sessionKey: `agent:main:${name}` };
        const entry = loadSessionEntry(scope);
        if (!entry) {
          throw new Error(`Missing seeded session ${scope.sessionKey}`);
        }
        await replaceSessionEntry(scope, {
          ...entry,
          agentStatus: { note: `${name} needs attention`, expiresAt },
        });
      }
      const context = requestContext(config);
      const client = identifiedClient("owner@example.com");
      const request = { agentId: "main", archived: "all" as const, limit: 100 };

      const first = await listSessions({ client, context, request });
      expect(
        first.sessions.find((session) => session.key === "agent:main:active")?.agentStatus,
      ).toMatchObject({ expiresAt: 1_100 });
      expect(
        first.sessions.find((session) => session.key === "agent:main:draft")?.agentStatus,
      ).toMatchObject({ expiresAt: 1_200 });

      clock.mockReturnValue(1_099);
      expect((await listSessions({ client, context, request })).sessions).toEqual(
        first.sessions.map((row) => Object.assign({}, row, { snapshotAt: 1_099 })),
      );

      clock.mockReturnValue(1_100);
      const expired = await Promise.all(
        Array.from({ length: 8 }, () => listSessions({ client, context, request })),
      );
      for (const result of expired) {
        expect(result.sessions).toEqual(expired[0]?.sessions);
      }
      expect(
        expired[0]?.sessions.find((session) => session.key === "agent:main:active")?.agentStatus,
      ).toBeUndefined();
      expect(
        expired[0]?.sessions.find((session) => session.key === "agent:main:draft")?.agentStatus,
      ).toMatchObject({ expiresAt: 1_200 });

      clock.mockReturnValue(1_199);
      expect((await listSessions({ client, context, request })).sessions).toEqual(
        expired[0]?.sessions.map((row) => Object.assign({}, row, { snapshotAt: 1_199 })),
      );

      clock.mockReturnValue(1_200);
      const allExpired = await listSessions({ client, context, request });
      expect(
        allExpired.sessions.find((session) => session.key === "agent:main:draft")?.agentStatus,
      ).toBeUndefined();
    });
  });

  it("expires retained child links when the child is outside the visible page", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { clock, config } = await seedSessionsWithActivityTimes();
      const parentSessionKey = "agent:main:active";
      const childSessionKey = "agent:main:zzz-child";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: childSessionKey },
        {
          sessionId: "completed-hidden-child",
          endedAt: 400,
          parentSessionKey,
          spawnedBy: parentSessionKey,
          status: "done",
          updatedAt: 400,
          visibility: "shared",
        },
      );
      const context = requestContext(config);
      const client = identifiedClient("owner@example.com");
      const request = { agentId: "main", archived: "all" as const, limit: 1 };

      clock.mockReturnValue(1_800_400);
      const retained = await listSessions({ client, context, request });
      expect(retained.sessions.map((session) => session.key)).toEqual([parentSessionKey]);
      expect(retained.sessions[0]?.childSessions).toEqual([childSessionKey]);

      clock.mockReturnValue(1_801_400);
      const expired = await listSessions({ client, context, request });
      expect(expired.sessions.map((session) => session.key)).toEqual([parentSessionKey]);
      expect(expired.sessions[0]?.childSessions).toBeUndefined();
    });
  });

  it("presents current live subagent runtimes to concurrent readers", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const now = 1_800_000_000_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const config = await seedSessions();
      const runId = "sessions-list-cache-live-subagent";
      addSubagentRunForTests({
        runId,
        childSessionKey: "agent:main:active",
        controllerSessionKey: "agent:main:draft",
        requesterSessionKey: "agent:main:draft",
        requesterDisplayKey: "main",
        task: "prove session runtime freshness",
        cleanup: "keep",
        createdAt: now - 1_000,
        startedAt: now - 1_000,
      });
      registerAgentRunContext(runId, {
        agentId: "main",
        projectSessionActive: true,
        sessionId: "main-active",
        sessionKey: "agent:main:active",
      });
      try {
        const context = requestContext(config);
        const client = identifiedClient("owner@example.com");
        const request = { agentId: "main", archived: "all" as const, limit: 1 };

        const first = await listSessions({ client, context, request });
        expect(first.sessions[0]).toMatchObject({
          key: "agent:main:active",
          hasActiveSubagentRun: true,
          runtimeMs: 1_000,
        });

        const projection = getSessionRowProjection(context)!;
        const select = vi.spyOn(projection, "selectEntries");
        sessionChanges.emit({ agentId: "main", sessionKey: "agent:main:active", scope: "runtime" });
        clock.mockReturnValue(now + 250);
        expect((await listSessions({ client, context, request })).sessions[0]?.runtimeMs).toBe(
          1_250,
        );
        sessionChanges.emit({ all: true, scope: "agent-runs" });
        clock.mockReturnValue(now + 1_000);
        const fresh = await Promise.all(
          Array.from({ length: 8 }, () => listSessions({ client, context, request })),
        );
        for (const result of fresh) {
          expect(result.sessions).toEqual(fresh[0]?.sessions);
        }
        expect(fresh[0]?.sessions[0]).toMatchObject({
          hasActiveSubagentRun: true,
          runtimeMs: 2_000,
        });
        expect(select).not.toHaveBeenCalled();

        const scope = { agentId: "main", sessionKey: "agent:main:active" };
        replaceSessionEntrySync(scope, { ...loadSessionEntry(scope)!, label: "Updated label" });
        expect((await listSessions({ client, context, request })).sessions[0]).toMatchObject({
          label: "Updated label",
          runtimeMs: 2_000,
        });
      } finally {
        clearAgentRunContext(runId);
        resetSubagentRegistryForTests({ persist: false });
      }
    });
  });

  it.each([
    {
      description: "the last visible row crosses the inclusive activity cutoff",
      now: 60_400,
      limit: 100,
      before: { keys: ["agent:main:active"], totalCount: 1 },
      after: { keys: [], totalCount: 0 },
    },
    {
      description: "an older row outside the current page expires",
      now: 60_200,
      limit: 1,
      before: { keys: ["agent:main:active"], totalCount: 3 },
      after: { keys: ["agent:main:active"], totalCount: 2 },
    },
  ])("refreshes activity-filtered results when $description", async (scenario) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { clock, config } = await seedSessionsWithActivityTimes();
      const context = requestContext(config);
      const client = identifiedClient("owner@example.com");
      clock.mockReturnValue(scenario.now);
      const request = {
        activeMinutes: 1,
        agentId: "main",
        archived: "all" as const,
        limit: scenario.limit,
      };

      const before = await listSessions({ client, context, request });
      expect(before.sessions.map((session) => session.key)).toEqual(scenario.before.keys);
      expect(before.totalCount).toBe(scenario.before.totalCount);

      clock.mockReturnValue(scenario.now + 1);
      const after = await listSessions({ client, context, request });
      expect(after.sessions.map((session) => session.key)).toEqual(scenario.after.keys);
      expect(after.totalCount).toBe(scenario.after.totalCount);
    });
  });

  it("expires completed children from parent-filtered listings at the retention boundary", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { clock, config } = await seedSessionsWithActivityTimes();
      const parentSessionKey = "agent:main:active";
      const childSessionKey = "agent:main:child";
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: childSessionKey },
        mergeSessionEntry(undefined, {
          sessionId: "completed-child",
          endedAt: 400,
          parentSessionKey,
          spawnedBy: parentSessionKey,
          status: "done",
          updatedAt: 400,
          visibility: "shared",
        }),
      );
      const context = requestContext(config);
      const client = identifiedClient("owner@example.com");
      const request = { agentId: "main", limit: 100, spawnedBy: parentSessionKey };

      clock.mockReturnValue(1_800_400);
      const retained = await listSessions({ client, context, request });
      expect(retained.sessions.map((session) => session.key)).toEqual([childSessionKey]);

      clock.mockReturnValue(1_800_401);
      const expired = await listSessions({ client, context, request });
      expect(expired.sessions).toEqual([]);
    });
  });

  it("rejects a zero-minute activity window without loading the session store", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      const respond = vi.fn();

      await sessionReadHandlers["sessions.list"]?.({
        req: { type: "req", id: "session-list-test", method: "sessions.list" },
        params: { activeMinutes: 0 },
        client: identifiedClient("owner@example.com"),
        context: requestContext(config),
        respond,
      } as never);

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    });
  });

  it.each(["ownerFirst", "involvingMe"] as const)(
    "keeps administrator %s projections scoped to their authenticated profiles",
    async (projection) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const config: OpenClawConfig = { agents: { list: [{ id: "main", default: true }] } };
        const context = requestContext(config);
        const clients = ["ada@example.com", "bob@example.com"].map((email) => {
          const client = identifiedClient(ensureProfileForEmail(email).id);
          client.connect.scopes = ["operator.admin"];
          return client;
        });
        for (const [index, client] of clients.entries()) {
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: `agent:main:profile-${index}` },
            {
              sessionId: `profile-${index}`,
              updatedAt: index + 1,
              createdVia: "operator",
              createdActor: {
                type: "human",
                source: "profile",
                id: client.authenticatedUserProfile!.profileId,
              },
            },
          );
        }
        const request: SessionsListParams = { agentId: "main", limit: 1, [projection]: true };

        const results = await Promise.all(
          clients.map((client) => listSessions({ client, context, request })),
        );

        for (const [index, client] of clients.entries()) {
          expect(results[index]?.sessions[0]?.key).toBe(`agent:main:profile-${index}`);
          expect((await listSessions({ client, context, request })).sessions).toEqual(
            results[index]?.sessions,
          );
        }
      });
    },
  );

  it("applies each current client identity and operator role", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      const context = requestContext(config);

      const [owner, viewer] = await Promise.all([
        listSessions({
          client: identifiedClient("owner@example.com"),
          context,
          request: { agentId: "main", archived: "all", limit: 100 },
        }),
        listSessions({
          client: identifiedClient("viewer@example.com"),
          context,
          request: { agentId: "main", archived: "all", limit: 100 },
        }),
      ]);

      expect(owner.sessions.map((session) => session.key)).toContain("agent:main:draft");
      expect(viewer.sessions.map((session) => session.key)).not.toContain("agent:main:draft");
      const scopes: Array<"operator.read" | "operator.write"> = ["operator.read", "operator.write"];
      const defineRole = (others: "write" | "none") => ({
        sessions: { others },
        agents: "*" as const,
        scopes,
      });
      config.gateway = {
        roles: {
          default: "maintainer",
          definitions: {
            maintainer: defineRole("write"),
            guest: defineRole("none"),
          },
        },
      };
      const profile = ensureProfileForEmail("cache-role@example.com");
      const request = { agentId: "main", archived: "all" as const, limit: 100 };
      const listProfileSessions = () =>
        listSessions({ client: identifiedClient(profile.id), context, request });
      const privileged = await listProfileSessions();
      expect(privileged.sessions.map((session) => session.key)).toContain("agent:main:active");
      setUserProfileRole(profile.id, "guest");
      invalidateOperatorRolePolicy(profile.id);
      const restricted = await listProfileSessions();
      expect(restricted.sessions.map((session) => session.key)).not.toContain("agent:main:active");
    });
  });

  it.each([{}, { search: "direct" }, { activeOnly: true }])(
    "selects the current visible page after a readiness yield (%j)",
    async (filter: SessionsListParams) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const { clock, config } = await seedSessionsWithActivityTimes();
        for (const [name, updatedAt] of [
          ["third", 500],
          ["second", 600],
          ["first", 700],
        ] as const) {
          clock.mockReturnValue(updatedAt);
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: `agent:main:page-${name}` },
            {
              sessionId: `page-${name}`,
              updatedAt,
              createdActor: { type: "human", source: "profile", id: "owner@example.com" },
              visibility: "shared",
            },
          );
        }
        const context = requestContext(config);
        if (filter.activeOnly) {
          for (const name of ["first", "second", "third"]) {
            context.chatAbortControllers.set(`page-run-${name}`, {
              sessionId: `page-${name}`,
              sessionKey: `agent:main:page-${name}`,
              agentId: "main",
            } as never);
          }
        }
        const client = identifiedClient("viewer@example.com");
        await initializeSessionReadContext(context);
        const projection = getSessionRowProjection(context)!;
        const ensure = projection.ensureMaterialized.bind(projection);
        let releaseRows!: () => void;
        const gate = new Promise<void>((resolve) => {
          releaseRows = resolve;
        });
        const readiness = vi
          .spyOn(projection, "ensureMaterialized")
          .mockImplementationOnce(async () => {
            await gate;
            await ensure();
          });

        const firstPage = listSessions({
          client,
          context,
          request: { ...filter, agentId: "main", archived: "all", limit: 1 },
        });
        await vi.waitFor(() => expect(readiness).toHaveBeenCalledOnce());
        clock.mockReturnValue(800);
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: "agent:main:page-first" },
          { visibility: "draft", updatedAt: 800 },
        );
        emitSessionsChanged(context, {
          reason: "sharing",
          sessionKey: "agent:main:page-first",
        });
        const listEntries = vi.spyOn(sessionAccessor, "listSessionEntriesCore");
        releaseRows();

        const repaired = await firstPage;
        expect(repaired.sessions.map((session) => session.key)).toEqual(["agent:main:page-second"]);
        expect(repaired).toMatchObject({ count: 1, nextOffset: 1 });
        // Fresh visibility checks only need selected rows, including the replacement page.
        expect(listEntries).not.toHaveBeenCalled();

        const next = await listSessions({
          client,
          context,
          request: { ...filter, agentId: "main", archived: "all", limit: 1, offset: 1 },
        });
        expect(next.sessions.map((session) => session.key)).toEqual(["agent:main:page-third"]);
      });
    },
  );

  it("preserves readiness failures and allows the next request to retry", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      const context = requestContext(config);
      const client = identifiedClient("owner@example.com");
      const request = { archived: "all" as const, limit: 100 };
      await initializeSessionReadContext(context);
      const projection = getSessionRowProjection(context)!;
      vi.spyOn(projection, "ensureMaterialized").mockRejectedValueOnce(
        new Error("synthetic materialization failure"),
      );

      await expect(listSessions({ client, context, request })).rejects.toThrow(
        "synthetic materialization failure",
      );
      await expect(listSessions({ client, context, request })).resolves.toMatchObject({
        sessions: expect.any(Array),
      });
    });
  });
});
