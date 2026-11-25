import { performance } from "node:perf_hooks";
import { StatementSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  observeHostDataSql,
  observeSqliteReadSql,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { notifyPreparedModelRuntimePublication } from "../agents/prepared-model-runtime.publication-events.js";
import { publishSubagentRunChanges } from "../agents/subagents/registry/subagent-registry-publication.js";
import { SqliteBoardStore } from "../boards/sqlite-board-store.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import * as sessions from "../config/sessions/session-accessor.js";
import { recordSessionParticipant } from "../config/sessions/session-accessor.sqlite-participants.native.js";
import { updateSessionGroupCategoriesInWorker } from "../config/sessions/session-group-categories.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../config/sessions/session-sharing-store.native.js";
import * as history from "../config/sessions/session-transcript-worker-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as agentDb from "../state/openclaw-agent-db.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  requestContext,
  sessionReadHandlers,
} from "./server-methods/sessions-read-cache.test-support.js";
import { readSessionGroupMembership } from "./session-group-membership.read.js";
import { putSessionGroups } from "./session-groups.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import * as rowLookup from "./session-row-projection-materialize.js";
import { listRows, writeRow } from "./session-row-projection-read-fixtures.test-support.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";
import {
  createTestProjection,
  holdForeground,
} from "./session-row-projection.read-fixture.test-support.js";
import { requestSessionRow } from "./session-row-projection.test-support.js";
import * as storeKeys from "./session-store-key.js";
import * as rowInputs from "./session-utils-row.js";
import type { SessionsListResult } from "./session-utils.types.js";

const cfg = { agents: { entries: { main: {} } } };
function withListState(run: () => Promise<void>, config: OpenClawConfig = cfg) {
  return withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot(config);
    await run();
  });
}
const keysOf = (result: SessionsListResult) => result.sessions.map(({ key }) => key);

