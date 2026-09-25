import fs from "node:fs";
import nodePath from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
} from "./openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly-open.js";
import {
  closeOpenClawAgentDatabaseReadOnlyCandidates,
  OpenClawAgentDatabaseReadOnlyScope,
} from "./openclaw-agent-db-readonly-scope.js";
import {
  retainOpenClawAgentDatabaseReadOnly,
  withOpenClawAgentDatabaseReadOnly,
} from "./openclaw-agent-db-readonly.js";
import { openOpenClawAgentDatabase } from "./openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import { createOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";

it("retains rollback recovery preparation without prematurely admitting schema facts", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const options = { agentId: "main", env: state.env };
    const { path } = openOpenClawAgentDatabase(options);
    await closeOpenClawAgentDatabaseByPathAsync(path);
    const recovery = Object.assign(new Error("Synthetic read-only rollback refusal"), {
      errcode: 776,
    });
    const nativeOpen = nodeSqlite.openNodeSqliteDatabase;
    const open = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
      const database = nativeOpen(...args);
      vi.spyOn(database, "prepare").mockImplementation(() => {
        throw recovery;
      });
      return database;
    });
    try {
      expect(() => openOpenClawAgentDatabaseReadOnly(options)).toThrow(recovery);
      const prepared = openOpenClawAgentDatabaseReadOnly(options, { prepareIntegrity: true });
      expect(prepared.found).toBe(true);
      if (!prepared.found) {
        throw new Error("Missing synthetic recovery preparation");
      }
      try {
        expect(prepared.database.rollbackRecovery?.error).toBe(recovery);
        expect(getAdmittedSqliteSchemaFacts(prepared.database.db)).toBeUndefined();
      } finally {
        prepared.database.close();
      }
    } finally {
      open.mockRestore();
    }
  });
});

it("bounds query preparation while scoped reads observe new commits", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const options = { agentId: "main", env: state.env };
    const { path } = openOpenClawAgentDatabase(options);
    await closeOpenClawAgentDatabaseByPathAsync(path);
    const scope = new OpenClawAgentDatabaseReadOnlyScope();
    const writer = new (requireNodeSqlite().DatabaseSync)(path);
    try {
      scope.run({ agentId: "main", path }, () => {
        withOpenClawAgentDatabaseReadOnly(({ db }) => {
          const query = getNodeSqliteKysely<{
            schema_meta: { meta_key: string; updated_at: number };
          }>(db)
            .selectFrom("schema_meta")
            .select("updated_at")
            .where("meta_key", "=", "primary");
          const prepare = vi.spyOn(db, "prepare");
          try {
            for (let stamp = 1; stamp <= 20; stamp++) {
              writer
                .prepare("UPDATE schema_meta SET updated_at = ? WHERE meta_key = 'primary'")
                .run(stamp);
              expect(
                withOpenClawAgentDatabaseReadOnly(
                  (database) => executeSqliteQueryTakeFirstSync(database.db, query)?.updated_at,
                  options,
                ),
              ).toEqual({ found: true, value: stamp });
            }
            const preparations = prepare.mock.calls.filter(([sql]) => sql === query.compile().sql);
            expect(preparations.length).toBeLessThanOrEqual(2);
          } finally {
            prepare.mockRestore();
          }
        }, options);
      });
    } finally {
      writer.close();
      scope.close();
    }
  });
});

it("keeps one connection while nested reads retain independent committed snapshots", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const options = { agentId: "main", env: state.env };
    const { path } = openOpenClawAgentDatabase(options);
    await closeOpenClawAgentDatabaseByPathAsync(path);
    const target = { agentId: "main", path };
    const scope = new OpenClawAgentDatabaseReadOnlyScope();
    const writer = new (requireNodeSqlite().DatabaseSync)(path);
    let retained: DatabaseSync | undefined;
    const query = "SELECT updated_at FROM schema_meta WHERE meta_key = 'primary'";
    try {
      scope.run(target, () => {
        const first = withOpenClawAgentDatabaseReadOnly(({ db }) => {
          retained = db;
          return db.prepare(query).get();
        }, options);
        expect(first.found).toBe(true);
        expect(retained?.isOpen).toBe(true);
        withOpenClawAgentDatabaseReadOnly(({ db }) => {
          expect(db).toBe(retained);
          db.exec("BEGIN DEFERRED");
          try {
            const before = db.prepare(query).get();
            writer
              .prepare(
                "UPDATE schema_meta SET updated_at = updated_at + 1 WHERE meta_key = 'primary'",
              )
              .run();
            const committed = writer.prepare(query).get();
            expect(committed).not.toEqual(before);
            const nested = withOpenClawAgentDatabaseReadOnly(({ db: inner }) => {
              expect(inner).not.toBe(db);
              return inner.prepare(query).get();
            }, options);
            expect(nested).toEqual({ found: true, value: committed });
            expect(db.prepare(query).get()).toEqual(before);
          } finally {
            db.exec("ROLLBACK");
          }
        }, options);
        expect(
          withOpenClawAgentDatabaseReadOnly(({ db }) => db.prepare(query).get(), options),
        ).toEqual({ found: true, value: writer.prepare(query).get() });
      });
    } finally {
      writer.close();
      scope.close();
    }
    expect(retained?.isOpen).toBe(false);
  });
});

