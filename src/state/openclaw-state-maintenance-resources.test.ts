import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { beginDoctorMaintenance } from "../commands/doctor-maintenance.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { captureCoordinatorDatabase } from "../infra/sqlite-coordinator.test-support.js";
import * as workerStores from "../infra/sqlite-worker-store.js";
import { acquireGatewayLifecycleCoordinator } from "../infra/state-database-coordinator.js";
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
  const namespace = { pluginId: "maintenance-resources-fixture", namespace: "shared" };
  return {
    async register(key: string, value: { value: string }) {
      const result = await executeOpenClawStateWorker(captureOpenClawStateWorkerContext({ env }), {
        type: "pluginState.register",
        input: {
          ...namespace,
          key,
          valueJson: JSON.stringify(value),
          maxEntries: 10,
          overflowPolicy: "reject-new",
        },
      });
      expect(result).toEqual({ ok: true, value: undefined });
    },
    async lookup(key: string) {
      const result = await executeOpenClawStateWorker(captureOpenClawStateWorkerContext({ env }), {
        type: "pluginState.lookup",
        input: { ...namespace, key },
      });
      if (!result.ok) {
        throw new Error("Synthetic shared-state lookup failed", { cause: result.error });
      }
      return result.value;
    },
    async entries() {
      const result = await executeOpenClawStateWorker(captureOpenClawStateWorkerContext({ env }), {
        type: "pluginState.entries",
        input: namespace,
      });
      if (!result.ok) {
        throw new Error("Synthetic shared-state listing failed", { cause: result.error });
      }
      return result.value;
    },
  };
}

it("releases its native borrow without retiring an independent shared client", async () => {
  await withOpenClawTestState({ label: "maintenance-native-borrow" }, async (state) => {
    const store = createSharedWorkerClient(state.env);
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
      await store.register("foreign", { value: "foreign" });
      await lock.release();
      expect(owned.database.db.isOpen).toBe(false);
      await expect(store.lookup("foreign")).resolves.toEqual({ value: "foreign" });
      await store.register("after", { value: "after" });
      await expect(store.lookup("after")).resolves.toEqual({ value: "after" });
    } finally {
      owned.reference.release();
      await lock.release();
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
      const later = openOpenClawAgentDatabase({ agentId: "later", env: state.env });
      await lock.release();
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
        await store.register("later", { value: "later" });
        await lock.release();
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

it("reopens shared state after another owner completes failed-admission cleanup", async () => {
  await withOpenClawTestState({ label: "shared-worker-cleanup-handoff" }, async (state) => {
    const context = captureOpenClawStateWorkerContext({ env: state.env });
    const databasePath = context.admission.databasePath;
    const { result: gateway, database } = captureCoordinatorDatabase(() =>
      acquireGatewayLifecycleCoordinator({
        databasePath,
        runtimeDirectory: context.coordinatorRuntime.directory,
      }),
    );
    openOpenClawStateDatabase({ env: state.env });
    await closeOpenClawStateDatabaseAsync();
    const backendPath = await state.writeText(
      "failed-open.mjs",
      `
      export function createSqliteWorkerBackend() {
        throw new Error("Fixture shared-state factory failed");
      }
    `,
    );
    const openSharedState = workerStores.openSharedStateSqliteWorkerStore;
    const opening = vi
      .spyOn(workerStores, "openSharedStateSqliteWorkerStore")
      .mockImplementationOnce((options, ...args) =>
        openSharedState({ ...options, moduleUrl: pathToFileURL(backendPath) }, ...args),
      );
    const close = vi.spyOn(database, "close").mockImplementationOnce(() => {
      throw new Error("Fixture native coordinator close remains pending");
    });
    const dispatch = vi.spyOn(Worker.prototype, "postMessage").mockImplementationOnce(function (
      this: Worker,
      ...args
    ) {
      dispatch.mockRestore();
      const result = this.postMessage(...args);
      gateway.release();
      return result;
    });
    const read = () =>
      executeOpenClawStateWorker(captureOpenClawStateWorkerContext({ env: state.env }), {
        type: "pluginState.entries",
        input: { pluginId: "maintenance-resources-fixture", namespace: "shared" },
      });
    try {
      await expect(read()).rejects.toMatchObject({
        message: "SQLite worker failure and cleanup failed",
        cause: { message: "Fixture shared-state factory failed" },
      });
      opening.mockRestore();
      dispatch.mockRestore();
      expect(database.isOpen).toBe(true);
      expect(workerStores.hasUnclaimedSharedStateSqliteCleanup(databasePath)).toBe(true);
      await expect(read()).rejects.toThrow("Shared-state SQLite cleanup is pending");

      await workerStores.closeUnclaimedSharedStateSqliteWorkers(databasePath);
      expect(database.isOpen).toBe(false);
      expect(workerStores.hasUnclaimedSharedStateSqliteCleanup(databasePath)).toBe(false);
      await expect(read()).resolves.toEqual({ ok: true, value: [] });
    } finally {
      opening.mockRestore();
      dispatch.mockRestore();
      close.mockRestore();
      await workerStores.closeUnclaimedSharedStateSqliteWorkers(databasePath);
      await closeOpenClawStateDatabaseAsync();
      gateway.release();
    }
  });
});
