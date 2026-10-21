import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentsListResult,
  SessionsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../../agents/agent-scope-config.js";
import { prepareSharedAuthStoreOwnershipForNative } from "../../agents/auth-profiles/path-resolve.native.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import * as preparedRuntime from "../../agents/prepared-model-runtime.js";
import { notifyPreparedModelRuntimePublication } from "../../agents/prepared-model-runtime.publication-events.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.types.js";
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
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.native.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import {
  isSessionTranscriptIndexReconcileRunning,
  reconcileSessionTranscriptIndexes,
  waitForSessionTranscriptIndexReconcile,
} from "../../config/sessions/session-transcript-reconcile.js";
import { mergeSessionEntry, type SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import type { ProviderThinkingProfile } from "../../plugins/provider-thinking.types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
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
} from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createPreparedGatewayModelCatalog,
  readPreparedGatewayModelCatalogMetadata,
} from "../server-model-catalog-view.js";
import {
  readPreparedGatewayModelCatalog,
  readPreparedGatewayModelCatalogBatch,
} from "../server-model-catalog.js";
import { persistGatewaySessionLifecycleEvent } from "../session-lifecycle-state.js";
import {
  clearStoredSessionRowTranscriptForTest,
  observeSessionRowBackfill,
} from "../session-row-backfill.test-support.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import type { GatewaySessionRow } from "../session-utils.types.js";
import { createRpcSourceForTest } from "../test-helpers.rpc-source.js";
import { agentsHandlers } from "./agents.js";
import {
  captureRpcTargetForTest,
  createActiveRpcSourceForTest,
} from "./rpc-source-fixtures.test-support.js";
import {
  identifiedClient,
  initializeSessionReadContext,
  listSessions as readList,
  requestContext,
  profileSessionEntry,
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
import { sessionRoleConfig } from "./sessions-rewind.handler.test-support.js";
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

describe("serialized resident lists", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    resetAgentEventsForTest();
  });

  afterEach(() => {
    resetAgentEventsForTest();
    vi.restoreAllMocks();
  });

  it("returns current response metadata when unchanged sidebar rows are omitted", () =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { list } = await listFixture({ agentId: "main", rowMode: "sidebar", limit: 50 });
      await list();
      const initial = await list();
      expect(initial.sessions.length).toBeGreaterThan(0);
      expect(initial.rowsRevision).toEqual(expect.any(String));
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1_000);
      const unchanged = await list({ ifRowsRevision: initial.rowsRevision });
      expect(unchanged).toMatchObject({
        sessions: [],
        rowsUnchanged: true,
        rowsRevision: initial.rowsRevision,
        count: initial.count,
        totalCount: initial.totalCount,
        ts: initial.ts + 1_000,
      });
      expect(unchanged.sharedFacts).toBeUndefined();
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
});

afterEach(() => vi.restoreAllMocks());

const viewerConfig = (others: "view" | "none") =>
  sessionRoleConfig("viewer", {
    agents: "*",
    scopes: ["operator.read", "operator.write"],
    sessions: { others },
  });

