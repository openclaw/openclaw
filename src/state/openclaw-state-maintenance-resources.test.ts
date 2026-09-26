import { afterEach, expect, it } from "vitest";
import { beginDoctorMaintenance } from "../commands/doctor-maintenance.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { buildFlowRecord } from "../tasks/task-flow-registry.records.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "./openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { retainOpenClawStateDatabase } from "./openclaw-state-db-cache.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "./openclaw-state-worker-store.js";

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
});

function createSharedWorkerClient(env: NodeJS.ProcessEnv) {
  const ownerKey = "agent:main:maintenance-resource";
  const flowIds = new Map<string, string>();
  return {
    async register(key: string, value: { value: string }) {
      const flow = buildFlowRecord({
        ownerKey,
        controllerId: "tests/maintenance-resources",
        goal: key,
        stateJson: value,
      });
      await executeOpenClawStateWorker(captureOpenClawStateWorkerContext({ env }), {
        type: "flows.createManaged",
        input: { flow },
      });
      flowIds.set(key, flow.flowId);
    },
    async lookup(key: string) {
      const flowId = flowIds.get(key);
      if (flowId === undefined) {
        return undefined;
      }
      const flow = await executeOpenClawStateWorker(captureOpenClawStateWorkerContext({ env }), {
        type: "flows.current",
        input: { flowId },
      });
      return flow?.stateJson;
    },
    async entries() {
      const flows = await executeOpenClawStateWorker(captureOpenClawStateWorkerContext({ env }), {
        type: "flows.list",
        input: { ownerKey },
      });
      return flows.map((flow) => ({ key: flow.goal, value: flow.stateJson }));
    },
  };
}

it("releases its native borrow without retiring an independent shared client", async () => {
  await withOpenClawTestState({ label: "maintenance-native-borrow" }, async (state) => {
    const store = createSharedWorkerClient(state.env);
    await store.register("foreign", { value: "foreign" });
    const lock = await acquireGatewayLock({
      env: state.env,
      role: "sqlite-maintenance",
      allowInTests: true,
    });
    if (!lock) {
      throw new Error("Expected maintenance lock");
    }
    const owned = await lock.run(async () => {
      const database = openOpenClawStateDatabase({ env: state.env });
      const reference = retainOpenClawStateDatabase(database);
      await store.register("owned", { value: "owned" });
      return { database, reference };
    });
    try {
      await expect(store.register("blocked", { value: "blocked" })).rejects.toThrow(
        "offline maintenance",
      );
      owned.reference.release();
      expect(owned.database.db.isOpen).toBe(false);
      await lock.release();
      expect(owned.database.db.isOpen).toBe(false);
      await expect(store.lookup("foreign")).resolves.toEqual({ value: "foreign" });
      await store.register("after", { value: "after" });
      await expect(store.lookup("after")).resolves.toEqual({ value: "after" });
    } finally {
      try {
        owned.reference.release();
      } finally {
        await lock.release();
      }
    }
  });
});

it("retains sibling-created handles with their common Doctor owner", async () => {
  await withOpenClawTestState(
    { scenario: "external-service", label: "maintenance-sibling-resources" },
    async (state) => {
      const begin = () =>
        beginDoctorMaintenance({
          options: { repair: true },
          root: null,
          runtime: { log() {}, error() {}, exit() {} },
        });
      const parent = await begin();
      if (!parent) {
        throw new Error("Expected parent maintenance");
      }
      try {
        const owned = await parent.run(async () => {
          const first = await begin();
          const second = await begin();
          if (!first || !second) {
            throw new Error("Expected sibling maintenance");
          }
          try {
            const database = first.run(() =>
              openOpenClawAgentDatabase({ agentId: "owned", env: state.env }),
            );
            expect(
              second.run(() => openOpenClawAgentDatabase({ agentId: "owned", env: state.env })),
            ).toBe(database);
            await first.release();
            await second.release();
            expect(database.db.isOpen).toBe(true);
            return database;
          } finally {
            await first.release();
            await second.release();
          }
        });
        await parent.release();
        expect(owned.db.isOpen).toBe(false);
      } finally {
        await parent.release();
      }
    },
  );
});

