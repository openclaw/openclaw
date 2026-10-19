import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionsListParams } from "../../../packages/gateway-protocol/src/index.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { notifyPreparedModelRuntimePublication } from "../../agents/prepared-model-runtime.publication-events.js";
import { resetSubagentRegistryForTests } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
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
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.js";
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
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
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
import { createRpcSourceForTest } from "../test-helpers.rpc-source.js";
import { activePlacement } from "../worker-environments/placement-suite.test-support.js";
import {
  captureRpcTargetForTest,
  createActiveRpcSourceForTest,
} from "./rpc-source-fixtures.test-support.js";
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

function reader(
  config: OpenClawConfig,
  request: SessionsListParams = allRows,
  context = requestContext(config),
) {
  const fixture = sessionReader(config, "owner@example.com", context, true);
  return {
    ...fixture,
    list: (params: SessionsListParams = {}) => fixture.list({ ...request, ...params }),
  };
}

async function listFixture(request: SessionsListParams = allRows) {
  return reader(await seedSessions(), request);
}

async function stableRows(list: ReturnType<typeof reader>["list"]) {
  const first = await list();
  expect((await list()).sessions).toEqual(first.sessions);
  return first;
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  resetAgentEventsForTest();
});

afterEach(() => {
  resetAgentEventsForTest();
  vi.restoreAllMocks();
});

it.each([
  { name: "broad", scopes: ["operator.read", "operator.write"] as const },
  { name: "session-only", scopes: ["operator.sessions.write"] as const },
])(
  "rechecks invitation membership in a warm $name sidebar without exposing foreign drafts",
  async ({ scopes }) => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const profileId = ensureProfileForEmail("invited-reader@example.test").id;
      const cfg: OpenClawConfig = {
        agents: { entries: { main: {} } },
        gateway: {
          roles: {
            default: "guest",
            definitions: {
              guest: { agents: "*", scopes: [...scopes], sessions: { others: "invited" } },
            },
          },
        },
      };
      setRuntimeConfigSnapshot(cfg);
      const context = requestContext(cfg);
      const client = identifiedClient(profileId);
      client.connect.scopes = [...scopes];
      for (const [index, name] of ["own", "foreign", "invited", "draft"].entries()) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: `agent:main:${name}` },
          {
            sessionId: name,
            updatedAt: index + 1,
            visibility: name === "own" || name === "draft" ? "draft" : "shared",
            createdActor: {
              type: "human",
              source: "profile",
              id: name === "own" ? profileId : "creator",
            },
          },
        );
        if (name === "invited" || name === "draft") {
          await addSessionMember(
            { agentId: "main", sessionKey: `agent:main:${name}` },
            { identityId: profileId, addedBy: "creator" },
          );
        }
      }
      const list = (ifRowsRevision?: string) =>
        listSessions({
          client,
          context,
          request: { agentId: "main", rowMode: "sidebar", limit: 50, ifRowsRevision },
        });
      await list();
      const initial = await list();
      expect(keys(initial).toSorted()).toEqual(["agent:main:invited", "agent:main:own"]);
      expect(initial.totalCount).toBe(2);
      expect((await list(initial.rowsRevision)).rowsUnchanged).toBe(true);
      await removeSessionMember({ agentId: "main", sessionKey: "agent:main:invited" }, profileId);
      const revoked = await list(initial.rowsRevision);
      expect(revoked.rowsUnchanged).toBeUndefined();
      expect(revoked.rowsRevision).not.toBe(initial.rowsRevision);
      expect(keys(revoked)).toEqual(["agent:main:own"]);
      expect(revoked.totalCount).toBe(1);
      await addSessionMember(
        { agentId: "main", sessionKey: "agent:main:invited" },
        { identityId: profileId, addedBy: "creator" },
      );
      expect(keys(await list(revoked.rowsRevision)).toSorted()).toEqual([
        "agent:main:invited",
        "agent:main:own",
      ]);
    });
  },
);

