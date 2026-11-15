import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import * as historyWorker from "../../config/sessions/session-transcript-worker-runtime.js";
import * as sqlite from "../../infra/kysely-sync.js";
import * as nativeWorker from "../../infra/sqlite-worker-store.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import * as admission from "../../state/agent-database-admission.js";
import {
  closeOpenClawAgentDatabasesAsync,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import * as execution from "../../state/openclaw-agent-execution.js";
import { observeMainThreadReads } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { STARTUP_UNAVAILABLE_GATEWAY_METHODS } from "../methods/core-method-policy.js";
import { dispatchAuthorizationRequest } from "../server-methods.authorization.test-support.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import * as sessionUtils from "../session-utils.js";
import { sessionByKeyReadHandlers } from "./sessions-read-by-key.js";
import {
  identifiedClient,
  initializeSessionReadContext,
  listSessions,
  profileSessionEntry,
  requestContext,
  seedSessions,
  sessionReadHandlers,
} from "./sessions-read-cache.test-support.js";

afterEach(() => vi.restoreAllMocks());

describe("resident session rows", () => {
  it.each(["sessions.list", "sessions.subscribe"])(
    "serves prepared rows through %s while startup recovery is pending",
    async (method) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const context = requestContext(await seedSessions());
        const client = identifiedClient("owner@example.com");
        client.connId = "startup-reader";
        context.subscribeSessionEvents = vi.fn();
        context.unavailableGatewayMethods = new Set(STARTUP_UNAVAILABLE_GATEWAY_METHODS);
        await listSessions({ context, client, request: {} });
        const respond = await dispatchAuthorizationRequest(
          method,
          { limit: 100 },
          { context, client },
        );
        const [ok, payload] = respond.mock.calls[0] ?? [];
        expect(ok).toBe(true);
        expect(method === "sessions.subscribe" ? payload.list : payload).toMatchObject({
          sessions: expect.arrayContaining([expect.objectContaining({ key: "agent:main:active" })]),
        });
        if (method === "sessions.subscribe") {
          expect(context.subscribeSessionEvents).toHaveBeenCalledWith("startup-reader");
        }
      });
    },
  );
  it("lists ready sessions while a registered agent's native preparation is pending", async ({
    signal,
  }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const context = requestContext(await seedSessions());
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: "agent:main:child" },
        {
          ...profileSessionEntry("healthy-child", 500, "owner@example.com"),
          parentSessionKey: "agent:work:active",
          spawnedBy: "agent:work:active",
        },
      );
      const client = identifiedClient("owner@example.com");
      context.unavailableGatewayMethods = new Set(STARTUP_UNAVAILABLE_GATEWAY_METHODS);
      await closeOpenClawAgentDatabasesAsync(state.stateDir);
      const scope = { agentId: "work", env: state.env };
      const path = resolveOpenClawAgentSqlitePath(scope);
      const refusal = admission.createAgentDatabaseInspectionRefusal({
        agentId: scope.agentId,
        paths: [path],
        reason: "Startup inspection is still running",
        pending: true,
      });
      admission.recordAgentDatabaseAdmissions([refusal], { ...state, source: "startup" });
      const entered = createDeferred();
      const release = createDeferred();
      const open = nativeWorker.openAgentDatabaseSqliteWorkerStore;
      const gate = vi
        .spyOn(nativeWorker, "openAgentDatabaseSqliteWorkerStore")
        .mockImplementationOnce(async (...args) => {
          entered.resolve();
          await release.promise;
          return open(...args);
        });
      const opening = admission.preparePendingAgentDatabase(
        refusal,
        { env: state.env, assertCurrent() {} },
        () => execution.prepareOpenClawAgentDatabaseExecution({ ...scope, path }, () => {}),
      );
      let initialize: Promise<void> | undefined;
      try {
        await withinTest(entered.promise, signal);
        initialize = initializeSessionReadContext(context);
        await withinTest(initialize, signal);
        const respond = await dispatchAuthorizationRequest(
          "sessions.list",
          {},
          { context, client },
        );
        expect(respond.mock.calls[0]).toMatchObject([
          true,
          {
            sessions: expect.arrayContaining([
              expect.objectContaining({ key: "agent:main:active" }),
              expect.objectContaining({ key: "agent:main:child" }),
            ]),
          },
        ]);
        expect(respond.mock.calls[0]?.[1].sessions).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ key: "agent:work:active" })]),
        );
        const pending = await dispatchAuthorizationRequest(
          "sessions.list",
          { agentId: "work" },
          { context, client },
        );
        expect(pending.mock.calls[0]).toMatchObject([
          false,
          undefined,
          {
            code: "UNAVAILABLE",
            retryable: true,
            details: { code: "agent-database-inspection-pending" },
          },
        ]);
      } finally {
        release.resolve();
        gate.mockRestore();
        await opening;
        await initialize;
      }
      const recovered = await listSessions({ context, client, request: {} });
      expect(recovered.sessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "agent:main:active" }),
          expect.objectContaining({ key: "agent:work:active" }),
        ]),
      );
    });
  });
  it.each([
    { method: "list", transition: "a commit arrives as readiness resolves" },
    { method: "describe", transition: "its row is dirtied before the request" },
  ] as const)("keeps sessions.$method current when $transition", async ({ method }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const context = requestContext(await seedSessions());
      const client = identifiedClient("owner@example.com");
      await listSessions({ context, client, request: { archived: "all" } });
      const projection = getSessionRowProjection(context)!;
      const key = "agent:main:active";
      const entry = projection.describe({ agentId: "main", key })!.entry;
      const respond = vi.fn();
      const handler =
        method === "list"
          ? sessionReadHandlers["sessions.list"]!
          : sessionByKeyReadHandlers["sessions.describe"]!;
      const commit = () =>
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: key },
          { ...entry, label: "Current" },
        );
      if (method === "describe") {
        commit();
        const prepare = projection.withPreparedExactRows.bind(projection);
        vi.spyOn(projection, "withPreparedExactRows").mockImplementationOnce(
          (queries, consume, options) =>
            prepare(
              queries,
              (read) => {
                const result = consume(read);
                expect(respond).toHaveBeenCalledTimes(1);
                return result;
              },
              options,
            ),
        );
      }
      const pending = handler({
        req: { type: "req", id: "commit-during-readiness", method: `sessions.${method}` },
        params: method === "list" ? { archived: "all" } : { key },
        context,
        client,
        isWebchatConnect: () => false,
        respond,
      });
      if (method === "list") {
        commit();
      }
      await expect(Promise.resolve(pending)).resolves.toBeUndefined();
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      expect(respond.mock.calls[0]?.[1]).toMatchObject(
        method === "list"
          ? {
              sessions: expect.arrayContaining([
                expect.objectContaining({ key, label: "Current" }),
              ]),
            }
          : { session: expect.objectContaining({ key, label: "Current" }) },
      );
    });
  });

  it("replies in the final authorized presentation before yielding its result promise", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const context = requestContext(await seedSessions());
      const client = identifiedClient("viewer@example.com");
      await listSessions({ context, client, request: {} });
      const respond = vi.fn();
      const list = sessionUtils.listProjectedSessions;
      vi.spyOn(sessionUtils, "listProjectedSessions").mockImplementationOnce(async (params) => {
        const result = await list(params);
        expect(respond).toHaveBeenCalledWith(true, result);
        // The reply must precede a later microtask's access revocation.
        const row = getSessionRowProjection(context)!.describe({
          key: "agent:main:active",
          agentId: "main",
        })!;
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: row.key },
          { ...row.entry, visibility: "draft" },
        );
        return result;
      });
      await sessionReadHandlers["sessions.list"]!({
        req: { type: "req", id: "synchronous-list-reply", method: "sessions.list" },
        params: {},
        context,
        client,
        isWebchatConnect: () => false,
        respond,
      });
      expect(respond).toHaveBeenCalledTimes(1);
    });
  });

  it("lists for different viewers, filters a person and describes without SQLite after initialization", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = await seedSessions();
      const context = requestContext(cfg);
      const client = identifiedClient("owner@example.com");
      const viewer = identifiedClient("viewer@example.com");
      const request = { archived: "all" as const, limit: 100 };
      await listSessions({ context, client, request });
      expect(getSessionRowProjection(context)!.dirtyRowCount).toBe(0);

      const queries = vi.spyOn(sqlite, "executeSqliteQuerySync");
      const firstRows = vi.spyOn(sqlite, "executeSqliteQueryTakeFirstSync");
      const iterators = vi.spyOn(sqlite, "iterateSqliteQuerySync");
      // Native calls also cover prepared compiled queries and direct PRAGMA probes.
      const prepares = vi.spyOn(DatabaseSync.prototype, "prepare");
      const reads = observeMainThreadReads();
      const person = await listSessions({
        context,
        client,
        request: { archived: "all", involvingProfileId: "deadbeef" },
      });
      expect(person.sessions).toEqual([]);
      const listed = await listSessions({
        context,
        client: viewer,
        request,
      });
      const respond = vi.fn();
      await sessionByKeyReadHandlers["sessions.describe"]!({
        req: { type: "req", id: "resident-describe", method: "sessions.describe" },
        params: { key: "agent:main:active" },
        context,
        client,
        isWebchatConnect: () => false,
        respond,
      });

      expect(listed.sessions.map((row) => row.key)).toContain("agent:main:active");
      expect(listed.sessions.map((row) => row.key)).not.toContain("agent:main:draft");
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ session: expect.objectContaining({ sessionId: "main-active" }) }),
      );
      expect({
        queries: queries.mock.calls.length,
        firstRows: firstRows.mock.calls.length,
        iterators: iterators.mock.calls.length,
        prepares: prepares.mock.calls.length,
        nativeReads: reads.count(),
      }).toEqual({ queries: 0, firstRows: 0, iterators: 0, prepares: 0, nativeReads: 0 });
    });
  });

  it("refreshes only the invalidated identity through bounded keyed readers, then reuses it without SQL", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = await seedSessions();
      const context = requestContext(cfg);
      const client = identifiedClient("owner@example.com");
      const request = { archived: "all" as const, limit: 100 };
      await listSessions({ context, client, request });
      const projection = getSessionRowProjection(context)!;
      const key = "agent:main:active";
      const current = projection.describe({ agentId: "main", key })!;
      const untouched = projection.describe({ agentId: "work", key: "agent:work:active" })!;
      const before = projection.materializedCount;
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: key },
        { ...current.entry, label: "Committed label" },
      );
      // Complete commit receipts reuse their facts; missing facts require the keyed fallback.
      sessionChanges.invalidate({
        agentId: "main",
        sessionKey: key,
        scope: "session-entry",
        factsInvalidated: true,
      });
      expect(projection.dirtyRowCount).toBeGreaterThan(0);
      const workerKeys = vi.fn<(keys: readonly string[]) => void>();
      const readDatabases = historyWorker.withSessionHistoryWorkerDatabases;
      vi.spyOn(historyWorker, "withSessionHistoryWorkerDatabases").mockImplementation(
        (databases, consume) =>
          readDatabases(databases, (owners) =>
            consume(
              owners.map((owner) => ({
                ...owner,
                readRowFacts: (input: Parameters<typeof owner.readRowFacts>[0]) => {
                  workerKeys(input.sessionKeys);
                  return owner.readRowFacts(input);
                },
              })),
            ),
          ),
      );
      const hostSql = observeHostDataSql();
      try {
        sessionChanges.emit({
          agentId: "main",
          sessionKey: key,
          storePath: current.storeTarget.storePath,
          factsInvalidated: true,
        });
        const listed = await listSessions({ context, client, request });
        expect(listed.sessions.find((row) => row.key === key)?.label).toBe("Committed label");
        expect(projection.materializedCount - before).toBe(1);
        expect(
          projection.describe({ agentId: "work", key: "agent:work:active" })?.materialized,
        ).toBe(untouched.materialized);
        expect(workerKeys).toHaveBeenCalled();
        for (const [keys] of workerKeys.mock.calls) {
          expect(keys).toEqual([key]);
        }
        expect(hostSql.calls.flatMap((call) => call.mock.calls)).toEqual([]);
        workerKeys.mockClear();
        await listSessions({ context, client, request });
        const respond = vi.fn();
        await sessionByKeyReadHandlers["sessions.describe"]!({
          req: { type: "req", id: "dirty-described", method: "sessions.describe" },
          params: { key },
          context,
          client,
          isWebchatConnect: () => false,
          respond,
        });
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            session: expect.objectContaining({ label: "Committed label" }),
          }),
        );
        expect(workerKeys).not.toHaveBeenCalled();
        expect(hostSql.calls.flatMap((call) => call.mock.calls)).toEqual([]);
      } finally {
        hostSql.restore();
      }
    });
  });
});
