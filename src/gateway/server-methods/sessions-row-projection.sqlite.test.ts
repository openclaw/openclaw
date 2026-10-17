import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import * as historyWorker from "../../config/sessions/session-transcript-worker-runtime.js";
import * as sqlite from "../../infra/kysely-sync.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { observeMainThreadReads } from "../../test-utils/main-thread-sql-spies.test-support.js";
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

const key = "agent:main:active";
const request = { archived: "all" as const, limit: 100 };
async function residentRows(
  email = "owner@example.com",
  initialRequest: Parameters<typeof listSessions>[0]["request"] = request,
) {
  const context = requestContext(await seedSessions());
  const client = identifiedClient(email);
  await listSessions({ context, client, request: initialRequest });
  return { context, client, projection: getSessionRowProjection(context)! };
}

function invoke(
  method: "list" | "describe",
  context: ReturnType<typeof requestContext>,
  client: ReturnType<typeof identifiedClient>,
  params: Record<string, unknown>,
  respond = vi.fn(),
) {
  const handler =
    method === "list"
      ? sessionReadHandlers["sessions.list"]!
      : sessionByKeyReadHandlers["sessions.describe"]!;
  const pending = handler({
    req: { type: "req", id: "resident-row", method: `sessions.${method}` },
    params,
    context,
    client,
    respond,
    isWebchatConnect: () => false,
  });
  return { pending, respond };
}

function expectSession(respond: ReturnType<typeof vi.fn>, fields: Record<string, unknown>) {
  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ session: expect.objectContaining(fields) }),
  );
}

describe("resident session rows", () => {
  it.each([
    { method: "list", transition: "a commit arrives as readiness resolves" },
    { method: "describe", transition: "its row is dirtied before the request" },
  ] as const)("keeps sessions.$method current when $transition", async ({ method }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { context, client, projection } = await residentRows("owner@example.com", {
        archived: "all",
      });
      const entry = projection.describe({ agentId: "main", key })!.entry;
      const respond = vi.fn();
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
      const { pending } = invoke(
        method,
        context,
        client,
        method === "list" ? { archived: "all" } : { key },
        respond,
      );
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
      const { context, client, projection } = await residentRows("viewer@example.com", {});
      const respond = vi.fn();
      const list = sessionUtils.listProjectedSessions;
      vi.spyOn(sessionUtils, "listProjectedSessions").mockImplementationOnce(async (params) => {
        const result = await list(params);
        expect(respond).toHaveBeenCalledWith(true, result);
        // The reply must precede a later microtask's access revocation.
        const row = projection.describe({ key, agentId: "main" })!;
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: row.key },
          { ...row.entry, visibility: "draft" },
        );
        return result;
      });
      await invoke("list", context, client, {}, respond).pending;
      expect(respond).toHaveBeenCalledTimes(1);
    });
  });

  it("lists for different viewers, filters a person and describes without SQLite after initialization", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { context, client, projection } = await residentRows();
      const viewer = identifiedClient("viewer@example.com");
      expect(projection.dirtyRowCount).toBe(0);

      // Native calls also cover prepared compiled queries and direct PRAGMA probes.
      const sqlCalls = [
        vi.spyOn(sqlite, "executeSqliteQuerySync"),
        vi.spyOn(sqlite, "executeSqliteQueryTakeFirstSync"),
        vi.spyOn(sqlite, "iterateSqliteQuerySync"),
        vi.spyOn(DatabaseSync.prototype, "prepare"),
      ];
      const reads = observeMainThreadReads();
      const person = await listSessions({
        context,
        client,
        request: { archived: "all", involvingProfileId: "deadbeef" },
      });
      expect(person.sessions).toEqual([]);
      const listed = await listSessions({ context, client: viewer, request });
      const { pending, respond } = invoke("describe", context, client, { key });
      await pending;

      expect(listed.sessions.map((row) => row.key)).toContain("agent:main:active");
      expect(listed.sessions.map((row) => row.key)).not.toContain("agent:main:draft");
      expectSession(respond, { sessionId: "main-active" });
      expect([...sqlCalls.map((spy) => spy.mock.calls.length), reads.count()]).toEqual([
        0, 0, 0, 0, 0,
      ]);
    });
  });

  it("refreshes only the invalidated identity through bounded keyed readers, then reuses it without SQL", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { context, client, projection } = await residentRows();
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
        const { pending, respond } = invoke("describe", context, client, { key });
        await pending;
        expectSession(respond, { label: "Committed label" });
        expect(workerKeys).not.toHaveBeenCalled();
        expect(hostSql.calls.flatMap((call) => call.mock.calls)).toEqual([]);
      } finally {
        hostSql.restore();
      }
    });
  });
});
