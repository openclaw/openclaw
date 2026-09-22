import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import * as sqlite from "../../infra/kysely-sync.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import * as sessionUtils from "../session-utils.js";
import { sessionByKeyReadHandlers } from "./sessions-read-by-key.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
  seedSessions,
  sessionReadHandlers,
} from "./sessions-read-cache.test-support.js";

afterEach(() => vi.restoreAllMocks());

describe("resident session rows", () => {
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

  it("resolves a person reference without SQLite when every row is clean", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const context = requestContext(await seedSessions());
      const client = identifiedClient("owner@example.com");
      await listSessions({ context, client, request: { archived: "all" } });
      expect(getSessionRowProjection(context)!.dirtyRowCount).toBe(0);
      const prepares = vi.spyOn(DatabaseSync.prototype, "prepare");
      const reads = (["all", "get", "iterate"] as const).map((method) =>
        vi.spyOn(StatementSync.prototype, method),
      );
      const result = await listSessions({
        context,
        client,
        request: { archived: "all", involvingProfileId: "deadbeef" },
      });
      expect(result.sessions).toEqual([]);
      expect({
        prepares: prepares.mock.calls.length,
        reads: reads.reduce((count, read) => count + read.mock.calls.length, 0),
      }).toEqual({ prepares: 0, reads: 0 });
    });
  });

  it("lists for different viewers and describes without SQLite after initialization", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = await seedSessions();
      const context = requestContext(cfg);
      const client = identifiedClient("owner@example.com");
      const viewer = identifiedClient("viewer@example.com");
      const request = { archived: "all" as const, limit: 100 };
      await listSessions({ context, client, request });

      const queries = vi.spyOn(sqlite, "executeSqliteQuerySync");
      const firstRows = vi.spyOn(sqlite, "executeSqliteQueryTakeFirstSync");
      const iterators = vi.spyOn(sqlite, "iterateSqliteQuerySync");
      // Native calls also cover prepared compiled queries and direct PRAGMA probes.
      const prepares = vi.spyOn(DatabaseSync.prototype, "prepare");
      const nativeReads = ["all", "get", "iterate"] as const;
      const reads = nativeReads.map((method) => vi.spyOn(StatementSync.prototype, method));
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
        nativeReads: reads.reduce((total, spy) => total + spy.mock.calls.length, 0),
      }).toEqual({ queries: 0, firstRows: 0, iterators: 0, prepares: 0, nativeReads: 0 });
    });
  });

  it("refreshes only the dirty identity through bounded keyed readers, then reuses it without SQL", async () => {
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
      expect(projection.dirtyRowCount).toBeGreaterThan(0);
      const queries = vi.spyOn(sqlite, "executeSqliteQuerySync");
      const firstRows = vi.spyOn(sqlite, "executeSqliteQueryTakeFirstSync");
      const iterators = vi.spyOn(sqlite, "iterateSqliteQuerySync");
      const native = (["all", "get", "iterate"] as const).map((method) =>
        vi.spyOn(StatementSync.prototype, method),
      );
      const listed = await listSessions({ context, client, request });
      expect(listed.sessions.find((row) => row.key === key)?.label).toBe("Committed label");
      expect(projection.materializedCount - before).toBe(1);
      expect(projection.describe({ agentId: "work", key: "agent:work:active" })?.materialized).toBe(
        untouched.materialized,
      );
      const compiled = [
        ...queries.mock.calls,
        ...firstRows.mock.calls,
        ...iterators.mock.calls,
      ].map(([, query]) => query.compile());
      expect(compiled.length).toBeGreaterThan(0);
      for (const query of compiled) {
        expect(query.sql).not.toMatch(/from ["`]?agent_databases/i);
        if (/from ["`]?session_(nodes|members|windows|active_path)/i.test(query.sql)) {
          expect(query.sql).toMatch(/\bwhere\b/i);
          expect(
            query.parameters.some((value) => value === key || value === current.entry.sessionId),
          ).toBe(true);
        }
        expect(query.parameters).not.toContain("agent:work:active");
      }
      for (const spy of [queries, firstRows, iterators, ...native]) {
        spy.mockClear();
      }
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
        expect.objectContaining({ session: expect.objectContaining({ label: "Committed label" }) }),
      );
      for (const spy of [queries, firstRows, iterators, ...native]) {
        expect(spy).not.toHaveBeenCalled();
      }
    });
  });
});
