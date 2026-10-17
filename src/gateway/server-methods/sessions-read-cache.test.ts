import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionsListParams } from "../../../packages/gateway-protocol/src/index.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { notifyPreparedModelRuntimePublication } from "../../agents/prepared-model-runtime.publication-events.js";
import { resetSubagentRegistryForTests } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import {
  loadSessionEntry,
  persistSessionTranscriptTurn,
  replaceSessionEntry,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
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
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { invalidateOperatorRolePolicy } from "../operator-role-policy.js";
import { persistGatewaySessionLifecycleEvent } from "../session-lifecycle-state.js";
import {
  clearStoredSessionRowTranscriptForTest,
  observeSessionRowBackfill,
} from "../session-row-backfill.test-support.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import type { GatewaySessionRow } from "../session-utils.types.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-store.js";
import { activePlacement } from "../worker-environments/placement-suite.test-support.js";
import {
  identifiedClient,
  initializeSessionReadContext,
  listSessions as readList,
  requestContext,
  sessionReadHandlers,
  seedSessions,
  seedSessionsWithActivityTimes,
} from "./sessions-read-cache.test-support.js";
import {
  activateReadSession,
  addReadSubagent,
  ownedSessionEntry,
  sessionReader,
} from "./sessions-read-fixture.test-support.js";
import type { GatewayRequestContext } from "./types.js";

const { emitSessionsChanged } = await import("./session-change-event.js");
const listSessions = (params: Parameters<typeof readList>[0]) =>
  readList({ ...params, acceptsSerializedJson: true });

function rowFacts(rows: readonly GatewaySessionRow[]) {
  return rows.map(({ snapshotAt: _snapshotAt, ...row }) => row);
}

const allRows = { archived: "all", limit: 100 } as const;
const mainKey = "agent:main:active";
const mainScope = { agentId: "main", sessionKey: mainKey };
const keys = (result: Awaited<ReturnType<typeof listSessions>>) =>
  result.sessions.map((row) => row.key);
const mainRow = (result: Awaited<ReturnType<typeof listSessions>>) =>
  result.sessions.find((row) => row.key === mainKey);
async function patchEntry(
  scope: Parameters<typeof replaceSessionEntry>[0],
  patch: Partial<NonNullable<ReturnType<typeof loadSessionEntry>>>,
) {
  await replaceSessionEntry(scope, { ...loadSessionEntry(scope)!, ...patch });
}

async function listFixture() {
  return sessionReader(await seedSessions(), "owner@example.com", undefined, true);
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  resetAgentEventsForTest();
});

afterEach(() => {
  resetAgentEventsForTest();
  vi.restoreAllMocks();
});

it("omits unchanged sidebar rows without reusing membership or revoked access", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { context, list } = await listFixture();
    const request = { agentId: "main", rowMode: "sidebar", limit: 50 } as const;
    // Cold admission can publish enriched facts after the first selected page.
    await list(request);
    const initial = await list(request);
    expect(initial.sessions.length).toBeGreaterThan(0);
    expect(initial.rowsRevision).toEqual(expect.any(String));
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1_000);
    const conditional = { ...request, ifRowsRevision: initial.rowsRevision };
    const unchanged = await list(conditional);
    expect(unchanged).toMatchObject({
      sessions: [],
      rowsUnchanged: true,
      rowsRevision: initial.rowsRevision,
      count: initial.count,
      totalCount: initial.totalCount,
      ts: initial.ts + 1_000,
    });
    expect(unchanged.sharedFacts).toBeUndefined();
    for (const unrelated of [
      { agentId: "work", sessionKey: "agent:work:active" },
      { agentId: "main", sessionKey: "agent:main:archived" },
    ]) {
      await patchEntry(unrelated, { label: "Changed outside the held window" });
      const retained = await list(conditional);
      expect(retained).toMatchObject({
        sessions: [],
        rowsUnchanged: true,
        rowsRevision: initial.rowsRevision,
        count: initial.count,
        totalCount: initial.totalCount,
      });
    }
    const filtered = await list({ ...conditional, search: "no matching session" });
    expect([filtered.rowsUnchanged, filtered.totalCount]).toEqual([undefined, 0]);
    const scope = mainScope;
    await patchEntry(scope, { label: "Renamed sidebar row" });
    const changed = await list(conditional);
    expect(changed.rowsUnchanged).toBeUndefined();
    expect(changed.rowsRevision).not.toBe(initial.rowsRevision);
    expect(mainRow(changed)?.label).toBe("Renamed sidebar row");
    const admitted = { agentId: "main", sessionKey: "agent:main:archived" };
    await patchEntry(admitted, { archivedAt: undefined, updatedAt: Date.now() });
    const membership = await list({ ...request, ifRowsRevision: changed.rowsRevision });
    expect(membership.rowsUnchanged).toBeUndefined();
    expect(membership.rowsRevision).not.toBe(changed.rowsRevision);
    expect(keys(membership)).toEqual([
      "agent:main:archived",
      "agent:main:active",
      "agent:main:draft",
    ]);
    await patchEntry(scope, { visibility: "draft" });
    const revoked = await listSessions({
      client: identifiedClient("other@example.com"),
      context,
      request: { ...request, ifRowsRevision: membership.rowsRevision },
    });
    expect(revoked.rowsUnchanged).toBeUndefined();
    expect(revoked.sessions.some((row) => row.key === scope.sessionKey)).toBe(false);
  }));