describe("list preparation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("retries failed catalog renewal without blocking lists on its replacement", async () => {
    await withListState(async () => {
      const key = "agent:main:dashboard:catalog-retry";
      const catalog = [
        {
          id: "fixture",
          name: "Fixture",
          provider: "unit-test",
          contextWindow: 8192,
          contextTokens: 8192,
        },
      ];
      writeRow(key, {
        sessionId: "catalog-retry",
        providerOverride: "unit-test",
        modelOverride: "fixture",
      });
      const readCatalog = vi.fn(async () => catalog);
      using _ = holdForeground();
      using projection = await createTestProjection({
        cfg,
        modelCatalog: catalog,
        getModelCatalog: readCatalog,
      });
      const failure = createDeferredCore<typeof catalog>();
      const replacement = createDeferredCore<typeof catalog>();
      try {
        await projection.ensureMaterialized();
        readCatalog.mockClear();
        readCatalog.mockReturnValueOnce(failure.promise).mockReturnValueOnce(replacement.promise);
        notifyPreparedModelRuntimePublication({ phase: "catalog-published" });
        expect(readCatalog).toHaveBeenCalledOnce();
        failure.reject(new Error("Synthetic catalog renewal failure"));
        await failure.promise.catch(() => {});
        const previous = await listRows(projection, { limit: 1 });
        expect(previous.sessions).toMatchObject([{ key, contextTokens: 8192 }]);
        expect(readCatalog).toHaveBeenCalledTimes(2);
        replacement.resolve([{ ...catalog[0]!, contextWindow: 16384, contextTokens: 16384 }]);
        await replacement.promise;
        const current = await listRows(projection, { limit: 1 });
        expect(current.sessions).toMatchObject([{ key, contextTokens: 16384 }]);
      } finally {
        failure.resolve(catalog);
        replacement.resolve(catalog);
      }
    });
  });

  it("retains prepared child metadata across publication and cached archive views", async () => {
    await withListState(async () => {
      const parent = "agent:main:dashboard:archive-parent";
      const children = [1, 2].map((id) => `${parent}-child-${id}`);
      writeRow(parent, { sessionId: "archive-parent", updatedAt: 3 });
      const writeChild = (index: number, archivedAt?: number) =>
        writeRow(children[index]!, {
          sessionId: `archive-child-${index}`,
          parentSessionKey: parent,
          archivedAt,
        });
      writeChild(0);
      writeChild(1, 1);
      using _ = holdForeground();
      using projection = await createTestProjection({ cfg, modelCatalog: [] });
      const listParent = async () => {
        const result = await listRows(projection, { limit: 1 }, { acceptsSerializedJson: true });
        expect(result.sessions[0]?.key).toBe(parent);
        return result.sessions[0]?.childSessions ?? [];
      };

      await projection.ensureMaterialized();
      sessionChanges.emit({ all: true, scope: "catalog" });
      expect(await listParent()).toEqual([children[0]]);
      const reads = vi.spyOn(history, "withSessionHistoryWorkerDatabases");
      const sql = observeSqliteReadSql(StatementSync.prototype);
      try {
        publishSubagentRunChanges();
        expect(await listParent()).toEqual([children[0]]);
        expect(keysOf(await listRows(projection, { limit: 1, offset: 1 }))).toEqual([children[0]]);
        expect(reads).not.toHaveBeenCalled();
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
      const archived = await listRows(
        projection,
        { archived: true },
        { acceptsSerializedJson: true },
      );
      expect(keysOf(archived)).toEqual([children[1]]);
      const all = await listRows(
        projection,
        { archived: "all", limit: 1 },
        { acceptsSerializedJson: true },
      );
      expect(all.sessions[0]?.childSessions).toEqual(children);
      const visible = await listParent();
      expect(visible).toEqual([children[0]]);
      expect(await listParent()).toBe(visible);
      writeChild(0, 2);
      expect(await listParent()).toEqual([]);
      writeChild(0);
      writeChild(1);
      expect(await listParent()).toEqual(children);
    });
  });

  it("prepares the roster once and yields while enriching only overlapping selected pages", async () => {
    await withListState(async () => {
      const keys = Array.from({ length: 80 }, (_, index) => `agent:main:dashboard:page-${index}`);
      for (const [index, key] of keys.entries()) {
        writeRow(key, { sessionId: `page-${index}`, updatedAt: index + 1 });
      }
      using _ = holdForeground();
      using projection = await createTestProjection({ cfg, modelCatalog: [] });

      await projection.ensureMaterialized();
      expect(projection.materializedCount).toBe(0);
      const context = bindSessionRowProjection(requestContext(cfg), () => projection);
      const reads = vi.spyOn(history, "withSessionHistoryWorkerDatabases");
      const sql = observeSqliteReadSql(StatementSync.prototype);
      const rendered: string[] = [];
      const materialized: number[] = [];
      let elapsed = 0;
      let checkpoint: Promise<number> | undefined;
      vi.spyOn(performance, "now").mockImplementation(() => elapsed);
      const readInputs = rowInputs.readSessionRowInputs;
      vi.spyOn(rowInputs, "readSessionRowInputs").mockImplementation((params) => {
        const result = readInputs(params);
        rendered.push(params.key);
        // Charge the slice budget deterministically without sleeping or busy-waiting.
        elapsed += 20;
        checkpoint ??= nextTurn().then(() => rendered.length);
        return result;
      });
      const listPage = async (offset: number, index: number) => {
        let result: SessionsListResult | undefined;
        await requestSessionRow(
          sessionReadHandlers["sessions.list"]!,
          context,
          "sessions.list",
          { limit: 5, offset },
          (ok, value) => {
            expect(ok).toBe(true);
            materialized.push(projection.materializedCount);
            result = value as SessionsListResult;
          },
          null,
          `page-${index}`,
        );
        return result!;
      };
      try {
        sessionChanges.emit({ all: true, scope: "catalog" });
        const pages = await Promise.all([0, 5, 0, 5].map(listPage));
        const expectedPages = [0, 5, 0, 5].map((offset) =>
          Array.from({ length: 5 }, (_entry, index) => `page-${79 - offset - index}`),
        );
        expect(pages.map((page) => page.sessions)).toMatchObject(
          expectedPages.map((page) =>
            page.map((sessionId) => ({ sessionId, key: `agent:main:dashboard:${sessionId}` })),
          ),
        );
        expect(await checkpoint).toBeLessThan(5);
        expect(rendered.toSorted()).toEqual(keys.slice(-10).toSorted());
        expect([Math.max(...materialized), reads.mock.calls, sql.queries]).toEqual([10, [], []]);
        await projection.ensureMaterialized();
        expect(projection.materializedCount).toBe(10);

        // Repeating the pages over unchanged rows renders, materializes and reads nothing,
        // including after an unrelated subagent registry renewal.
        rendered.length = 0;
        publishSubagentRunChanges();
        const canonicalize = vi.spyOn(storeKeys, "resolveStoredSessionKeyForAgentStore");
        const lookups = vi.spyOn(rowLookup, "lookupSessionRow");
        for (const [index, offset] of [0, 5, 0, 5].entries()) {
          expect((await listPage(offset, index)).sessions).toEqual(pages[index]!.sessions);
        }
        expect(lookups.mock.calls.length).toBeLessThanOrEqual(4 * 5 * 2);
        expect([rendered, projection.materializedCount, sql.queries]).toEqual([[], 10, []]);
        expect([reads.mock.calls, canonicalize.mock.calls]).toEqual([[], []]);
      } finally {
        sql.restore();
      }
    });
  });

  it("selects fresh metadata and board facts without materializing the unselected roster", async () => {
    await withListState(async () => {
      const writeSelection = (published: boolean) => {
        for (let index = 0; index < 70; index++) {
          writeRow(`agent:main:dashboard:selection-${index}`, {
            sessionId: `selection-${index}`,
            updatedAt: published ? 100 - index : index + 1,
            label: published ? "After publication" : "Before publication",
            providerOverride: "unit-test",
            modelOverride: published ? "current-model" : "old-model",
            modelOverrideSource: "user",
          });
        }
      };
      writeSelection(false);
      const key = "agent:main:dashboard:selection-0";
      const board = new SqliteBoardStore({
        resolveSession: ({ sessionKey }) => ({ agentId: "main", sessionKey }),
      });
      await board.putWidget({
        sessionKey: key,
        name: "status",
        content: { kind: "html", html: "<p>Ready</p>" },
      });
      using _ = holdForeground();
      using projection = await createTestProjection({ cfg, modelCatalog: [] });

      await projection.ensureMaterialized();
      const before = projection.materializedCount;
      writeSelection(true);
      let count = 0;
      const selected = await listRows(
        projection,
        { limit: 1, search: "current-model", hasBoard: true },
        {
          onResult: () => (count = projection.materializedCount - before),
        },
      );
      expect(selected.sessions).toMatchObject([
        { key, sessionId: "selection-0", label: "After publication" },
      ]);
      expect(count).toBe(1);
      expect(selected.totalCount).toBe(1);
      const old = await listRows(projection, { limit: 1, search: "old-model" });
      expect(old).toMatchObject({ totalCount: 0, sessions: [] });
      const withoutBoard = await listRows(projection, { limit: 1, hasBoard: false });
      expect(withoutBoard.sessions.map((row) => row.sessionId)).toEqual(["selection-1"]);
    });
  });
});

