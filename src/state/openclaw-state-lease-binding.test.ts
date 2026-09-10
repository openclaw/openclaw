import { AsyncResource } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { prepareSqliteReadOnlyLocation } from "../infra/sqlite-readonly-location.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { withOpenClawStateLease } from "./openclaw-state-lease.js";

describe("lease-backed source binding", () => {
  it.each([false, true])(
    "persists owner output under exclusion (publisher failure: %s)",
    async (publisherFailure) => {
      await withOpenClawTestState({ label: "lease-checkpoint-binding" }, async (state) => {
        const options = { env: state.env };
        const outsider = new AsyncResource("independent-checkpoint-writer");
        let bindingConnection: DatabaseSync | undefined;
        let bound = false;
        try {
          await withPluginLifecycleLease(options, async (plugin) => {
            await withAgentDatabaseMaintenanceLease(options, async (maintenance) => {
              const capture = maintenance.withDatabaseFileExclusion;
              if (!capture) {
                throw new Error("missing file exclusion");
              }
              const sourcePath = openOpenClawStateDatabase(options).path;
              const task = capture(
                async (assertCurrent) => {
                  const copy = await prepareSqliteReadOnlyLocation(sourcePath);
                  try {
                    assertCurrent();
                    return copy.location !== sourcePath;
                  } finally {
                    copy.cleanup();
                  }
                },
                (copied, assertCurrent) => {
                  assertCurrent();
                  plugin.assertOwned();
                  maintenance.assertOwned();
                  expect(() =>
                    outsider.runInAsyncScope(() =>
                      runOpenClawStateWriteTransaction(() => undefined, options),
                    ),
                  ).toThrow(/state-handles/);
                  expect(copied).toBe(true);
                  runOpenClawStateWriteTransaction(({ db }) => {
                    db.exec(
                      "INSERT INTO config_machine_state(state_key,value_json,updated_at_ms) VALUES ('test:capture-bind','true',1)",
                    );
                  }, options);
                  bindingConnection = openOpenClawStateDatabase(options).db;
                  expect(bindingConnection.isOpen).toBe(true);
                  bound = true;
                  if (publisherFailure) {
                    throw new Error("publisher failed after durable bind");
                  }
                },
              );
              if (publisherFailure) {
                await expect(task).rejects.toThrow("publisher failed after durable bind");
              } else {
                await task;
              }
              expect(bound).toBe(true);
              expect(bindingConnection?.isOpen).toBe(false);
              const persisted = openOpenClawStateDatabase(options)
                .db.prepare(
                  "SELECT value_json FROM config_machine_state WHERE state_key='test:capture-bind'",
                )
                .get();
              expect(persisted?.value_json).toBe("true");
            });
          });
        } catch (error) {
          if (!publisherFailure || !bound) {
            throw error;
          }
          // The enclosing lease drains the same failed publication; it must not
          // convert persisted work into success or discard its retained artifact.
          expect(String(error)).toContain("publisher failed after durable bind");
        } finally {
          outsider.emitDestroy();
        }
        expect(bound).toBe(true);
        expect(bindingConnection?.isOpen).toBe(false);
      });
    },
  );
});

describe("source binding admission", () => {
  it("drains invalid async binders and permanently revokes their inherited write scope", async () => {
    await withOpenClawTestState({ label: "lease-async-binding" }, async (state) => {
      const options = { env: state.env };
      const entered = createDeferredCore();
      const finish = createDeferredCore();
      let completed = false;
      let staleWriter: AsyncResource | undefined;
      let raw: DatabaseSync | undefined;
      const running = withAgentDatabaseMaintenanceLease(options, async (lease) => {
        const capture = lease.withDatabaseFileExclusion;
        if (!capture) {
          throw new Error("missing file exclusion");
        }
        // Reflect models an untyped consumer violating the synchronous contract.
        await Reflect.apply(capture, undefined, [
          async () => undefined,
          async () => {
            staleWriter = new AsyncResource("detached-binding-writer");
            raw = openOpenClawStateDatabase(options).db;
            entered.resolve();
            await finish.promise;
            expect(raw.isOpen).toBe(false);
            expect(() => raw?.exec("CREATE TABLE forbidden_binding_write (id INTEGER)")).toThrow();
            expect(() => runOpenClawStateWriteTransaction(() => undefined, options)).toThrow(
              /no longer current/,
            );
          },
        ]);
      }).finally(() => {
        completed = true;
      });
      const rejected = expect(running).rejects.toThrow(/binding must complete synchronously/);
      try {
        await entered.promise;
        expect(completed).toBe(false);
        expect(raw?.isOpen).toBe(false);
        expect(() => openOpenClawStateDatabase(options)).toThrow(/state-handles/);
      } finally {
        finish.resolve();
      }
      await rejected;
      expect(openOpenClawStateDatabase(options).db.isOpen).toBe(true);
      try {
        expect(() =>
          staleWriter?.runInAsyncScope(() =>
            runOpenClawStateWriteTransaction(() => undefined, options),
          ),
        ).toThrow(/no longer current/);
      } finally {
        staleWriter?.emitDestroy();
      }
    });
  });

  it("closes the private binding connection after expiry without admitting another write", async () => {
    await withOpenClawTestState({ label: "lease-binding-expiry" }, async (state) => {
      const options = { env: state.env };
      let connection: DatabaseSync | undefined;
      let wrote = false;
      await expect(
        withOpenClawStateLease(
          {
            scope: "core:test-binding-expiry",
            key: "bind",
            database: { scope: "shared", options },
            heartbeat: "worker",
            leaseMs: 1200,
            waitMs: 0,
          },
          async (lease) => {
            const capture = lease.withDatabaseFileExclusion;
            if (!capture) {
              throw new Error("missing file exclusion");
            }
            await capture(
              async () => undefined,
              (_captured, assertCurrent) => {
                connection = openOpenClawStateDatabase(options).db;
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1300);
                runOpenClawStateWriteTransaction(() => {
                  wrote = true;
                }, options);
                assertCurrent();
              },
            );
          },
        ),
      ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
      expect(wrote).toBe(false);
      expect(connection?.isOpen).toBe(false);
      expect(openOpenClawStateDatabase(options).db.isOpen).toBe(true);
    });
  });
});