it.each([
  "membership-unpublished",
  "membership-external",
  "visibility",
  "identity",
  "config",
] as const)(
  "rechecks current %s after the resident projection has completed asynchronous preparation",
  (change) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const viewer = ensureProfileForEmail("page-viewer@example.test").id;
      const owner = ensureProfileForEmail("page-owner@example.test").id;
      const scope = { agentId: "main", sessionKey: "agent:main:selected-page" };
      const membershipChange = change.startsWith("membership");
      const replacementKey = "agent:main:replacement-page";
      const seed = (entry: SessionEntry) => {
        replaceSessionEntrySync({ ...scope, sessionKey: `agent:main:${entry.sessionId}` }, entry);
        return entry;
      };
      const [selectedOwner, otherOwner]: [string, string] =
        change === "identity" ? [viewer, owner] : [owner, viewer];
      const selected = seed({
        ...profileSessionEntry("selected-page", 300, selectedOwner),
        visibility: change === "identity" ? "draft" : membershipChange ? "read-only" : "shared",
      });
      seed(profileSessionEntry("replacement-page", 200, otherOwner));
      seed(profileSessionEntry("tail-page", 100, otherOwner));
      if (membershipChange) {
        addSessionMember(scope, { identityId: viewer, addedBy: owner });
      }
      let config = viewerConfig("view");
      const context = requestContext(config);
      context.getRuntimeConfig = () => config;
      const client = identifiedClient(viewer);
      const request = { agentId: "main", limit: 1, includeActivitySummary: true };
      const before = await readList({ client, context, request });
      expect(before.sessions).toMatchObject([
        { key: scope.sessionKey, sessionId: selected.sessionId },
      ]);
      const projection = expectDefined(getSessionRowProjection(context), "resident projection");
      const ready = projection.prepareSelection.bind(projection);
      vi.spyOn(projection, "prepareSelection").mockImplementationOnce(async (...args) => {
        await ready(...args);
        // Resume the real request only after its current authority has changed.
        if (change === "config") {
          config = viewerConfig("none");
          setRuntimeConfigSnapshot(config);
        } else if (change === "identity") {
          client.authenticatedUserProfile = {
            ...client.authenticatedUserProfile!,
            profileId: owner,
          };
        } else {
          if (change === "membership-external") {
            const external = new DatabaseSync(openOpenClawAgentDatabase(scope).path);
            try {
              external
                .prepare("DELETE FROM session_members WHERE session_key = ? AND identity_id = ?")
                .run(scope.sessionKey, viewer);
            } finally {
              external.close();
            }
            // External writers publish committed changes through their owning bridge.
            sessionChanges.emit({ ...scope, factsInvalidated: true });
          } else if (membershipChange) {
            expect(removeSessionMember(scope, viewer)).not.toBeNull();
          } else {
            replaceSessionEntrySync(scope, {
              ...selected,
              visibility: "draft",
            });
          }
          if (change === "visibility") {
            emitSessionsChanged(context, { reason: "sharing", sessionKey: scope.sessionKey });
          }
        }
      });

      const result = await readList({ client, context, request });
      if (membershipChange) {
        expect(result.sessions).toMatchObject([
          { key: scope.sessionKey, sharingRole: "viewer", activitySummary: { canEnsure: false } },
        ]);
      } else {
        expect(result.sessions.map((session) => session.key)).toEqual([replacementKey]);
        expect(result).toMatchObject({ count: 1, nextOffset: 1 });
      }
    }),
);

async function seedCatalogSessions(): Promise<OpenClawConfig> {
  const config: OpenClawConfig = {
    agents: { entries: { main: {}, work: {} } },
  };
  setRuntimeConfigSnapshot(config);
  for (const [agentId, updatedAt, id] of [
    ["main", 400, "owner@example.com"],
    ["work", 100, "viewer@example.com"],
  ] as const) {
    await upsertSessionEntryCore(
      { agentId, sessionKey: `agent:${agentId}:active` },
      ownedSessionEntry(`${agentId}-active`, updatedAt, id),
    );
  }
  return config;
}

function reasonerCatalog(efforts = ["low", "high", "max"]): ModelCatalogEntry[] {
  return [
    {
      provider: "dynamic-router",
      id: "reasoner",
      name: "Reasoner",
      reasoning: true,
      compat: { supportedReasoningEfforts: efforts },
    },
  ];
}

function expectThinking(
  result: Awaited<ReturnType<typeof readList>>,
  agentId: string,
  levels: string[],
) {
  expect(result.sessions.find((row) => row.agentId === agentId)?.thinkingOptions).toEqual(levels);
}

function thinkingRegistry(
  providerId: string,
  resolveThinkingProfile: NonNullable<
    PluginRegistry["providers"][number]["provider"]["resolveThinkingProfile"]
  >,
): PluginRegistry {
  const registry = createEmptyPluginRegistry();
  registry.providers.push({
    pluginId: providerId,
    source: "test",
    provider: { id: providerId, label: providerId, auth: [], resolveThinkingProfile },
  });
  return registry;
}

function preparedOwner(
  config: OpenClawConfig,
  agentId: string,
  entries: ModelCatalogEntry[],
  pluginRegistry: PluginRegistry,
  readFullModelCatalog?: () => ModelCatalogSnapshot | undefined,
): PreparedModelRuntimeSnapshot {
  const workspaceDir = resolveAgentWorkspaceDir(config, agentId);
  return {
    catalogOwner: { agentId, workspaceDir },
    agentId,
    agentDir: resolveAgentDir(config, agentId),
    workspaceDir,
    config,
    observationConfig: config,
    isCurrent: () => true,
    activeProjectKeys: [],
    authModes: {},
    metadataSnapshot: createPluginMetadataSnapshotFixture(),
    pluginRegistry,
    allowGatewaySubagentBinding: false,
    modelCatalog: { entries, routeVariants: [] },
    readFullModelCatalog,
    loadFullModelCatalog: vi.fn(() => {
      throw new Error("session listing must not start full catalog discovery");
    }),
    configuredRuntimeModels: [],
    findConfiguredRuntimeModel: () => undefined,
    inlineProviderModels: [],
    createStores: () => {
      throw new Error("session listing must not create execution stores");
    },
  };
}