it("refreshes reply activity including previously rejected candidates", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { context, list } = await listFixture();
    const request = { agentId: "main", search: "live", limit: 50 };
    const terminalScope = mainScope;
    await patchEntry(terminalScope, { status: "done" });
    context.chatAbortControllers.set("retained-terminal", {
      sessionId: "main-active",
      sessionKey: terminalScope.sessionKey,
      agentId: "main",
      projectSessionActive: false,
    } as never);
    expect((await list(request)).sessions).toEqual([]);
    const operation = createReplyOperation({
      sessionId: "main-active",
      sessionKey: "agent:main:active",
      resetTriggered: false,
    });
    try {
      const active = await list(request);
      expect(mainRow(active)).toMatchObject({
        hasActiveRun: true,
        status: "running",
      });
      operation.complete();
      const settled = await list(request);
      expect(settled.sessions).toEqual([]);
    } finally {
      operation.complete();
    }
  }));

it("presents current runner availability from resident bindings", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const config = await seedSessions();
    let runnerAvailable = true;
    const placement = activePlacement("main-active", {
      sessionKey: "agent:main:active",
    });
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
    const { list } = sessionReader(config, "owner@example.com", context, true);
    const request = { ...allRows, agentId: "main" };

    const available = await list(request);
    expect(mainRow(available)?.placement).toMatchObject({
      runner: { kind: "device", status: "available" },
    });
    expect((await list(request)).sessions).toEqual(available.sessions);

    runnerAvailable = false;
    const offline = await list(request);
    expect(mainRow(offline)?.placement).toMatchObject({
      runner: { kind: "device", status: "offline" },
    });
  }));

it("reprojects rows after completed model catalog publication", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const config = await seedSessions();
    config.agents = {
      ...config.agents,
      defaults: { model: { primary: "dynamic-router/reasoner" } },
    };
    const startupCatalog: ModelCatalogEntry[] = [
      { provider: "dynamic-router", id: "reasoner", name: "Reasoner", reasoning: false },
    ];
    let catalog = startupCatalog;
    const context = {
      ...requestContext(config),
      readPreparedGatewayModelCatalog: vi.fn(async () => ({ entries: catalog })),
    };
    const { list } = sessionReader(config, "owner@example.com", context, true);
    const request = allRows;

    const first = await list(request);
    expect(first.sessions.find((row) => row.agentId === "main")?.thinkingOptions).toEqual([
      "off",
      "ultra",
    ]);
    expect((await list(request)).sessions).toEqual(first.sessions);

    const mainRequest = { ...request, agentId: "main" };
    const workRequest = { ...request, agentId: "work" };
    const main = await list(mainRequest);
    const work = await list(workRequest);
    expect((await list(mainRequest)).sessions).toEqual(main.sessions);
    expect((await list(workRequest)).sessions).toEqual(work.sessions);
    expect((await list(request)).sessions).toEqual(first.sessions);
    catalog = [
      {
        ...startupCatalog[0]!,
        reasoning: true,
        compat: { supportedReasoningEfforts: ["low", "high", "max"] },
      },
    ];
    notifyPreparedModelRuntimePublication({ phase: "catalog-published" });
    const refreshed = await list(request);
    expect(refreshed.sessions.find((row) => row.agentId === "main")?.thinkingOptions).toEqual(
      expect.arrayContaining(["off", "low", "high", "max", "ultra"]),
    );
  }));