function observeQueries(prototype: StatementSync) {
  const { queries, restore } = observeSqliteReadSql(prototype);
  return {
    expectNoMembershipSql: () =>
      expect(queries.filter((sql) => /\bsession_(members|participants)\b/i.test(sql))).toEqual([]),
    [Symbol.dispose]: restore,
  };
}

const participant = (id: string) => ({ identity: { type: "agent" as const, id } });
it("publishes group and participant facts without host membership SQL during cold admission, row refresh or 50 viewer reads", async () => {
  await withListState(async () => {
    const scope = { agentId: "main", sessionKey: "agent:main:projected-members" };
    await sessions.upsertSessionEntryCore(scope, {
      sessionId: "projected-members",
      updatedAt: Date.now(),
      category: " Work ",
    });
    addSessionMember(scope, { identityId: "viewer", addedBy: "owner", addedAt: 1 });
    recordSessionParticipant(scope, { identity: { type: "agent", id: "research" }, promptedAt: 2 });
    recordSessionParticipant(scope, { identity: { type: "agent", id: "main" }, promptedAt: 1 });
    const database = agentDb.openOpenClawAgentDatabase(scope);
    const prototype: StatementSync = Object.getPrototypeOf(database.db.prepare("SELECT 1"));
    // Profile display admission has its own owner; keep this boundary on the cold session store.
    const profiles = await prepareUserProfileCatalog();
    const admissionReads = observeHostDataSql();
    let projection: SessionRowProjection | undefined;
    const query = { agentId: scope.agentId, key: scope.sessionKey };
    try {
      projection = await createSessionRowProjection({ cfg: {}, modelCatalog: [] });
      await projection.ensureMaterialized();
      admissionReads.restore();
      expect(admissionReads.queries).toEqual([]);
      const described = projection.describe(query);
      expect(described?.entry).toMatchObject({
        participants: [participant("main"), participant("research")],
        participantCount: 2,
      });
      const goldenGroups = JSON.stringify([...readSessionGroupMembership({}, process.env).groups]);
      const participantsJson = () => JSON.stringify(projection!.snapshot(query).row?.participants);
      const goldenParticipants = participantsJson();
      expect(described?.membership.has("viewer")).toBe(true);
      {
        using reads = observeQueries(prototype);
        for (let viewer = 0; viewer < 50; viewer++) {
          expect(JSON.stringify([...projection.sessionGroupTargets()])).toBe(goldenGroups);
          expect(participantsJson()).toBe(goldenParticipants);
          expect(projection.hasMembership(database.path, scope.sessionKey, "viewer")).toBe(true);
        }
        reads.expectNoMembershipSql();
      }
      // Revocation is visible before full-row materialization or another awaited worker read.
      removeSessionMember(scope, "viewer");
      expect(projection.hasMembership(database.path, scope.sessionKey, "viewer")).toBe(false);
      {
        using refreshReads = observeQueries(prototype);
        await projection.ensureMaterialized();
        await projection.prepareMembership();
        expect(projection.describe(query)?.membership.has("viewer")).toBe(false);
        expect(participantsJson()).toBe(goldenParticipants);
        refreshReads.expectNoMembershipSql();
      }
    } finally {
      admissionReads.restore();
      projection?.dispose();
      profiles.release();
    }
  }, {});
});