function publishedCatalogContext(
  config: OpenClawConfig,
  owners: ReadonlyMap<string, PreparedModelRuntimeSnapshot>,
): GatewayRequestContext {
  prepareSharedAuthStoreOwnershipForNative();
  vi.spyOn(preparedRuntime, "getPreparedModelRuntimeSnapshot").mockImplementation((input) => {
    const owner = input.agentId ? owners.get(input.agentId) : undefined;
    return owner?.agentDir === input.agentDir ? owner : undefined;
  });
  const context: GatewayRequestContext = {
    ...requestContext(config),
    readPreparedGatewayModelCatalog: (options) =>
      readPreparedGatewayModelCatalog({ ...options, getConfig: () => context.getRuntimeConfig() }),
    readPreparedGatewayModelCatalogBatch: (agentIds) =>
      readPreparedGatewayModelCatalogBatch(agentIds, {
        getConfig: () => context.getRuntimeConfig(),
      }),
  };
  return context;
}

describe("prepared catalog owners", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    resetAgentEventsForTest();
  });

  afterEach(() => {
    resetAgentEventsForTest();
    resetPluginRuntimeStateForTest();
    vi.restoreAllMocks();
  });

  it("refreshes runtime metadata when the prepared metadata owner changes", () =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedCatalogSessions();
      config.agents = { ...config.agents, defaults: { model: "fixture-runtime/model" } };
      const entries: ModelCatalogEntry[] = [
        { provider: "fixture-runtime", id: "model", name: "Model" },
      ];
      const initialMetadataSnapshot = createPluginMetadataSnapshotFixture();
      let metadataSnapshot = initialMetadataSnapshot;
      let lastCatalog: ReturnType<typeof createPreparedGatewayModelCatalog> | undefined;
      const context = {
        ...requestContext(config),
        readPreparedGatewayModelCatalog: vi.fn(async () => {
          lastCatalog = createPreparedGatewayModelCatalog({ entries, metadataSnapshot });
          return lastCatalog;
        }),
      };
      const { list } = sessionReader(config, "owner@example.com", context);
      const request = { agentId: "main", archived: "all" as const, limit: 100 };
      const first = await list(request);
      const firstCatalog = lastCatalog;
      expect(first.sessions[0]?.agentRuntime?.id).not.toBe("fixture-runtime");
      context.readPreparedGatewayModelCatalog.mockClear();
      expect((await list(request)).sessions).toEqual(first.sessions);
      expect(context.readPreparedGatewayModelCatalog).not.toHaveBeenCalled();

      metadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: [{ id: "fixture-owner", cliBackends: ["fixture-runtime"] }],
      });
      notifyPreparedModelRuntimePublication({ phase: "published" });
      const updated = await list(request);
      expect(updated.sessions[0]?.agentRuntime?.id).toBe("fixture-runtime");
      expect(context.readPreparedGatewayModelCatalog).toHaveBeenCalled();
      expect(readPreparedGatewayModelCatalogMetadata(firstCatalog)).toBe(initialMetadataSnapshot);
      expect(readPreparedGatewayModelCatalogMetadata(lastCatalog)).toBe(metadataSnapshot);
    }));

  it("keeps identical catalogs owner-scoped across registry replacement and full catalog completion", () =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedCatalogSessions();
      config.agents!.defaults = {
        model: { primary: "dynamic-router/reasoner" },
        models: { "dynamic-router/reasoner": { agentRuntime: { id: "codex" } } },
      };
      const entries = reasonerCatalog();
      const profile = (level: "low" | "ultra"): ProviderThinkingProfile => ({
        levels: [{ id: "off" }, { id: level }],
        defaultLevel: level,
      });
      const mainRegistry = thinkingRegistry("dynamic-router", () => profile("ultra"));
      const workRegistry = thinkingRegistry("dynamic-router", () => profile("low"));
      const completed: { catalog?: ModelCatalogSnapshot } = {};
      let failMainCatalogRead = false;
      const mainOwner = preparedOwner(config, "main", entries, mainRegistry, () => {
        if (failMainCatalogRead) {
          throw new Error("main catalog owner replaced");
        }
        return completed.catalog;
      });
      const owners = new Map([
        ["main", mainOwner],
        ["work", preparedOwner(config, "work", entries, workRegistry)],
      ]);
      // Prepared owners, not the empty startup registry, supply both agents' policies.
      setActivePluginRegistry(createEmptyPluginRegistry());
      const context = publishedCatalogContext(config, owners);
      let currentConfig = config;
      context.getRuntimeConfig = () => currentConfig;
      const request = {
        client: identifiedClient("owner@example.com"),
        context,
        request: { archived: "all" as const },
      };
      const first = await readList(request);
      expectThinking(first, "main", ["off", "ultra"]);
      expectThinking(first, "work", ["off", "low", "ultra"]);
      expect(first.defaults.thinkingOptions).toContain("ultra");
      expect(JSON.stringify(first)).not.toContain('"metadataSnapshot":');
      const catalogs = vi.spyOn(context, "readPreparedGatewayModelCatalogBatch");
      expect((await readList(request)).sessions).toEqual(first.sessions);
      const scoped = await readList({
        ...request,
        request: { ...request.request, agentId: "main" },
      });
      expect(scoped.sessions.map((row) => row.agentId)).toEqual(["main"]);
      expectThinking(scoped, "main", ["off", "ultra"]);
      expect(catalogs).not.toHaveBeenCalled();
      const rosterResponse = vi.fn();
      await agentsHandlers["agents.list"]?.({
        params: {},
        client: request.client,
        context,
        respond: rosterResponse,
      } as never);
      expect(rosterResponse.mock.calls[0]?.[0]).toBe(true);
      const roster = rosterResponse.mock.calls[0]?.[1] as AgentsListResult;
      expect(roster.agents.find((row) => row.id === "main")?.thinkingOptions).toEqual([
        "off",
        "ultra",
      ]);
      expect(roster.agents.find((row) => row.id === "work")?.thinkingOptions).toEqual([
        "off",
        "low",
        "ultra",
      ]);

      // An empty replacement restores the generic native ladder without disabling harness Ultra.
      owners.set("main", { ...mainOwner, pluginRegistry: createEmptyPluginRegistry() });
      notifyPreparedModelRuntimePublication({ phase: "published" });
      const replaced = await readList(request);
      expectThinking(replaced, "main", ["off", "minimal", "low", "medium", "high", "max", "ultra"]);
      expectThinking(replaced, "work", ["off", "low", "ultra"]);

      failMainCatalogRead = true;
      notifyPreparedModelRuntimePublication({
        phase: "catalog-failed",
      });
      const partial = await readList(request);
      expectThinking(partial, "work", ["off", "low", "ultra"]);
      failMainCatalogRead = false;

      completed.catalog = { entries: [{ ...entries[0]!, reasoning: false }], routeVariants: [] };
      notifyPreparedModelRuntimePublication({ phase: "catalog-published" });
      const promoted = await readList(request);
      expectThinking(promoted, "main", ["off"]);
      expect(mainOwner.loadFullModelCatalog).not.toHaveBeenCalled();

      const workAgentDir = `${resolveAgentDir(config, "work")}-replacement`;
      config.agents!.entries = {
        main: {},
        work: { agentDir: workAgentDir },
      };
      owners.set("work", preparedOwner(config, "work", entries, mainRegistry));
      setRuntimeConfigSnapshot(config);
      const changedRoster = await readList(request);
      expectThinking(changedRoster, "work", ["off", "ultra"]);

      const nextConfig: OpenClawConfig = {
        ...config,
        agents: {
          ...config.agents,
          entries: {
            main: {},
            work: { agentDir: `${workAgentDir}-next` },
          },
        },
      };
      currentConfig = nextConfig;
      owners.set("work", preparedOwner(nextConfig, "work", entries, workRegistry));
      setRuntimeConfigSnapshot(nextConfig);
      const changedConfig = await readList(request);
      expectThinking(changedConfig, "work", ["off", "low", "ultra"]);
    }));
});