it("rebuilds configured targets after registry-only register and unregister", () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const config = await seedSessions();
    const extraStorePath = path.join(state.stateDir, "extra-main-sessions.json");
    const extraDatabasePath = resolveSqliteTargetFromSessionStorePath(extraStorePath, {
      agentId: "main",
    }).path;
    const extraSessionKey = "agent:main:registry-only";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: extraSessionKey, storePath: extraStorePath },
      ownedSessionEntry("registry-only", 500),
    );
    await closeOpenClawAgentDatabaseByPathAsync(extraDatabasePath);
    unregisterOpenClawAgentDatabase({ agentId: "main", env: state.env, path: extraDatabasePath });

    const { list } = sessionReader(config, "owner@example.com", undefined, true);
    const request = { ...allRows, configuredAgentsOnly: true };
    const first = await list(request);
    expect(keys(first)).not.toContain(extraSessionKey);
    expect((await list(request)).sessions).toEqual(first.sessions);

    registerOpenClawAgentDatabase({ agentId: "main", env: state.env, path: extraDatabasePath });
    const registered = await list(request);
    expect(keys(registered)).toContain(extraSessionKey);
    expect((await list(request)).sessions).toEqual(registered.sessions);

    unregisterOpenClawAgentDatabase({ agentId: "main", env: state.env, path: extraDatabasePath });
    const unregistered = await list(request);
    expect(keys(unregistered)).not.toContain(extraSessionKey);
  }));

it("excludes incognito sessions before and after their memory owner closes", () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { client, list } = await listFixture();
    client.connect.scopes = [...(client.connect.scopes ?? []), "operator.admin"];
    const request = { ...allRows, configuredAgentsOnly: true };
    const childKey = "agent:guest:subagent:incognito-residency";
    const first = await list(request);
    expect(keys(first)).not.toContain(childKey);
    expect((await list(request)).sessions).toEqual(first.sessions);

    const incognitoPath = resolveIncognitoOpenClawAgentSqlitePath({
      agentId: "guest",
      env: state.env,
    });
    try {
      await upsertSessionEntryCore(
        { agentId: "guest", sessionKey: childKey, storePath: incognitoPath, env: state.env },
        {
          sessionId: "incognito-residency",
          updatedAt: 600,
          incognito: true,
          parentSessionKey: "agent:main:active",
        },
      );
      const opened = await list(request);
      expect(keys(opened)).not.toContain(childKey);
    } finally {
      memorySessionActorOwners.closeDatabase({ agentId: "guest", path: incognitoPath });
    }
    const closed = await list(request);
    expect(keys(closed)).not.toContain(childKey);
  }));

it("refreshes the resident row after terminal lifecycle persistence", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { list } = await listFixture();
    const request = allRows;
    const clock = vi.spyOn(Date, "now").mockReturnValue(60_400);

    const first = await list(request);
    clock.mockReturnValue(60_401);
    expect(rowFacts((await list(request)).sessions)).toEqual(rowFacts(first.sessions));

    await persistGatewaySessionLifecycleEvent({
      sessionKey: "agent:main:active",
      agentId: "main",
      event: {
        ts: 60_500,
        runId: "run-terminal-resident",
        data: { phase: "end", startedAt: 60_000, endedAt: 60_450 },
      },
    });
    const settled = await list(request);
    expect(mainRow(settled)).toMatchObject({
      status: "done",
      endedAt: 60_450,
      runtimeMs: 450,
      snapshotAt: 60_401,
    });
  }));

it("refreshes row previews after a committed transcript update", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { context, list } = await listFixture();
    const request = { ...allRows, includeLastMessage: true };
    const clock = vi.spyOn(Date, "now").mockReturnValue(60_400);

    const initialBackfill = observeSessionRowBackfill(["agent:main:active"]);
    const first = await list(request);
    await initialBackfill;
    clock.mockReturnValue(60_401);

    const committedBackfill = observeSessionRowBackfill(
      ["agent:main:active"],
      getSessionRowProjection(context),
    );
    await persistSessionTranscriptTurn(
      { agentId: "main", sessionId: "main-active", sessionKey: "agent:main:active" },
      {
        messages: [{ message: { role: "assistant", content: "Fresh committed preview" } }],
        touchSessionEntry: false,
      },
    );
    await committedBackfill;
    const refreshed = await list(request);
    expect(mainRow(first)?.lastMessagePreview).toBeUndefined();
    expect(mainRow(refreshed)?.lastMessagePreview).toBe("Fresh committed preview");
  }));

