import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import * as historyWorker from "../../config/sessions/session-transcript-worker-runtime.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
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
  const list = (params: Parameters<typeof listSessions>[0]["request"] = request, reader = client) =>
    listSessions({ context, client: reader, request: params });
  await listSessions({ context, client, request: initialRequest });
  const projection = getSessionRowProjection(context)!;
  const update = (patch: Partial<SessionEntry>) =>
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key },
      { ...projection.describe({ agentId: "main", key })!.entry, ...patch },
    );
  const respond = vi.fn();
  const invoke = (method: "list" | "describe") => {
    const handler =
      method === "list"
        ? sessionReadHandlers["sessions.list"]!
        : sessionByKeyReadHandlers["sessions.describe"]!;
    return handler({
      req: { type: "req", id: "resident-row", method: `sessions.${method}` },
      params: method === "list" ? initialRequest : { key },
      context,
      client,
      respond,
      isWebchatConnect: () => false,
    });
  };
  return { list, update, respond, invoke, projection };
}

function expectSession(respond: ReturnType<typeof vi.fn>, fields: Record<string, unknown>) {
  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ session: expect.objectContaining(fields) }),
  );
}

function withRows(...options: Parameters<typeof residentRows>) {
  return (run: (rows: Awaited<ReturnType<typeof residentRows>>) => Promise<void>) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => run(await residentRows(...options)));
}

describe("resident session rows", () => {
  it.each(["list", "describe"] as const)("keeps %s current at readiness", async (method) => {
    await withRows("owner@example.com", { archived: "all" })(
      async ({ update, invoke, projection, respond }) => {
        const commit = () => update({ label: "Current" });
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
        const pending = invoke(method);
        if (method === "list") {
          commit();
        }
        await expect(Promise.resolve(pending)).resolves.toBeUndefined();
        expect(respond.mock.calls[0]?.[0]).toBe(true);
        const result = respond.mock.calls[0]?.[1];
        const rows = method === "list" ? result.sessions : [result.session];
        expect(rows).toEqual(
          expect.arrayContaining([expect.objectContaining({ key, label: "Current" })]),
        );
      },
    );
  });

  it("replies in the final authorized presentation before yielding its result promise", async () => {
    await withRows(
      "viewer@example.com",
      {},
    )(async ({ update, invoke, respond }) => {
      const list = sessionUtils.listProjectedSessions;
      vi.spyOn(sessionUtils, "listProjectedSessions").mockImplementationOnce(async (params) => {
        const result = await list(params);
        expect(respond).toHaveBeenCalledWith(true, result);
        // The reply must precede a later microtask's access revocation.
        update({ visibility: "draft" });
        return result;
      });
      await invoke("list");
      expect(respond).toHaveBeenCalledTimes(1);
    });
  });

  it("lists for different viewers, filters a person and describes without SQLite after initialization", async () => {
    await withRows()(async ({ list, invoke, projection, respond }) => {
      const viewer = identifiedClient("viewer@example.com");
      expect(projection.dirtyRowCount).toBe(0);
      const sql = observeMainThreadSql();
      const person = await list({ archived: "all", involvingProfileId: "deadbeef" });
      expect(person.sessions).toEqual([]);
      const listed = await list(request, viewer);
      await invoke("describe");

      expect(listed.sessions.map((row) => row.key)).toContain("agent:main:active");
      expect(listed.sessions.map((row) => row.key)).not.toContain("agent:main:draft");
      expectSession(respond, { sessionId: "main-active" });
      sql.expectIdle();
    });
  });

  it("refreshes only the invalidated identity through bounded keyed readers, then reuses it without SQL", async () => {
    await withRows()(async ({ list, update, invoke, projection, respond }) => {
      const current = projection.describe({ agentId: "main", key })!;
      const untouched = projection.describe({ agentId: "work", key: "agent:work:active" })!;
      const before = projection.materializedCount;
      update({ label: "Committed label" });
      // Complete commit receipts reuse their facts; missing facts require the keyed fallback.
      const invalidation = { agentId: "main", sessionKey: key, factsInvalidated: true };
      sessionChanges.invalidate({ ...invalidation, scope: "session-entry" });
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
      using _ = { [Symbol.dispose]: hostSql.restore };
      sessionChanges.emit({
        ...invalidation,
        storePath: current.storeTarget.storePath,
      });
      const listed = await list();
      expect(listed.sessions.find((row) => row.key === key)?.label).toBe("Committed label");
      expect(projection.materializedCount - before).toBe(1);
      expect(projection.describe({ agentId: "work", key: "agent:work:active" })?.materialized).toBe(
        untouched.materialized,
      );
      expect(workerKeys).toHaveBeenCalled();
      for (const [keys] of workerKeys.mock.calls) {
        expect(keys).toEqual([key]);
      }
      expect(hostSql.calls.flatMap((call) => call.mock.calls)).toEqual([]);
      workerKeys.mockClear();
      await list();
      await invoke("describe");
      expectSession(respond, { label: "Committed label" });
      expect(workerKeys).not.toHaveBeenCalled();
      expect(hostSql.calls.flatMap((call) => call.mock.calls)).toEqual([]);
    });
  });
});