it("omits unchanged sidebar rows without reusing membership or revoked access", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const request = { agentId: "main", rowMode: "sidebar", limit: 50 } as const;
    const { context, list } = await listFixture(request);
    // Cold admission can publish enriched facts after the first selected page.
    await list();
    const initial = await list();
    expect(initial.sessions.length).toBeGreaterThan(0);
    expect(initial.rowsRevision).toEqual(expect.any(String));
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1_000);
    const conditional = { ifRowsRevision: initial.rowsRevision };
    const unchangedRows = {
      sessions: [],
      rowsUnchanged: true,
      rowsRevision: initial.rowsRevision,
      count: initial.count,
      totalCount: initial.totalCount,
    };
    const unchanged = await list(conditional);
    expect(unchanged).toMatchObject({ ...unchangedRows, ts: initial.ts + 1_000 });
    expect(unchanged.sharedFacts).toBeUndefined();
    for (const unrelated of [
      { agentId: "work", sessionKey: "agent:work:active" },
      { agentId: "main", sessionKey: "agent:main:archived" },
    ]) {
      await patchEntry(unrelated, { label: "Changed outside the held window" });
      expect(await list(conditional)).toMatchObject(unchangedRows);
    }
    const filtered = await list({ ...conditional, search: "no matching session" });
    expect([filtered.rowsUnchanged, filtered.totalCount]).toEqual([undefined, 0]);
    await patchEntry(mainScope, { label: "Renamed sidebar row" });
    const changed = await list(conditional);
    expect(changed.rowsUnchanged).toBeUndefined();
    expect(changed.rowsRevision).not.toBe(initial.rowsRevision);
    expect(mainRow(changed)?.label).toBe("Renamed sidebar row");
    const admitted = { agentId: "main", sessionKey: "agent:main:archived" };
    await patchEntry(admitted, { archivedAt: undefined, updatedAt: Date.now() });
    const membership = await list({ ifRowsRevision: changed.rowsRevision });
    expect(membership.rowsUnchanged).toBeUndefined();
    expect(membership.rowsRevision).not.toBe(changed.rowsRevision);
    expect(keys(membership)).toEqual([
      "agent:main:archived",
      "agent:main:active",
      "agent:main:draft",
    ]);
    await patchEntry(mainScope, { visibility: "draft" });
    const revoked = await listSessions({
      client: identifiedClient("other@example.com"),
      context,
      request: { ...request, ifRowsRevision: membership.rowsRevision },
    });
    expect(revoked.rowsUnchanged).toBeUndefined();
    expect(keys(revoked)).not.toContain(mainKey);
  }));

it("refreshes reply activity including previously rejected candidates", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { list } = await listFixture({ agentId: "main", search: "live", limit: 50 });
    await patchEntry(mainScope, { status: "done" });
    const target = { ...mainScope, sessionId: "main-active" };
    const storeScope = captureRpcTargetForTest(target).storeScope;
    rpcSourceTesting.set(
      "retained-terminal",
      createRpcSourceForTest(
        { projectSessionActive: false },
        { ...target, storeScope, phase: "consumed" },
      ),
    );
    expect((await list()).sessions).toEqual([]);
    const active = await createActiveRpcSourceForTest({}, { ...target, storeScope });
    rpcSourceTesting.set("active-reply", active);
    try {
      expect(mainRow(await list())).toMatchObject({ hasActiveRun: true, status: "running" });
      active.release();
      expect((await list()).sessions).toEqual([]);
    } finally {
      active.release();
    }
  }));

it("presents current runner availability from resident bindings", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const config = await seedSessions();
    let runnerAvailable = true;
    const placement = activePlacement("main-active", { sessionKey: mainKey });
    const context = {
      ...requestContext(config),
      workerSessionPlacementService: {
        getMany: () => new Map([[placement.sessionId, placement]]),
      },
      workerPlacementRunnerAvailabilityReader: {
        version: () => Number(!runnerAvailable),
        read: () => ({
          kind: "device" as const,
          status: runnerAvailable ? ("available" as const) : ("offline" as const),
        }),
      },
    } as GatewayRequestContext;
    const { list } = reader(config, { ...allRows, agentId: "main" }, context);

    for (const available of [true, false]) {
      runnerAvailable = available;
      const result = available ? await stableRows(list) : await list();
      expect(mainRow(result)?.placement).toMatchObject({
        runner: { kind: "device", status: available ? "available" : "offline" },
      });
    }
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
    const { list } = reader(config, allRows, context);
    const first = await stableRows(list);
    expect(mainRow(first)?.thinkingOptions).toEqual(["off", "ultra"]);
    const mainRequest = { agentId: "main" };
    const workRequest = { agentId: "work" };
    const main = await list(mainRequest);
    const work = await list(workRequest);
    expect((await list(mainRequest)).sessions).toEqual(main.sessions);
    expect((await list(workRequest)).sessions).toEqual(work.sessions);
    expect((await list()).sessions).toEqual(first.sessions);
    catalog = [
      {
        ...startupCatalog[0]!,
        reasoning: true,
        compat: { supportedReasoningEfforts: ["low", "high", "max"] },
      },
    ];
    notifyPreparedModelRuntimePublication({ phase: "catalog-published" });
    const refreshed = await list();
    expect(mainRow(refreshed)?.thinkingOptions).toEqual(
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
    const target = { agentId: "main", env: state.env, path: extraDatabasePath };
    const { list } = reader(config, { ...allRows, configuredAgentsOnly: true });
    for (const [index, registered] of [false, true, false].entries()) {
      if (registered) {
        registerOpenClawAgentDatabase(target);
      } else {
        unregisterOpenClawAgentDatabase(target);
      }
      const result = index < 2 ? await stableRows(list) : await list();
      expect(keys(result).includes(extraSessionKey)).toBe(registered);
    }
  }));

