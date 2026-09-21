import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { sessionByKeyReadHandlers } from "./server-methods/sessions-read-by-key.js";
import { requestContext } from "./server-methods/sessions-read-cache.test-support.js";
import type { SessionRowReadView } from "./session-row-prepared-read.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

afterEach(() => vi.restoreAllMocks());

const cfg = { agents: { entries: { main: {} } } };
const query = { agentId: "main", key: "agent:main:dashboard:incognito-prepared" };

it.each([false, true])(
  "preserves stored session ID spelling in placement facts (archived: %s)",
  async (archived) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const target = { agentId: "main", sessionKey: "agent:main:placement-spelling" };
      const sessionId = " placement-spelling ";
      replaceSessionEntrySync(target, {
        sessionId,
        updatedAt: 1,
        ...(archived ? { archivedAt: 1 } : {}),
      });
      expect(loadSessionEntryReadOnly(target)?.sessionId).toBe(sessionId);
      const placements = createWorkerSessionPlacementStore();
      placements.startDispatch({ ...target, sessionId });
      const projection = await createSessionRowProjection({
        cfg,
        modelCatalog: [],
        placementFactsReader: placements,
      });
      const context = bindSessionRowProjection(requestContext(cfg), () => projection);
      const respond = vi.fn();
      try {
        await projection.ensureMaterialized();
        expect(projection.materializedCount).toBe(archived ? 0 : 1);
        await sessionByKeyReadHandlers["sessions.describe"]!({
          req: { type: "req", id: "placement-spelling", method: "sessions.describe" },
          params: { key: target.sessionKey },
          client: null,
          context,
          isWebchatConnect: () => false,
          respond,
        });
        expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
          session: expect.objectContaining({
            key: target.sessionKey,
            sessionId,
            placement: expect.objectContaining({ state: "requested" }),
          }),
        });
        expect(loadSessionEntryReadOnly(target)?.sessionId).toBe(sessionId);
      } finally {
        projection.dispose();
      }
    });
  },
);

it("consumes an incognito describe response without SQLite or resident private rows", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    replaceSessionEntrySync(
      { agentId: query.agentId, sessionKey: query.key },
      {
        sessionId: "private-description",
        lifecycleRevision: "original",
        updatedAt: 1,
        incognito: true,
      },
    );
    const placements = createWorkerSessionPlacementStore();
    placements.startDispatch({
      agentId: query.agentId,
      sessionKey: query.key,
      sessionId: "private-description",
    });
    const projection = await createSessionRowProjection({ cfg, placementFactsReader: placements });
    const prepare = projection.withPreparedExactRows.bind(projection);
    let retained: SessionRowReadView | undefined;
    const prepared = vi
      .spyOn(projection, "withPreparedExactRows")
      .mockImplementation((queries, consume) => {
        const statements = [
          vi.spyOn(DatabaseSync.prototype, "exec"),
          ...(["all", "get", "iterate", "run"] as const).map((method) =>
            vi.spyOn(StatementSync.prototype, method),
          ),
        ];
        return prepare(queries, (read) => {
          retained = read;
          expect(
            statements.reduce((count, statement) => count + statement.mock.calls.length, 0),
          ).toBeGreaterThan(0);
          for (const statement of statements) {
            statement.mockClear();
          }
          const result = consume(read);
          for (const statement of statements) {
            expect(statement).not.toHaveBeenCalled();
          }
          return result;
        }).finally(() => {
          for (const statement of statements) {
            statement.mockRestore();
          }
        });
      });
    const escapedPlacement = createDeferredCore<unknown>();
    const respond = vi.fn(() => {
      queueMicrotask(() => {
        try {
          escapedPlacement.resolve(projection.snapshot(query).row?.placement);
        } catch (error) {
          escapedPlacement.reject(error);
        }
      });
    });
    const context = bindSessionRowProjection(requestContext(cfg), () => projection);
    try {
      await sessionByKeyReadHandlers["sessions.describe"]!({
        req: { type: "req", id: "private-description", method: "sessions.describe" },
        params: { key: query.key },
        client: null,
        context,
        isWebchatConnect: () => false,
        respond,
      });
      expect(prepared).toHaveBeenCalledOnce();
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
        session: expect.objectContaining({
          key: query.key,
          sessionId: "private-description",
          placement: expect.objectContaining({ state: "requested" }),
        }),
      });
      expect(await escapedPlacement.promise).toBeUndefined();
      expect(projection.selectEntries()).toEqual([]);
      expect(() => retained?.describe(query)).toThrow("no longer active");
    } finally {
      projection.dispose();
    }
  });
});

it("keeps missing private reads absent and refuses unprepared keys and asynchronous consumers", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const projection = await createSessionRowProjection({ cfg });
    let retained: SessionRowReadView | undefined;
    try {
      await projection.withPreparedExactRows(
        () => [query],
        (read) => {
          expect(read.describe(query)).toBeUndefined();
          expect(() => read.describe({ ...query, key: `${query.key}-other` })).toThrow(
            "not prepared",
          );
        },
      );
      await expect(
        projection.withPreparedExactRows(
          () => [],
          (read) => {
            retained = read;
            return Promise.resolve();
          },
        ),
      ).rejects.toThrow("must remain synchronous");
      expect(() => retained?.selectEntries({ key: query.key })).toThrow("no longer active");
      expect(projection.capture(query)).toBeUndefined();
      expect(projection.selectEntries()).toEqual([]);
    } finally {
      projection.dispose();
    }
  });
});

it("prepares only the private response's child selections before consumption", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    replaceSessionEntrySync(
      { agentId: query.agentId, sessionKey: query.key },
      { sessionId: "private-parent", updatedAt: 1, incognito: true },
    );
    const projection = await createSessionRowProjection({ cfg });
    try {
      const row = projection.describe(query);
      if (!row) {
        throw new Error("Expected the private parent fixture");
      }
      const childKey = "agent:main:child-visibility";
      row.materialized.row.swarm = {
        otherActiveGroups: 0,
        groups: [
          {
            groupId: "private-group",
            createdAt: 1,
            queued: 0,
            running: 1,
            done: 0,
            failed: 0,
            children: [{ sessionKey: childKey, status: "running" }],
          },
        ],
      };
      vi.spyOn(projection, "describe").mockReturnValue(row);
      const select = vi.spyOn(projection, "selectEntries").mockReturnValue([]);
      await projection.withPreparedExactRows(
        () => [query],
        (read) => {
          expect(select).toHaveBeenCalledExactlyOnceWith({ key: childKey });
          select.mockClear();
          select.mockImplementation(() => {
            throw new Error("child metadata must be read before consumption");
          });
          expect(read.selectEntries({ key: childKey })).toEqual([]);
          expect(() => read.selectEntries({ key: "agent:main:unprepared-child" })).toThrow(
            "not prepared",
          );
          expect(select).not.toHaveBeenCalled();
        },
      );
      expect(projection.capture(query)?.entry?.sessionId).toBe("private-parent");
    } finally {
      projection.dispose();
    }
  });
});