it.each([
  {
    sql: `PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1}`,
    error: "newer schema version",
  },
  {
    sql: `PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION - 1}`,
    error: "run openclaw doctor --fix",
  },
  {
    sql: "UPDATE schema_meta SET agent_id = 'another' WHERE meta_key = 'primary'",
    error: "belongs to agent another",
  },
  {
    sql: "UPDATE schema_meta SET role = 'state' WHERE meta_key = 'primary'",
    error: "has schema role state",
  },
])(
  "revalidates retained read admission on the next read after a commit: $sql",
  async ({ sql, error }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const options = { agentId: "main", env: state.env };
      const { path } = openOpenClawAgentDatabase(options);
      await closeOpenClawAgentDatabaseByPathAsync(path);
      const target = { agentId: "main", path };
      const scope = new OpenClawAgentDatabaseReadOnlyScope();
      const read = () =>
        scope.run(target, () => withOpenClawAgentDatabaseReadOnly(() => "admitted", options));
      try {
        expect(read()).toEqual({ found: true, value: "admitted" });
        const writer = new (requireNodeSqlite().DatabaseSync)(path);
        try {
          writer.exec(sql);
        } finally {
          writer.close();
        }
        expect(read).toThrow(error);
      } finally {
        scope.close();
      }
    });
  },
);

it("reuses ordinary readers until idle expiry and reopens after lifecycle invalidation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const options = { agentId: "main", env: state.env };
    const { path } = openOpenClawAgentDatabase(options);
    await closeOpenClawAgentDatabaseByPathAsync(path);
    const open = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const read = () => withOpenClawAgentDatabaseReadOnly(({ db }) => db, options);
    const opens = () => open.mock.calls.filter(([filename]) => filename === path).length;
    try {
      const first = read();
      expect(first.found).toBe(true);
      if (!first.found) {
        throw new Error("Missing synthetic agent database");
      }
      for (let index = 0; index < 20; index++) {
        expect(read()).toEqual(first);
      }
      expect(opens()).toBe(1);
      vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS - 1);
      expect(read()).toEqual(first);
      vi.advanceTimersByTime(1);
      expect(first.value.isOpen).toBe(true);
      vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS - 1);
      expect(first.value.isOpen).toBe(false);
      const reopened = read();
      expect(opens()).toBe(2);
      closeOpenClawAgentDatabaseByPath(path);
      expect(reopened.found && reopened.value.isOpen).toBe(false);
      const replacement = read();
      expect(replacement.found).toBe(true);
      expect(opens()).toBe(3);
      await Promise.resolve();
      expect(replacement.found && replacement.value.isOpen).toBe(true);
      if (replacement.found) {
        replacement.value.close();
      }
      expect(() => vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS)).not.toThrow();
      expect(read().found).toBe(true);
      expect(opens()).toBe(4);
    } finally {
      vi.useRealTimers();
      open.mockRestore();
    }
  });
});

it("pins retained readers through idle expiry but revokes them before database removal", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const options = { agentId: "main", env: state.env };
    const { path } = openOpenClawAgentDatabase(options);
    await closeOpenClawAgentDatabaseByPathAsync(path);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const retained = retainOpenClawAgentDatabaseReadOnly(options);
      expect(retained.found).toBe(true);
      if (!retained.found) {
        throw new Error("Missing synthetic agent database");
      }
      expect(() =>
        withOpenClawAgentDatabaseReadOnly(() => "wrong owner", {
          ...options,
          path,
          agentId: "other",
        }),
      ).toThrow("belongs to agent main; requested agent other");
      expect(retained.claim.isCurrent()).toBe(true);
      vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
      expect(retained.claim.isCurrent()).toBe(true);
      const other = retainOpenClawAgentDatabaseReadOnly(options);
      expect(other.found && other.database.db).toBe(retained.database.db);
      if (other.found) {
        other.claim.release();
      }
      retained.claim.release();
      vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS - 1);
      expect(retained.database.db.isOpen).toBe(true);
      vi.advanceTimersByTime(1);
      expect(retained.database.db.isOpen).toBe(false);
      const stale = retainOpenClawAgentDatabaseReadOnly(options);
      if (!stale.found) {
        throw new Error("Missing synthetic agent database");
      }
      stale.database.db.close();
      const next = retainOpenClawAgentDatabaseReadOnly(options);
      if (!next.found) {
        throw new Error("Missing synthetic replacement reader");
      }
      next.claim.release();
      vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
      expect(next.database.db.isOpen).toBe(false);
      stale.claim.release();
      const reopened = retainOpenClawAgentDatabaseReadOnly(options);
      expect(reopened.found).toBe(true);
      await closeOpenClawAgentDatabaseByPathAsync(path);
      expect(reopened.found && reopened.claim.isCurrent()).toBe(false);
      if (reopened.found) {
        reopened.claim.release();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

it("keeps later reads owned by an explicit scope after its native handle expires", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const options = { agentId: "main", env: state.env };
    const { path } = openOpenClawAgentDatabase(options);
    await closeOpenClawAgentDatabaseByPathAsync(path);
    const scope = new OpenClawAgentDatabaseReadOnlyScope();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await scope.run({ agentId: "main", path }, async () => {
        const first = withOpenClawAgentDatabaseReadOnly(({ db }) => db, options);
        await Promise.resolve();
        vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
        expect(first.found && first.value.isOpen).toBe(false);
        const next = withOpenClawAgentDatabaseReadOnly(({ db }) => db, options);
        expect(next.found && next.value.isOpen).toBe(true);
        scope.close();
        expect(next.found && next.value.isOpen).toBe(false);
      });
    } finally {
      scope.close();
      vi.useRealTimers();
    }
  });
});

