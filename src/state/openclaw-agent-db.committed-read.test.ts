import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { closeCachedOpenClawAgentDatabase } from "./openclaw-agent-db-lifecycle.js";
import { withOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
  type OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db.js";
import { listOpenClawAgentDatabasesForTest } from "./openclaw-agent-db.test-support.js";

const stampQuery = "SELECT updated_at FROM schema_meta WHERE meta_key = 'primary'";

function readStamp(options: OpenClawAgentDatabaseOptions, behavior?: { allowExtension?: boolean }) {
  const result = withOpenClawAgentDatabaseReadOnly(
    ({ db }) => ({ db, stamp: db.prepare(stampQuery).get()?.updated_at }),
    options,
    behavior,
  );
  if (!result.found) {
    throw new Error(`Expected existing fixture database: ${result.reason}`);
  }
  return result.value;
}

function inWriterTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    return operation();
  } finally {
    if (db.isOpen && db.isTransaction) {
      db.exec("ROLLBACK");
    }
  }
}

describe("committed agent database reads", () => {
  it("reuses a separate reader while observing committed changes between writer transactions", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const options = { agentId: "main", env };
      const owner = openOpenClawAgentDatabase(options);
      owner.db.exec("UPDATE schema_meta SET updated_at = 101 WHERE meta_key = 'primary'");
      const reader = inWriterTransaction(owner.db, () => {
        owner.db.exec("UPDATE schema_meta SET updated_at = 202 WHERE meta_key = 'primary'");
        const first = readStamp(options);
        expect(first.stamp).toBe(101);
        expect(first.db === owner.db).toBe(false);
        expect(first.db.isOpen).toBe(true);
        const second = readStamp(options);
        expect(second.db === first.db).toBe(true);
        expect(second.stamp).toBe(101);
        expect(owner.db.isTransaction).toBe(true);
        return first.db;
      });

      owner.db.exec("UPDATE schema_meta SET updated_at = 303 WHERE meta_key = 'primary'");
      inWriterTransaction(owner.db, () => {
        owner.db.exec("UPDATE schema_meta SET updated_at = 404 WHERE meta_key = 'primary'");
        const current = readStamp(options);
        expect(current.db === reader).toBe(true);
        expect(current.stamp).toBe(303);
      });
      expect(readStamp(options).db === owner.db).toBe(true);
      expect(readStamp(options).stamp).toBe(303);
    });
  });

  it.each([
    {
      name: "schema version",
      sql: `PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1}`,
      error: /newer schema version/,
    },
    {
      name: "database role",
      sql: "UPDATE schema_meta SET role = 'state' WHERE meta_key = 'primary'",
      error: /schema role.*state.*expected agent/,
    },
    {
      name: "agent owner",
      sql: "UPDATE schema_meta SET agent_id = 'other' WHERE meta_key = 'primary'",
      error: /belongs to agent other.*requested agent main/,
    },
  ])("rechecks committed $name before invoking a retained reader", async ({ sql, error }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const options = { agentId: "main", env };
      const owner = openOpenClawAgentDatabase(options);
      inWriterTransaction(owner.db, () => expect(readStamp(options).db.isOpen).toBe(true));
      owner.db.exec(sql);
      let invoked = false;
      inWriterTransaction(owner.db, () => {
        expect(() =>
          withOpenClawAgentDatabaseReadOnly(() => {
            invoked = true;
          }, options),
        ).toThrow(error);
      });
      expect(invoked).toBe(false);
    });
  });

  it("preserves missing-schema adaptation after the reader was retained", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const options = { agentId: "main", env };
      const owner = openOpenClawAgentDatabase(options);
      inWriterTransaction(owner.db, () => expect(readStamp(options).db.isOpen).toBe(true));
      owner.db.exec("DELETE FROM schema_meta WHERE meta_key = 'primary'");
      let invoked = false;
      inWriterTransaction(owner.db, () => {
        expect(
          withOpenClawAgentDatabaseReadOnly(() => {
            invoked = true;
          }, options),
        ).toEqual({ found: false, reason: "schema-missing" });
      });
      expect(invoked).toBe(false);
    });
  });

  it.each(["native close", "native dispose", "owner close", "eviction"] as const)(
    "retires the committed reader on %s",
    async (action) => {
      await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
        const options = { agentId: "main", env };
        const owner = openOpenClawAgentDatabase(options);
        const reader = inWriterTransaction(owner.db, () => readStamp(options).db);
        expect(reader.isOpen).toBe(true);
        const originalWalClose = owner.walMaintenance.close.bind(owner.walMaintenance);
        const walClose =
          action === "owner close" || action === "eviction"
            ? vi.spyOn(owner.walMaintenance, "close").mockImplementation((closeOptions) => {
                expect(reader.isOpen).toBe(false);
                return originalWalClose(closeOptions);
              })
            : undefined;
        try {
          if (action === "native close") {
            owner.db.close();
          } else if (action === "native dispose") {
            owner.db[Symbol.dispose]();
          } else if (action === "owner close") {
            closeOpenClawAgentDatabaseByPath(owner.path);
          } else {
            closeCachedOpenClawAgentDatabase(owner, { eviction: true });
          }
          expect(reader.isOpen).toBe(false);
          if (walClose) {
            expect(walClose).toHaveBeenCalled();
          }
        } finally {
          walClose?.mockRestore();
        }
      });
    },
  );

  it("does not give a reopened writer the previous writer's reader", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const options = { agentId: "main", env };
      const original = openOpenClawAgentDatabase(options);
      const first = inWriterTransaction(original.db, () => readStamp(options).db);
      expect(first.isOpen).toBe(true);
      closeOpenClawAgentDatabaseByPath(original.path);
      const replacement = openOpenClawAgentDatabase(options);
      const second = inWriterTransaction(replacement.db, () => readStamp(options).db);
      expect(replacement.db === original.db).toBe(false);
      expect(second === first).toBe(false);
      expect(first.isOpen).toBe(false);
      expect(second.isOpen).toBe(true);
    });
  });

  it.runIf(typeof DatabaseSync.prototype.deserialize === "function")(
    "retires the reader before a failed native deserialize attempt without closing its writer",
    async () => {
      await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
        const options = { agentId: "main", env };
        const owner = openOpenClawAgentDatabase(options);
        owner.db.exec("UPDATE schema_meta SET updated_at = 101 WHERE meta_key = 'primary'");
        const bytes = owner.db.serialize();
        inWriterTransaction(owner.db, () => {
          owner.db.prepare(stampQuery).get();
          const reader = readStamp(options).db;
          // SQLite rejects replacement while the connection holds a transaction.
          expect(() => owner.db.deserialize(bytes)).toThrow();
          expect(reader.isOpen).toBe(false);
          expect(owner.db.isOpen).toBe(true);
          expect(owner.db.isTransaction).toBe(true);
          const next = readStamp(options);
          expect(next.db === reader).toBe(false);
          expect(next.stamp).toBe(101);
        });
        expect(readStamp(options).stamp).toBe(101);
      });
    },
  );

  it("keeps failed companion disposal retryable before closing the parent connection", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const options = { agentId: "main", env };
      const owner = openOpenClawAgentDatabase(options);
      const reader = inWriterTransaction(owner.db, () => readStamp(options).db);
      const close = vi.spyOn(reader, "close").mockImplementationOnce(() => {
        throw new Error("synthetic reader close failure");
      });
      try {
        expect(() => owner.db.close()).toThrow("synthetic reader close failure");
        expect(owner.db.isOpen).toBe(true);
        expect(reader.isOpen).toBe(true);
        inWriterTransaction(owner.db, () => expect(readStamp(options).db === reader).toBe(true));
        owner.db.close();
        expect(owner.db.isOpen).toBe(false);
        expect(reader.isOpen).toBe(false);
      } finally {
        close.mockRestore();
      }
    });
  });

  it("gives nested callbacks a one-shot reader while the outer reader stays usable", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const options = { agentId: "main", env };
      const owner = openOpenClawAgentDatabase(options);
      owner.db.exec("UPDATE schema_meta SET updated_at = 101 WHERE meta_key = 'primary'");
      inWriterTransaction(owner.db, () => {
        const retained = readStamp(options).db;
        const result = withOpenClawAgentDatabaseReadOnly(({ db }) => {
          expect(db === retained).toBe(true);
          const nested = readStamp(options);
          expect(nested.db === db).toBe(false);
          expect(nested.db === owner.db).toBe(false);
          expect(nested.db.isOpen).toBe(false);
          expect(nested.stamp).toBe(101);
          expect(db.isOpen).toBe(true);
          return db.prepare(stampQuery).get()?.updated_at;
        }, options);
        expect(result).toEqual({ found: true, value: 101 });
        expect(readStamp(options).db === retained).toBe(true);
      });
    });
  });

  it.each([false, true])(
    "closes a leaked reader transaction when the callback throws=%s",
    async (throws) => {
      await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
        const options = { agentId: "main", env };
        const owner = openOpenClawAgentDatabase(options);
        inWriterTransaction(owner.db, () => {
          const reader = readStamp(options).db;
          expect(reader.isOpen).toBe(true);
          const leak = () =>
            withOpenClawAgentDatabaseReadOnly(({ db }) => {
              expect(db === reader).toBe(true);
              db.exec("BEGIN");
              db.prepare(stampQuery).get();
              if (throws) {
                throw new Error("synthetic reader failure");
              }
            }, options);
          if (throws) {
            expect(leak).toThrow("synthetic reader failure");
          } else {
            leak();
          }
          expect(reader.isOpen).toBe(false);
          expect(owner.db.isTransaction).toBe(true);
          const next = readStamp(options);
          expect(next.db === reader).toBe(false);
          expect(next.db.isTransaction).toBe(false);
        });
      });
    },
  );

  it.each(["cold", "extension"] as const)("keeps %s reads one-shot", async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const options = { agentId: "main", env };
      const owner = openOpenClawAgentDatabase(options);
      const read = () => {
        const first = readStamp(options, kind === "extension" ? { allowExtension: true } : {});
        const second = readStamp(options, kind === "extension" ? { allowExtension: true } : {});
        expect(first.db === owner.db).toBe(false);
        expect(second.db === first.db).toBe(false);
        expect(first.db.isOpen).toBe(false);
        expect(second.db.isOpen).toBe(false);
      };
      if (kind === "cold") {
        openOpenClawAgentDatabase({ agentId: "other", env });
        closeOpenClawAgentDatabaseByPath(owner.path);
        const cachedWriters = listOpenClawAgentDatabasesForTest();
        read();
        expect(listOpenClawAgentDatabasesForTest()).toEqual(cachedWriters);
      } else {
        inWriterTransaction(owner.db, read);
      }
    });
  });

  it("keeps incognito reads on their sole process-owned connection", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const options = {
        agentId: "main",
        env,
        path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
      };
      const owner = openOpenClawAgentDatabase(options);
      inWriterTransaction(owner.db, () => {
        expect(readStamp(options).db === owner.db).toBe(true);
        expect(owner.db.isTransaction).toBe(true);
      });
      expect(owner.db.isOpen).toBe(true);
      expect(fs.existsSync(options.path)).toBe(false);
    });
  });

  it.runIf(process.platform !== "win32")(
    "retires an old companion after its pathname is retargeted to another same-agent database",
    async () => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const original = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
        original.db.exec("UPDATE schema_meta SET updated_at = 101 WHERE meta_key = 'primary'");
        const replacement = openOpenClawAgentDatabase({
          agentId: "main",
          env: state.env,
          path: state.path("replacement.sqlite"),
        });
        replacement.db.exec("UPDATE schema_meta SET updated_at = 202 WHERE meta_key = 'primary'");
        const alias = state.path("alias.sqlite");
        fs.symlinkSync(original.path, alias);
        const options = { agentId: "main", env: state.env, path: alias };
        const owner = openOpenClawAgentDatabase(options);
        const previousReader = inWriterTransaction(owner.db, () => readStamp(options).db);
        expect(previousReader.isOpen).toBe(true);
        fs.unlinkSync(alias);
        fs.symlinkSync(replacement.path, alias);
        inWriterTransaction(owner.db, () => {
          const current = readStamp(options);
          expect(current.stamp).toBe(202);
          expect(current.db === previousReader).toBe(false);
          expect(current.db === owner.db).toBe(false);
          expect(previousReader.isOpen).toBe(false);
        });
      });
    },
  );
});