it("refreshes reconciled previews without repairing legacy titles", () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
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
    clearStoredSessionRowTranscriptForTest({ agentId: "main", sessionId, sessionKey });
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    database.db
      .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
      .run(sessionId);
    const storedEntry = loadSessionEntry({ agentId: "main", sessionKey });
    expect(storedEntry?.displayName).toBeUndefined();
    const { list } = sessionReader(config, "owner@example.com", undefined, true);
    const request = {
      agentId: "main",
      archived: "all" as const,
      includeDerivedTitles: true,
      includeLastMessage: true,
      limit: 100,
    };

    const backfilled = observeSessionRowBackfill([sessionKey]);
    const degraded = await list(request);
    const degradedRow = mainRow(degraded);
    expect([degradedRow?.derivedTitle, degradedRow?.lastMessagePreview]).toEqual([
      undefined,
      undefined,
    ]);

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
      expect(mainRow(await list(request))?.lastMessagePreview).toBe("active reply"),
    );
    const healed = await list(request);
    const healedRow = mainRow(healed);
    expect([healedRow?.derivedTitle, healedRow?.lastMessagePreview]).toEqual([
      undefined,
      "active reply",
    ]);

    expect((await list(request)).sessions).toEqual(healed.sessions);
    expect(loadSessionEntry({ agentId: "main", sessionKey })).toEqual(storedEntry);
  }));

it("admits a newly committed session after the roster was loaded", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { list } = await listFixture();
    const request = allRows;

    const first = await list(request);
    expect(keys(first)).not.toContain("agent:main:external");
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: "agent:main:external" },
      ownedSessionEntry("main-external", 500),
    );
    const refreshed = await list(request);

    expect(keys(refreshed)).toContain("agent:main:external");
  }));

it.each([
  {
    view: "off-page child links",
    parentFiltered: false,
    child: "zzz-child",
    id: "completed-hidden-child",
    expiredAt: 1_801_400,
  },
  {
    view: "parent-filtered children",
    parentFiltered: true,
    child: "child",
    id: "completed-child",
    expiredAt: 1_800_401,
  },
])(
  "expires completed children from $view at the retention boundary",
  ({ parentFiltered, child, id, expiredAt }) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { clock, config } = await seedSessionsWithActivityTimes();
      const parentSessionKey = "agent:main:active";
      const childSessionKey = `agent:main:${child}`;
      const scope = { agentId: "main", sessionKey: childSessionKey };
      const entry = {
        sessionId: id,
        endedAt: 400,
        parentSessionKey,
        spawnedBy: parentSessionKey,
        status: "done" as const,
        updatedAt: 400,
        visibility: "shared" as const,
      };
      if (parentFiltered) {
        replaceSessionEntrySync(scope, mergeSessionEntry(undefined, entry));
      } else {
        await replaceSessionEntry(scope, entry);
      }
      const { list } = sessionReader(config, "owner@example.com", undefined, true);
      const request: SessionsListParams = parentFiltered
        ? { agentId: "main", limit: 100, spawnedBy: parentSessionKey }
        : { agentId: "main", archived: "all", limit: 1 };
      clock.mockReturnValue(1_800_400);
      const retained = await list(request);
      expect(retained.sessions.map(({ key }) => key)).toEqual([
        parentFiltered ? childSessionKey : parentSessionKey,
      ]);
      if (!parentFiltered) {
        expect(retained.sessions[0]?.childSessions).toEqual([childSessionKey]);
      }
      clock.mockReturnValue(expiredAt);
      const expired = await list(request);
      if (parentFiltered) {
        expect(expired.sessions).toEqual([]);
      } else {
        expect(expired.sessions.map(({ key }) => key)).toEqual([parentSessionKey]);
        expect(expired.sessions[0]?.childSessions).toBeUndefined();
      }
    }),
);

it("presents current live subagent runtimes to concurrent readers", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const config = await seedSessions();
    const runId = "sessions-list-cache-live-subagent";
    await addReadSubagent(runId, mainKey, "agent:main:draft", {
      requesterDisplayKey: "main",
      task: "prove session runtime freshness",
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
      const { context, list } = sessionReader(config, "owner@example.com", undefined, true);
      const request = { agentId: "main", archived: "all" as const, limit: 1 };

      const first = await list(request);
      expect(first.sessions[0]).toMatchObject({
        key: "agent:main:active",
        hasActiveSubagentRun: true,
        runtimeMs: 1_000,
      });

      const projection = getSessionRowProjection(context)!;
      const select = vi.spyOn(projection, "selectEntries");
      sessionChanges.emit({ agentId: "main", sessionKey: "agent:main:active", scope: "runtime" });
      clock.mockReturnValue(now + 250);
      expect((await list(request)).sessions[0]?.runtimeMs).toBe(1_250);
      sessionChanges.emit({ all: true, scope: "agent-runs" });
      clock.mockReturnValue(now + 1_000);
      const fresh = await Promise.all(Array.from({ length: 8 }, () => list(request)));
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
      expect((await list(request)).sessions[0]).toMatchObject({
        label: "Updated label",
        runtimeMs: 2_000,
      });
    } finally {
      clearAgentRunContext(runId);
      await resetSubagentRegistryForTests({ persist: false });
    }
  }));