it("settles its agent resource before closing the associated native handle", async () => {
  await withOpenClawTestState({ label: "maintenance-resource-order" }, async (state) => {
    const lock = await acquireGatewayLock({
      env: state.env,
      role: "sqlite-maintenance",
      allowInTests: true,
    });
    if (!lock) {
      throw new Error("Expected maintenance lock");
    }
    const observed: boolean[] = [];
    try {
      const owned = lock.run(() => {
        const database = openOpenClawAgentDatabase({ agentId: "owned", env: state.env });
        const unregister = registerOpenClawAgentDatabaseAsyncResource({
          agentId: database.agentId,
          path: database.path,
          revoke() {},
          async close() {
            await Promise.resolve();
            observed.push(database.db.isOpen);
            unregister();
          },
        });
        return database;
      });
      await lock.release();
      expect(observed).toEqual([true]);
      expect(owned.db.isOpen).toBe(false);
    } finally {
      await lock.release();
    }
  });
});

it("keeps a parent Doctor handle owned through a nested migration scope", async () => {
  await withOpenClawTestState(
    { scenario: "external-service", label: "maintenance-nested-resources" },
    async (state) => {
      const maintenance = await beginDoctorMaintenance({
        options: { repair: true },
        root: null,
        runtime: { log() {}, error() {}, exit() {} },
      });
      if (!maintenance) {
        throw new Error("Expected Doctor maintenance");
      }
      try {
        const owned = await maintenance.run(async () => {
          const database = openOpenClawAgentDatabase({ agentId: "owned", env: state.env });
          const child = await acquireGatewayLock({
            env: state.env,
            role: "sqlite-maintenance",
            allowInTests: true,
          });
          if (!child) {
            throw new Error("Expected nested maintenance lock");
          }
          try {
            expect(
              child.run(() => openOpenClawAgentDatabase({ agentId: "owned", env: state.env })),
            ).toBe(database);
          } finally {
            await child.release();
          }
          expect(database.db.isOpen).toBe(true);
          return database;
        });
        await maintenance.release();
        expect(owned.db.isOpen).toBe(false);
      } finally {
        await maintenance.release();
      }
    },
  );
});

it("closes its created agent handle while preserving earlier and later runtime handles", async () => {
  await withOpenClawTestState({ label: "maintenance-native-resources" }, async (state) => {
    const earlier = openOpenClawAgentDatabase({ agentId: "earlier", env: state.env });
    const lock = await acquireGatewayLock({
      env: state.env,
      role: "sqlite-maintenance",
      allowInTests: true,
    });
    if (!lock) {
      throw new Error("Expected maintenance lock");
    }
    try {
      const owned = lock.run(() => openOpenClawAgentDatabase({ agentId: "owned", env: state.env }));
      await lock.release();
      const later = openOpenClawAgentDatabase({ agentId: "later", env: state.env });
      expect(owned.db.isOpen).toBe(false);
      expect(earlier.db.isOpen).toBe(true);
      expect(later.db.isOpen).toBe(true);
    } finally {
      await lock.release();
    }
  });
});

it.each([false, true])(
  "preserves an independent shared client across maintenance release (already open=%s)",
  async (alreadyOpen) => {
    await withOpenClawTestState({ label: "maintenance-shared-resources" }, async (state) => {
      const store = createSharedWorkerClient(state.env);
      if (alreadyOpen) {
        await store.register("earlier", { value: "earlier" });
      }
      const lock = await acquireGatewayLock({
        env: state.env,
        role: "sqlite-maintenance",
        allowInTests: true,
      });
      if (!lock) {
        throw new Error("Expected maintenance lock");
      }
      try {
        await lock.run(() => store.register("owned", { value: "owned" }));
        await expect(store.register("later", { value: "later" })).rejects.toThrow(
          "offline maintenance",
        );
        await lock.release();
        await store.register("later", { value: "later" });
        await store.register("after", { value: "after" });
        expect((await store.entries()).map((entry) => entry.key).toSorted()).toEqual(
          (alreadyOpen
            ? ["after", "earlier", "later", "owned"]
            : ["after", "later", "owned"]
          ).toSorted(),
        );
      } finally {
        await lock.release();
      }
    });
  },
);
