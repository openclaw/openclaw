import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  inspectSqliteSchemaHeader,
  prepareSqliteReadOnlyLocation,
} from "../infra/sqlite-snapshot-source.js";
import { withSqliteSourceHandleAsync } from "../infra/sqlite-source-handle.js";
import { acquireStateDatabaseHandleExclusion } from "../infra/state-database-coordinator.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { acquireOpenClawStateDatabaseFileExclusion } from "./openclaw-state-db-cache.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";

function populate(env: NodeJS.ProcessEnv) {
  const owner = openOpenClawStateDatabase({ env });
  owner.db.exec(
    "CREATE TABLE exclusion_probe(value TEXT); INSERT INTO exclusion_probe VALUES ('original')",
  );
  return owner.path;
}

function readValue(location: string) {
  const db = new DatabaseSync(location, { readOnly: true });
  try {
    return db.prepare("SELECT value FROM exclusion_probe").get()?.value;
  } finally {
    db.close();
  }
}

describe("owner-held SQLite source reads", () => {
  it("does not let a second caller borrow another task's physical exclusion", async () => {
    await withOpenClawTestState({ label: "excluded-owner-reentry" }, async (state) => {
      const databasePath = populate(state.env);
      const current = await acquireOpenClawStateDatabaseFileExclusion(databasePath);
      let competing: ReturnType<typeof acquireStateDatabaseHandleExclusion> | undefined;
      try {
        expect(() => {
          competing = acquireStateDatabaseHandleExclusion({ databasePath });
        }).toThrow(/state-handles/);
        current.assertCurrent();
      } finally {
        competing?.release();
        current.release();
      }
    });
  });

  it.each([prepareSqliteReadOnlyLocation, inspectSqliteSchemaHeader])(
    "honors cancellation before returning a private source inspection (%#)",
    async (inspect) => {
      await withOpenClawTestState({ label: "excluded-copy-abort" }, async (state) => {
        const pathname = populate(state.env);
        const exclusion = await acquireOpenClawStateDatabaseFileExclusion(pathname);
        try {
          await exclusion.runWithSourceReads(async (assertCurrent) => {
            const controller = new AbortController();
            const cancelled = inspect(pathname, { signal: controller.signal });
            controller.abort(new Error("capture cancelled"));
            await expect(cancelled).rejects.toThrow("capture cancelled");
            assertCurrent();
            const retried = await prepareSqliteReadOnlyLocation(pathname);
            try {
              expect(readValue(retried.location)).toBe("original");
            } finally {
              retried.cleanup();
            }
          });
        } finally {
          exclusion.release();
        }
      });
    },
  );

  it("reads a private SQLite copy under current physical exclusion", async () => {
    await withOpenClawTestState({ label: "excluded-checkpoint" }, async (state) => {
      const pathname = populate(state.env);
      const exclusion = await acquireOpenClawStateDatabaseFileExclusion(pathname);
      try {
        await exclusion.runWithSourceReads(async (assertCurrent) => {
          expect(() => openOpenClawStateDatabase({ env: state.env })).toThrow(/state-handles/);
          expect(await inspectSqliteSchemaHeader(pathname)).toMatchObject({
            userVersion: OPENCLAW_STATE_SCHEMA_VERSION,
          });
          const copy = await prepareSqliteReadOnlyLocation(pathname);
          try {
            assertCurrent();
            expect(readValue(copy.location)).toBe("original");
            expect(copy.location).not.toBe(pathname);
          } finally {
            copy.cleanup();
          }
        });
        exclusion.assertCurrent();
      } finally {
        exclusion.release();
      }
    });
  });

  it.each([false, true])(
    "preserves the source with private-copy mode %s",
    async (preserveSourceArtifacts) => {
      await withOpenClawTestState({ label: "excluded-private-copy" }, async (state) => {
        const pathname = populate(state.env);
        const exclusion = await acquireOpenClawStateDatabaseFileExclusion(pathname);
        try {
          await exclusion.runWithSourceReads(async (assertCurrent) => {
            const prepared = await prepareSqliteReadOnlyLocation(pathname, {
              preserveSourceArtifacts,
            });
            try {
              assertCurrent();
              expect(prepared.location).not.toBe(pathname);
              expect(readValue(prepared.location)).toBe("original");
            } finally {
              prepared.cleanup();
            }
          });
        } finally {
          exclusion.release();
        }
      });
    },
  );

  it("does not admit a concurrent non-owner reader through the local scope", async () => {
    await withOpenClawTestState({ label: "excluded-nonowner-read" }, async (state) => {
      const pathname = populate(state.env);
      const exclusion = await acquireOpenClawStateDatabaseFileExclusion(pathname);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const running = exclusion.runWithSourceReads(async (assertCurrent) => {
        entered.resolve();
        await release.promise;
        assertCurrent();
      });
      try {
        await entered.promise;
        await expect(prepareSqliteReadOnlyLocation(pathname)).rejects.toThrow(/state-handles/);
        await expect(inspectSqliteSchemaHeader(pathname)).rejects.toThrow(/state-handles/);
      } finally {
        release.resolve();
        await running;
        exclusion.release();
      }
    });
  });

  it("retains physical exclusion through admitted reads after early owner release", async () => {
    await withOpenClawTestState({ label: "excluded-read-drain" }, async (state) => {
      const pathname = populate(state.env);
      const exclusion = await acquireOpenClawStateDatabaseFileExclusion(pathname);
      const entered = createDeferredCore();
      const finish = createDeferredCore();
      const running = exclusion.runWithSourceReads(async () =>
        withSqliteSourceHandleAsync(pathname, async () => {
          entered.resolve();
          await finish.promise;
          return readValue(pathname);
        }),
      );
      await entered.promise;
      exclusion.release();
      let competing:
        | Awaited<ReturnType<typeof acquireOpenClawStateDatabaseFileExclusion>>
        | undefined;
      try {
        await expect(async () => {
          competing = await acquireOpenClawStateDatabaseFileExclusion(pathname);
        }).rejects.toThrow(/state-handles/);
      } finally {
        competing?.release();
        finish.resolve();
      }
      await expect(running).rejects.toThrow(/no longer current/);
      const next = await acquireOpenClawStateDatabaseFileExclusion(pathname);
      next.release();
    });
  });

  it("expires inherited read scopes and refuses a released owner", async () => {
    await withOpenClawTestState({ label: "excluded-read-expiry" }, async (state) => {
      const pathname = populate(state.env);
      const exclusion = await acquireOpenClawStateDatabaseFileExclusion(pathname);
      const wake = createDeferredCore();
      let delayed: Promise<unknown> | undefined;
      try {
        await exclusion.runWithSourceReads(async () => {
          delayed = wake.promise.then(() => prepareSqliteReadOnlyLocation(pathname));
        });
        const rejected = expect(delayed).rejects.toThrow(/state-handles/);
        wake.resolve();
        await rejected;
      } finally {
        exclusion.release();
      }
      await expect(exclusion.runWithSourceReads(async () => undefined)).rejects.toThrow(
        /no longer current/,
      );
      const prepared = await prepareSqliteReadOnlyLocation(pathname);
      try {
        expect(readValue(prepared.location)).toBe("original");
      } finally {
        prepared.cleanup();
      }
    });
  });
});