it("refreshes activity-filtered totals when an older off-page row expires", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { clock, config } = await seedSessionsWithActivityTimes();
    const { list } = sessionReader(config, "owner@example.com", undefined, true);
    const request = { ...allRows, activeMinutes: 1, agentId: "main", limit: 1 };
    for (const [now, totalCount] of [
      [60_200, 3],
      [60_201, 2],
    ] as const) {
      clock.mockReturnValue(now);
      const result = await list(request);
      expect(keys(result)).toEqual([mainKey]);
      expect(result.totalCount).toBe(totalCount);
    }
  }));

it("rejects a zero-minute activity window without loading the session store", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const config = await seedSessions();
    const respond = vi.fn();

    await sessionReadHandlers["sessions.list"]?.({
      req: { type: "req", id: "session-list-test", method: "sessions.list" },
      params: { activeMinutes: 0 },
      acceptsSerializedJson: true,
      client: identifiedClient("owner@example.com"),
      context: requestContext(config),
      respond,
    } as never);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  }));

it.each(["ownerFirst", "involvingMe"] as const)(
  "keeps administrator %s projections scoped to their authenticated profiles",
  (projection) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config: OpenClawConfig = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(config);
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
    }),
);

it("applies each current client identity and operator role", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const config = await seedSessions();
    const context = requestContext(config);

    const request = { ...allRows, agentId: "main" };
    const readIdentity = (id: string) =>
      listSessions({ client: identifiedClient(id), context, request });
    const [owner, viewer] = await Promise.all([
      readIdentity("owner@example.com"),
      readIdentity("viewer@example.com"),
    ]);
    expect(keys(owner)).toContain("agent:main:draft");
    expect(keys(viewer)).not.toContain("agent:main:draft");
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
    const listProfileSessions = () =>
      listSessions({ client: identifiedClient(profile.id), context, request });
    const privileged = await listProfileSessions();
    expect(keys(privileged)).toContain(mainKey);
    setUserProfileRole(profile.id, "guest");
    invalidateOperatorRolePolicy(profile.id);
    const restricted = await listProfileSessions();
    expect(keys(restricted)).not.toContain(mainKey);
  }));

it.each([{}, { search: "direct" }, { activeOnly: true }])(
  "selects the current visible page after a readiness yield (%j)",
  (filter: SessionsListParams) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { clock, config } = await seedSessionsWithActivityTimes();
      for (const [name, updatedAt] of [
        ["third", 500],
        ["second", 600],
        ["first", 700],
      ] as const) {
        clock.mockReturnValue(updatedAt);
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: `agent:main:page-${name}` },
          ownedSessionEntry(`page-${name}`, updatedAt),
        );
      }
      const context = requestContext(config);
      if (filter.activeOnly) {
        for (const name of ["first", "second", "third"]) {
          activateReadSession(
            context,
            `page-run-${name}`,
            "main",
            `agent:main:page-${name}`,
            `page-${name}`,
          );
        }
      }
      const { list } = sessionReader(config, "viewer@example.com", context, true);
      await initializeSessionReadContext(context);
      const projection = getSessionRowProjection(context)!;
      const ensure = projection.prepareSelection.bind(projection);
      let releaseRows!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseRows = resolve;
      });
      const readiness = vi
        .spyOn(projection, "prepareSelection")
        .mockImplementationOnce(async (...args) => {
          await gate;
          await ensure(...args);
        });

      const request = { ...allRows, ...filter, agentId: "main", limit: 1 };
      const firstPage = list(request);
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
      expect(keys(repaired)).toEqual(["agent:main:page-second"]);
      expect(repaired).toMatchObject({ count: 1, nextOffset: 1 });
      expect(listEntries).not.toHaveBeenCalled();

      expect(keys(await list({ ...request, offset: 1 }))).toEqual(["agent:main:page-third"]);
    }),
);
