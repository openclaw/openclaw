import { describe, expect, it } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createManagedTaskFlow,
  getTaskFlowById,
  requestFlowCancel,
  setFlowWaiting,
} from "./task-flow-registry.js";
import type { TaskFlowRegistryObserverEvent } from "./task-flow-registry.store.js";
import { loadTaskFlowRegistryStateFromSqlite } from "./task-flow-registry.store.sqlite.js";
import {
  configureTaskFlowRegistryRuntime,
  resetTaskFlowRegistryForTests,
} from "./task-runtime.test-helpers.js";

async function withFlow(run: (flowId: string) => void): Promise<void> {
  await withOpenClawTestState({ layout: "state-only", prefix: "task-flow-cas-" }, async () => {
    resetTaskFlowRegistryForTests({ persist: false });
    try {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/cas",
        goal: "Canonical flow",
      });
      expect(flow).not.toBeNull();
      if (flow) {
        run(flow.flowId);
      }
    } finally {
      resetTaskFlowRegistryForTests({ persist: false });
    }
  });
}

describe("task-flow canonical revision updates", () => {
  it("preserves the existing controller default when updating a restored legacy flow", async () => {
    await withFlow((flowId) => {
      const { db } = openOpenClawStateDatabase();
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DB>(db)
          .updateTable("flow_runs")
          .set({ controller_id: null })
          .where("flow_id", "=", flowId),
      );
      resetTaskFlowRegistryForTests({ persist: false });
      expect(getTaskFlowById(flowId)?.controllerId).toBe("core/legacy-restored");
      expect(setFlowWaiting({ flowId, expectedRevision: 0 })).toMatchObject({
        applied: true,
        flow: { revision: 1, controllerId: "core/legacy-restored" },
      });
    });
  });

  it("rejects a stale revision and preserves the latest fields on the next update", async () => {
    await withFlow((flowId) => {
      const { DatabaseSync } = requireNodeSqlite();
      const writer = new DatabaseSync(openOpenClawStateDatabase().path);
      try {
        executeSqliteQuerySync(
          writer,
          getNodeSqliteKysely<DB>(writer)
            .updateTable("flow_runs")
            .set({ revision: 1, goal: "Changed by another connection" })
            .where("flow_id", "=", flowId),
        );
        expect(setFlowWaiting({ flowId, expectedRevision: 0 })).toMatchObject({
          applied: false,
          reason: "revision_conflict",
          current: { revision: 1, goal: "Changed by another connection" },
        });
        expect(getTaskFlowById(flowId)).toMatchObject({
          revision: 1,
          goal: "Changed by another connection",
        });
        expect(setFlowWaiting({ flowId, expectedRevision: 1 })).toMatchObject({
          applied: true,
          flow: { revision: 2, status: "waiting", goal: "Changed by another connection" },
        });
        expect(loadTaskFlowRegistryStateFromSqlite().flows.get(flowId)).toMatchObject({
          revision: 2,
          status: "waiting",
          goal: "Changed by another connection",
        });
      } finally {
        writer.close();
      }
    });
  });

  it("does not recreate a flow deleted by another connection", async () => {
    await withFlow((flowId) => {
      const { DatabaseSync } = requireNodeSqlite();
      const writer = new DatabaseSync(openOpenClawStateDatabase().path);
      try {
        executeSqliteQuerySync(
          writer,
          getNodeSqliteKysely<DB>(writer).deleteFrom("flow_runs").where("flow_id", "=", flowId),
        );
        expect(setFlowWaiting({ flowId, expectedRevision: 0 })).toEqual({
          applied: false,
          reason: "not_found",
        });
        expect(getTaskFlowById(flowId)).toBeUndefined();
        expect(loadTaskFlowRegistryStateFromSqlite().flows.has(flowId)).toBe(false);
      } finally {
        writer.close();
      }
    });
  });

  it("does not publish unchanged state when the expected revision is incorrect", async () => {
    await withFlow((flowId) => {
      const events: TaskFlowRegistryObserverEvent[] = [];
      configureTaskFlowRegistryRuntime({ observers: { onEvent: (event) => events.push(event) } });
      expect(setFlowWaiting({ flowId, expectedRevision: 42 })).toMatchObject({
        applied: false,
        reason: "revision_conflict",
        current: { revision: 0 },
      });
      expect(events).toEqual([]);
    });
  });

  it.each(["conflict", "missing"] as const)(
    "rolls back the cached canonical %s observation with its outer transaction",
    async (observation) => {
      await withFlow((flowId) => {
        const before = getTaskFlowById(flowId);
        const { DatabaseSync } = requireNodeSqlite();
        const writer = new DatabaseSync(openOpenClawStateDatabase().path);
        try {
          const kysely = getNodeSqliteKysely<DB>(writer);
          if (observation === "conflict") {
            executeSqliteQuerySync(
              writer,
              kysely
                .updateTable("flow_runs")
                .set({ revision: 1, goal: "Canonical current state" })
                .where("flow_id", "=", flowId),
            );
          } else {
            executeSqliteQuerySync(
              writer,
              kysely.deleteFrom("flow_runs").where("flow_id", "=", flowId),
            );
          }
          const events: TaskFlowRegistryObserverEvent[] = [];
          configureTaskFlowRegistryRuntime({
            observers: { onEvent: (event) => events.push(event) },
          });
          const expected = observation === "conflict" ? "revision_conflict" : "not_found";
          expect(() =>
            runOpenClawStateWriteTransaction(() => {
              expect(setFlowWaiting({ flowId, expectedRevision: 0 })).toMatchObject({
                applied: false,
                reason: expected,
              });
              if (observation === "conflict") {
                expect(getTaskFlowById(flowId)).toMatchObject({ revision: 1 });
              } else {
                expect(getTaskFlowById(flowId)).toBeUndefined();
              }
              expect(events).toEqual([]);
              throw new Error("abort canonical observation");
            }),
          ).toThrow("abort canonical observation");
          expect(getTaskFlowById(flowId)).toEqual(before);
          expect(events).toEqual([]);
          expect(setFlowWaiting({ flowId, expectedRevision: 0 })).toMatchObject({
            applied: false,
            reason: expected,
          });
          expect(events).toHaveLength(1);
          expect(events[0]?.kind).toBe(observation === "conflict" ? "upserted" : "deleted");
        } finally {
          writer.close();
        }
      });
    },
  );

  it.each(["commit", "rollback", "reentrant observer", "reentrant conflict"] as const)(
    "preserves staged revisions and observer order for %s",
    async (outcome) => {
      await withFlow((flowId) => {
        const events: TaskFlowRegistryObserverEvent[] = [];
        let reentrantResult: ReturnType<typeof setFlowWaiting> | undefined;
        configureTaskFlowRegistryRuntime({
          observers: {
            onEvent: (event) => {
              events.push(event);
              if (
                (outcome === "reentrant observer" || outcome === "reentrant conflict") &&
                event.kind === "upserted" &&
                event.flow.revision === 1
              ) {
                reentrantResult = setFlowWaiting({
                  flowId,
                  expectedRevision:
                    outcome === "reentrant observer"
                      ? (getTaskFlowById(flowId)?.revision ?? -1)
                      : 42,
                  currentStep: "observer update",
                });
              }
            },
          },
        });
        const operation = () =>
          runOpenClawStateWriteTransaction(() => {
            expect(setFlowWaiting({ flowId, expectedRevision: 0 })).toMatchObject({
              applied: true,
              flow: { revision: 1 },
            });
            expect(getTaskFlowById(flowId)?.revision).toBe(1);
            expect(requestFlowCancel({ flowId, expectedRevision: 1 })).toMatchObject({
              applied: true,
              flow: { revision: 2 },
            });
            expect(getTaskFlowById(flowId)?.revision).toBe(2);
            expect(events).toEqual([]);
            if (outcome === "rollback") {
              throw new Error("abort outer transaction");
            }
          });
        if (outcome === "rollback") {
          expect(operation).toThrow("abort outer transaction");
          expect(events).toEqual([]);
        } else {
          operation();
          expect(events.map((event) => event.kind === "upserted" && event.flow.revision)).toEqual(
            outcome === "reentrant observer" ? [1, 3] : [1, 2],
          );
          if (outcome === "reentrant observer") {
            expect(reentrantResult).toMatchObject({ applied: true, flow: { revision: 3 } });
          } else if (outcome === "reentrant conflict") {
            expect(reentrantResult).toMatchObject({
              applied: false,
              reason: "revision_conflict",
              current: { revision: 2 },
            });
          }
        }
        const revision = outcome === "rollback" ? 0 : outcome === "reentrant observer" ? 3 : 2;
        expect(getTaskFlowById(flowId)?.revision).toBe(revision);
        expect(loadTaskFlowRegistryStateFromSqlite().flows.get(flowId)?.revision).toBe(revision);
      });
    },
  );

  it("discards an inner rollback while allowing the outer transaction to continue", async () => {
    await withFlow((flowId) => {
      const events: TaskFlowRegistryObserverEvent[] = [];
      configureTaskFlowRegistryRuntime({ observers: { onEvent: (event) => events.push(event) } });
      runOpenClawStateWriteTransaction(() => {
        expect(setFlowWaiting({ flowId, expectedRevision: 0 })).toMatchObject({ applied: true });
        expect(() =>
          runOpenClawStateWriteTransaction(() => {
            expect(requestFlowCancel({ flowId, expectedRevision: 1 })).toMatchObject({
              applied: true,
            });
            throw new Error("abort savepoint");
          }),
        ).toThrow("abort savepoint");
        expect(getTaskFlowById(flowId)).toMatchObject({ revision: 1, status: "waiting" });
        expect(getTaskFlowById(flowId)?.cancelRequestedAt).toBeUndefined();
        expect(
          setFlowWaiting({ flowId, expectedRevision: 1, currentStep: "continued" }),
        ).toMatchObject({
          applied: true,
          flow: { revision: 2 },
        });
        expect(events).toEqual([]);
      });
      expect(events.map((event) => event.kind === "upserted" && event.flow.revision)).toEqual([
        1, 2,
      ]);
      expect(loadTaskFlowRegistryStateFromSqlite().flows.get(flowId)).toMatchObject({
        revision: 2,
        currentStep: "continued",
      });
      expect(getTaskFlowById(flowId)?.cancelRequestedAt).toBeUndefined();
    });
  });
});