it("excludes incognito sessions before and after their memory owner closes", () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { client, list } = await listFixture({ ...allRows, configuredAgentsOnly: true });
    client.connect.scopes = [...(client.connect.scopes ?? []), "operator.admin"];
    const childKey = "agent:guest:subagent:incognito-residency";
    const first = await stableRows(list);
    expect(keys(first)).not.toContain(childKey);

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
      expect(keys(await list())).not.toContain(childKey);
    } finally {
      memorySessionActorOwners.closeDatabase({ agentId: "guest", path: incognitoPath });
    }
    expect(keys(await list())).not.toContain(childKey);
  }));

it("refreshes the resident row after terminal lifecycle persistence", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { list } = await listFixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(60_400);

    const first = await list();
    clock.mockReturnValue(60_401);
    expect(rowFacts((await list()).sessions)).toEqual(rowFacts(first.sessions));

    await persistGatewaySessionLifecycleEvent({
      ...mainScope,
      event: {
        ts: 60_500,
        runId: "run-terminal-resident",
        data: { phase: "end", startedAt: 60_000, endedAt: 60_450 },
      },
    });
    expect(mainRow(await list())).toMatchObject({
      status: "done",
      endedAt: 60_450,
      runtimeMs: 450,
      snapshotAt: 60_401,
    });
  }));

it("refreshes row previews after a committed transcript update", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { context, list } = await listFixture({ ...allRows, includeLastMessage: true });
    const clock = vi.spyOn(Date, "now").mockReturnValue(60_400);

    const initialBackfill = observeSessionRowBackfill([mainKey]);
    const first = await list();
    await initialBackfill;
    clock.mockReturnValue(60_401);

    const committedBackfill = observeSessionRowBackfill(
      [mainKey],
      getSessionRowProjection(context),
    );
    await persistSessionTranscriptTurn(
      { ...mainScope, sessionId: "main-active" },
      {
        messages: [{ message: { role: "assistant", content: "Fresh committed preview" } }],
        touchSessionEntry: false,
      },
    );
    await committedBackfill;
    const refreshed = await list();
    expect(mainRow(first)?.lastMessagePreview).toBeUndefined();
    expect(mainRow(refreshed)?.lastMessagePreview).toBe("Fresh committed preview");
  }));

it("refreshes reconciled previews without repairing legacy titles", () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const config = await seedSessions();
    const sessionId = "main-active";
    await persistSessionTranscriptTurn(
      { ...mainScope, sessionId },
      {
        messages: [
          { message: { role: "user", content: "active prompt" } },
          { message: { role: "assistant", content: "active reply" } },
        ],
        touchSessionEntry: false,
      },
    );
    await waitForSessionTranscriptIndexReconcile({ agentId: "main", env: state.env });
    clearStoredSessionRowTranscriptForTest({ ...mainScope, sessionId });
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    database.db
      .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
      .run(sessionId);
    const storedEntry = loadSessionEntry(mainScope);
    expect(storedEntry?.displayName).toBeUndefined();
    const { list } = reader(config, {
      agentId: "main",
      ...allRows,
      includeDerivedTitles: true,
      includeLastMessage: true,
    });

    const backfilled = observeSessionRowBackfill([mainKey]);
    const degradedRow = mainRow(await list());
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
      expect(mainRow(await list())?.lastMessagePreview).toBe("active reply"),
    );
    const healedRow = mainRow(await stableRows(list));
    expect([healedRow?.derivedTitle, healedRow?.lastMessagePreview]).toEqual([
      undefined,
      "active reply",
    ]);

    expect(loadSessionEntry(mainScope)).toEqual(storedEntry);
  }));