it("promotes a reused reader beyond the maintenance scope that first opened it", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const options = { agentId: "main", env: state.env };
    const { path } = openOpenClawAgentDatabase(options);
    await closeOpenClawAgentDatabaseByPathAsync(path);
    const parent = createOpenClawDatabaseMaintenanceScope();
    const child = parent.run(() => createOpenClawDatabaseMaintenanceScope());
    const read = () => withOpenClawAgentDatabaseReadOnly(({ db }) => db, options);
    try {
      const first = child.run(read);
      expect(parent.run(read)).toEqual(first);
      await child.close();
      expect(first.found && first.value.isOpen).toBe(true);
      await parent.close();
      expect(first.found && first.value.isOpen).toBe(false);
    } finally {
      await child.close();
      await parent.close();
    }
  });
});

it.each(["database-missing", "schema-missing", "callback-error"] as const)(
  "keeps retries owned by their explicit scope after %s",
  async (failure) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const options = { agentId: "scope-retry", env: state.env };
      const pathname = resolveOpenClawAgentSqlitePath(options);
      const scope = new OpenClawAgentDatabaseReadOnlyScope();
      const create = () => {
        openOpenClawAgentDatabase(options);
        closeOpenClawAgentDatabaseByPath(pathname);
      };
      if (failure === "callback-error") {
        create();
      } else if (failure === "schema-missing") {
        fs.mkdirSync(nodePath.dirname(pathname), { recursive: true });
        nodeSqlite.openNodeSqliteDatabase(pathname).close();
      }
      try {
        scope.run({ agentId: options.agentId, path: pathname }, () => {
          if (failure === "callback-error") {
            const error = new Error("synthetic reader failure");
            expect(() =>
              withOpenClawAgentDatabaseReadOnly(() => {
                throw error;
              }, options),
            ).toThrow(error);
          } else {
            expect(withOpenClawAgentDatabaseReadOnly(() => "unreachable", options)).toEqual({
              found: false,
              reason: failure,
            });
            create();
          }
          const reopened = withOpenClawAgentDatabaseReadOnly(({ db }) => db, options);
          expect(reopened.found && reopened.value.isOpen).toBe(true);
          scope.close();
          expect(reopened.found && reopened.value.isOpen).toBe(false);
        });
      } finally {
        scope.close();
      }
    });
  },
);

it("closes generic and explicit candidate-family readers without releasing unrelated paths", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const family = state.statePath("selected.sqlite");
    const sibling = state.statePath("selected.extra.sqlite");
    const unrelated = state.statePath("unrelated.sqlite");
    const options = (path: string) => ({ agentId: "main", path, env: state.env });
    for (const path of [family, sibling, unrelated]) {
      openOpenClawAgentDatabase(options(path));
      await closeOpenClawAgentDatabaseByPathAsync(path);
    }
    const scope = new OpenClawAgentDatabaseReadOnlyScope();
    const read = (path: string) => {
      const result = withOpenClawAgentDatabaseReadOnly(({ db }) => db, options(path));
      if (!result.found) {
        throw new Error("Missing synthetic reader database");
      }
      return result.value;
    };
    const selected = read(family);
    const explicit = scope.run(options(sibling), () => read(sibling));
    const retained = read(unrelated);
    const candidates = [{ path: family, scope: "sibling-family" as const }];
    try {
      closeOpenClawAgentDatabaseReadOnlyCandidates(candidates);
      expect(selected.isOpen).toBe(false);
      expect(explicit.isOpen).toBe(false);
      expect(retained.isOpen).toBe(true);
      expect(read(unrelated)).toBe(retained);

      const reopened = scope.run(options(sibling), () => read(sibling));
      const failure = new Error("native reader close failed");
      const close = vi.spyOn(reopened, "close").mockImplementationOnce(() => {
        throw failure;
      });
      try {
        expect(() => closeOpenClawAgentDatabaseReadOnlyCandidates(candidates)).toThrow(failure);
        expect(reopened.isOpen).toBe(true);
        expect(() => scope.run(options(sibling), () => read(sibling))).toThrow(
          "native cleanup is pending",
        );
        closeOpenClawAgentDatabaseReadOnlyCandidates(candidates);
        expect(reopened.isOpen).toBe(false);
        expect(retained.isOpen).toBe(true);
      } finally {
        close.mockRestore();
      }
    } finally {
      scope.close();
    }
  });
});