it.each(["transaction", "worker"] as const)(
  "installs complete %s facts before pre-registered observers",
  async (mode) => {
    await withListState(async () => {
      const membershipConfig = {};
      const transaction = mode === "transaction";
      const keys = transaction
        ? ["agent:main:transaction-members"]
        : ["agent:main:category-a", "agent:main:category-b"];
      const scope = { agentId: "main", sessionKey: keys[0]! };
      if (!transaction) {
        await putSessionGroups({ cfg: membershipConfig, names: ["work", "done"] });
      }
      for (const sessionKey of keys) {
        await sessions.upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: transaction ? "old" : sessionKey,
            updatedAt: 1,
            category: transaction ? "old" : "work",
          },
        );
      }
      if (transaction) {
        addSessionMember(scope, { identityId: "old-viewer", addedBy: "owner" });
        recordSessionParticipant(scope, { ...participant("research"), promptedAt: 1 });
      }
      const { path } = agentDb.openOpenClawAgentDatabase(scope);
      const replace = (sessionId: string, updatedAt: number) =>
        sessions.replaceSessionEntrySync(scope, { sessionId, updatedAt, category: sessionId });
      let projection: SessionRowProjection | undefined;
      let observing = false;
      const observed: unknown[] = [];
      const stop = sessionChanges.subscribe(() => {
        if (observing && projection) {
          observed.push(
            transaction
              ? {
                  old: projection.hasMembership(path, scope.sessionKey, "old-viewer"),
                  current: projection.hasMembership(path, scope.sessionKey, "current-viewer"),
                  transient: projection.hasMembership(path, scope.sessionKey, "transient"),
                  groups: [...projection.sessionGroupTargets().keys()],
                }
              : [...projection.sessionGroupTargets()],
          );
        }
      });
      try {
        projection = await createSessionRowProjection({ cfg: membershipConfig, modelCatalog: [] });
        await projection.ensureMaterialized();
        observing = true;
        if (transaction) {
          agentDb.runOpenClawAgentWriteTransaction(() => {
            replace("intermediate", 2);
            replace("current", 3);
            addSessionMember(scope, { identityId: "transient", addedBy: "owner" });
            removeSessionMember(scope, "transient");
            addSessionMember(scope, { identityId: "current-viewer", addedBy: "owner" });
            recordSessionParticipant(scope, { ...participant("reviewer"), promptedAt: 2 });
            expect(() =>
              agentDb.runOpenClawAgentWriteTransaction(() => {
                replace("rolled-back", 4);
                addSessionMember(scope, { identityId: "rolled-back", addedBy: "owner" });
                throw new Error("rollback savepoint");
              }, scope),
            ).toThrow("rollback savepoint");
            expect(observed).toEqual([]);
          }, scope);
          expect(observed.length).toBeGreaterThan(0);
        } else {
          expect(
            await updateSessionGroupCategoriesInWorker({
              scope: { agentId: "main", sessionKey: "", storePath: path },
              from: "work",
              to: "done",
            }),
          ).toBe(2);
          expect(observed).toHaveLength(2);
        }
        const expected = transaction
          ? { old: false, current: true, transient: false, groups: ["current"] }
          : [["done", keys.map((sessionKey) => ({ agentId: "main", sessionKey }))]];
        for (const value of observed) {
          expect(value).toEqual(expected);
        }
        expect(projection.needsMembershipPreparation()).toBe(false);
        if (transaction) {
          const query = { agentId: scope.agentId, key: scope.sessionKey };
          const entry = await withReadySessionRows(
            projection,
            () => [query],
            (read) => read.describe(query)?.entry,
          );
          expect(entry).toMatchObject({
            sessionId: "current",
            category: "current",
            participants: [participant("research"), participant("reviewer")],
            participantCount: 2,
          });
        }
      } finally {
        stop();
        projection?.dispose();
      }
    }, {});
  },
);