it("admits a newly committed session after the roster was loaded", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { list } = await listFixture();
    expect(keys(await list())).not.toContain("agent:main:external");
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: "agent:main:external" },
      ownedSessionEntry("main-external", 500),
    );
    expect(keys(await list())).toContain("agent:main:external");
  }));

it.each([
  ["off-page child links", false, "zzz-child", "completed-hidden-child", 1_801_400],
  ["parent-filtered children", true, "child", "completed-child", 1_800_401],
] as const)(
  "expires completed children from %s at the retention boundary",
  (_view, parentFiltered, child, id, expiredAt) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { clock, config } = await seedSessionsWithActivityTimes();
      const childSessionKey = `agent:main:${child}`;
      const scope = { agentId: "main", sessionKey: childSessionKey };
      const entry = {
        sessionId: id,
        endedAt: 400,
        parentSessionKey: mainKey,
        spawnedBy: mainKey,
        status: "done" as const,
        updatedAt: 400,
        visibility: "shared" as const,
      };
      if (parentFiltered) {
        replaceSessionEntrySync(scope, mergeSessionEntry(undefined, entry));
      } else {
        await replaceSessionEntry(scope, entry);
      }
      const request: SessionsListParams = parentFiltered
        ? { agentId: "main", limit: 100, spawnedBy: mainKey }
        : { agentId: "main", archived: "all", limit: 1 };
      const { list } = reader(config, request);
      clock.mockReturnValue(1_800_400);
      const retained = await list();
      expect(keys(retained)).toEqual([parentFiltered ? childSessionKey : mainKey]);
      if (!parentFiltered) {
        expect(retained.sessions[0]?.childSessions).toEqual([childSessionKey]);
      }
      clock.mockReturnValue(expiredAt);
      const expired = await list();
      if (parentFiltered) {
        expect(expired.sessions).toEqual([]);
      } else {
        expect(keys(expired)).toEqual([mainKey]);
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
      const { context, list } = reader(config, { ...allRows, agentId: "main", limit: 1 });

      expect((await list()).sessions[0]).toMatchObject({
        key: mainKey,
        hasActiveSubagentRun: true,
        runtimeMs: 1_000,
      });

      const projection = getSessionRowProjection(context)!;
      const select = vi.spyOn(projection, "selectEntries");
      sessionChanges.emit({ ...mainScope, scope: "runtime" });
      clock.mockReturnValue(now + 250);
      expect((await list()).sessions[0]?.runtimeMs).toBe(1_250);
      sessionChanges.emit({ all: true, scope: "agent-runs" });
      clock.mockReturnValue(now + 1_000);
      const fresh = await Promise.all(Array.from({ length: 8 }, () => list()));
      for (const result of fresh) {
        expect(result.sessions).toEqual(fresh[0]?.sessions);
      }
      expect(fresh[0]?.sessions[0]).toMatchObject({
        hasActiveSubagentRun: true,
        runtimeMs: 2_000,
      });
      expect(select).not.toHaveBeenCalled();

      replaceSessionEntrySync(mainScope, {
        ...loadSessionEntry(mainScope)!,
        label: "Updated label",
      });
      expect((await list()).sessions[0]).toMatchObject({
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
    const { list } = reader(config, { ...allRows, activeMinutes: 1, agentId: "main", limit: 1 });
    for (const [now, totalCount] of [
      [60_200, 3],
      [60_201, 2],
    ] as const) {
      clock.mockReturnValue(now);
      const result = await list();
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
          await activateReadSession(
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
      const gate = createDeferredCore();
      const readiness = vi
        .spyOn(projection, "prepareSelection")
        .mockImplementationOnce(async (...args) => {
          await gate.promise;
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
      gate.resolve();

      const repaired = await firstPage;
      expect(keys(repaired)).toEqual(["agent:main:page-second"]);
      expect(repaired).toMatchObject({ count: 1, nextOffset: 1 });
      expect(listEntries).not.toHaveBeenCalled();

      expect(keys(await list({ ...request, offset: 1 }))).toEqual(["agent:main:page-third"]);
    }),
);
