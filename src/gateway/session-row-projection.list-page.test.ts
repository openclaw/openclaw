import { performance } from "node:perf_hooks";
import { StatementSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { notifyPreparedModelRuntimePublication } from "../agents/prepared-model-runtime.publication-events.js";
import { publishSubagentRunChanges } from "../agents/subagents/registry/subagent-registry-publication.js";
import { SqliteBoardStore } from "../boards/sqlite-board-store.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import * as history from "../config/sessions/session-transcript-worker-runtime.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  requestContext,
  sessionReadHandlers,
} from "./server-methods/sessions-read-cache.test-support.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { listProjectedSessions } from "./session-utils-list.js";
import * as rowInputs from "./session-utils-row.js";
import type { SessionsListResult } from "./session-utils.types.js";

afterEach(() => vi.restoreAllMocks());

it("retries failed catalog renewal without blocking lists on its replacement", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
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
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key },
      {
        sessionId: "catalog-retry",
        updatedAt: 1,
        providerOverride: "unit-test",
        modelOverride: "fixture",
      },
    );
    const readCatalog = vi.fn(async () => catalog);
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({
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
      const previous = await listProjectedSessions({ projection, opts: { limit: 1 } });
      expect(previous.sessions).toMatchObject([{ key, contextTokens: 8192 }]);
      expect(readCatalog).toHaveBeenCalledTimes(2);
      replacement.resolve([{ ...catalog[0]!, contextWindow: 16384, contextTokens: 16384 }]);
      await replacement.promise;
      const current = await listProjectedSessions({ projection, opts: { limit: 1 } });
      expect(current.sessions).toMatchObject([{ key, contextTokens: 16384 }]);
    } finally {
      failure.resolve(catalog);
      replacement.resolve(catalog);
      projection.dispose();
      release();
    }
  });
});

it("retains prepared child metadata across a parent presentation refresh", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const parent = "agent:main:dashboard:prepared-parent";
    const child = "agent:main:dashboard:prepared-child";
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: parent },
      { sessionId: "prepared-parent", updatedAt: 2 },
    );
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: child },
      { sessionId: "prepared-child", updatedAt: 1, parentSessionKey: parent },
    );
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    try {
      await projection.ensureMaterialized();
      sessionChanges.emit({ all: true, scope: "catalog" });
      const listParent = () => listProjectedSessions({ projection, opts: { limit: 1 } });
      await listParent();
      const reads = vi.spyOn(history, "withSessionHistoryWorkerDatabases");
      const sql = observeSqliteReadSql(StatementSync.prototype);
      try {
        publishSubagentRunChanges();
        const listed = await listParent();
        expect(listed.sessions).toMatchObject([{ key: parent, childSessions: [child] }]);
        const page = await listProjectedSessions({ projection, opts: { limit: 1, offset: 1 } });
        expect(page.sessions.map((row) => row.key)).toEqual([child]);
        expect(reads).not.toHaveBeenCalled();
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
    } finally {
      projection.dispose();
      release();
    }
  });
});

it("yields while materializing only overlapping selected pages for concurrent list handlers", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const keys = Array.from({ length: 80 }, (_, index) => `agent:main:dashboard:page-${index}`);
    for (const [index, key] of keys.entries()) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: key },
        { sessionId: `page-${index}`, updatedAt: index + 1 },
      );
    }
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    try {
      await projection.ensureMaterialized();
      const context = bindSessionRowProjection(requestContext(cfg), () => projection);
      const before = projection.materializedCount;
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
      try {
        sessionChanges.emit({ all: true, scope: "catalog" });
        const pages = await Promise.all(
          [0, 5, 0, 5].map(async (offset, index) => {
            const respond = vi.fn();
            await sessionReadHandlers["sessions.list"]!({
              req: { type: "req", id: `page-${index}`, method: "sessions.list" },
              params: { limit: 5, offset },
              client: null,
              context,
              isWebchatConnect: () => false,
              respond(ok, result) {
                expect(ok).toBe(true);
                materialized.push(projection.materializedCount - before);
                respond(result);
              },
            });
            expect(respond).toHaveBeenCalledOnce();
            return respond.mock.calls[0]![0] as SessionsListResult;
          }),
        );
        expect(pages.map((page) => page.sessions.map((row) => row.sessionId))).toEqual([
          ["page-79", "page-78", "page-77", "page-76", "page-75"],
          ["page-74", "page-73", "page-72", "page-71", "page-70"],
          ["page-79", "page-78", "page-77", "page-76", "page-75"],
          ["page-74", "page-73", "page-72", "page-71", "page-70"],
        ]);
        expect(pages.map((page) => page.sessions.map((row) => row.key))).toEqual(
          [0, 5, 0, 5].map((offset) => keys.toReversed().slice(offset, offset + 5)),
        );
        expect(await checkpoint).toBeLessThan(5);
        expect(rendered.toSorted()).toEqual(keys.slice(-10).toSorted());
        expect(Math.max(...materialized)).toBe(10);
        expect(reads).not.toHaveBeenCalled();
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
    } finally {
      projection.dispose();
      release();
    }
  });
});

it("selects fresh metadata and board facts without materializing the unselected roster", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    for (let index = 0; index < 70; index++) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: `agent:main:dashboard:selection-${index}` },
        {
          sessionId: `selection-${index}`,
          updatedAt: index + 1,
          label: "Before publication",
          providerOverride: "unit-test",
          modelOverride: "old-model",
          modelOverrideSource: "user",
        },
      );
    }
    const key = "agent:main:dashboard:selection-0";
    const board = new SqliteBoardStore({
      resolveSession: ({ sessionKey }) => ({ agentId: "main", sessionKey }),
    });
    await board.putWidget({
      sessionKey: key,
      name: "status",
      content: { kind: "html", html: "<p>Ready</p>" },
    });
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    try {
      await projection.ensureMaterialized();
      const before = projection.materializedCount;
      for (let index = 0; index < 70; index++) {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: `agent:main:dashboard:selection-${index}` },
          {
            sessionId: `selection-${index}`,
            updatedAt: 100 - index,
            label: "After publication",
            providerOverride: "unit-test",
            modelOverride: "current-model",
            modelOverrideSource: "user",
          },
        );
      }
      let count = 0;
      const selected = await listProjectedSessions({
        projection,
        opts: { limit: 1, search: "current-model", hasBoard: true },
        onResult: () => (count = projection.materializedCount - before),
      });
      expect(selected.sessions).toEqual([
        expect.objectContaining({ key, sessionId: "selection-0", label: "After publication" }),
      ]);
      expect(count).toBe(1);
      expect(selected.totalCount).toBe(1);
      const old = await listProjectedSessions({
        projection,
        opts: { limit: 1, search: "old-model" },
      });
      expect(old.totalCount).toBe(0);
      expect(old.sessions).toEqual([]);
      const withoutBoard = await listProjectedSessions({
        projection,
        opts: { limit: 1, hasBoard: false },
      });
      expect(withoutBoard.sessions.map((row) => row.sessionId)).toEqual(["selection-1"]);
    } finally {
      projection.dispose();
      release();
    }
  });
});
