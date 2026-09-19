import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { acquireStateDatabaseHandleExclusion } from "../infra/state-database-coordinator.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { onUserProfilesChanged } from "./user-profile-events.js";
import { readUserProfileIdentity, retainUserProfileCatalog } from "./user-profile-list.js";
import { changeUserProfileRole } from "./user-profiles-role.js";
import type { UserProfileRoleMutationGuard } from "./user-profiles-role.types.js";
import {
  ensureProfileForEmail,
  getUserProfileRole,
  getUserProfileListItem,
  setDisplayName,
} from "./user-profiles.js";
import {
  createLegacyUserProfilesTable,
  seedUserProfileRole,
} from "./user-profiles.test-support.js";

const delivery = vi.hoisted(() => ({
  afterResult: undefined as ((role: string | null) => Promise<void>) | undefined,
  afterRead: undefined as ((result: unknown) => Promise<void>) | undefined,
  roleCommands: 0,
  readFailure: undefined as Error | undefined,
  closeFailure: undefined as Error | undefined,
}));
vi.mock("./openclaw-state-worker-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openclaw-state-worker-store.js")>();
  return {
    ...actual,
    runOpenClawStateWorkerOperation: (
      context: Parameters<typeof actual.runOpenClawStateWorkerOperation>[0],
      operation: Parameters<typeof actual.runOpenClawStateWorkerOperation>[1],
      options: Parameters<typeof actual.runOpenClawStateWorkerOperation>[2],
    ) =>
      actual.runOpenClawStateWorkerOperation(
        context,
        (scope) =>
          operation({
            execute: async (command, executeOptions) => {
              if (command.type === "userProfiles.setRole") {
                delivery.roleCommands += 1;
              }
              const result = await scope.execute(command, executeOptions);
              if (command.type === "userProfiles.setRole") {
                const input = command.input;
                if (
                  !isRecord(input) ||
                  !("role" in input) ||
                  (input.role !== null && typeof input.role !== "string")
                ) {
                  throw new Error("Role worker test expected its typed input");
                }
                await delivery.afterResult?.(input.role);
              }
              return result;
            },
          }),
        options,
      ),
  };
});
vi.mock("./openclaw-state-read-worker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openclaw-state-read-worker.js")>();
  return {
    ...actual,
    createOpenClawStateReadTransport: (
      ...args: Parameters<typeof actual.createOpenClawStateReadTransport>
    ) => {
      const owned = actual.createOpenClawStateReadTransport(...args);
      return {
        ...owned,
        read: async (...readArgs: Parameters<typeof owned.read>) => {
          if (delivery.readFailure) {
            throw delivery.readFailure;
          }
          const result = await owned.read(...readArgs);
          await delivery.afterRead?.(result);
          return result;
        },
        close: async () => {
          if (delivery.closeFailure) {
            throw delivery.closeFailure;
          }
          await owned.close();
        },
      };
    },
  };
});

const guard: Extract<UserProfileRoleMutationGuard, { family: "worker" }> = {
  family: "worker",
  requesterReference: null,
  assertCurrent() {},
  assertRequester() {},
};
afterEach(() => {
  delivery.afterResult = undefined;
  delivery.afterRead = undefined;
  delivery.roleCommands = 0;
  delivery.readFailure = undefined;
  delivery.closeFailure = undefined;
  vi.restoreAllMocks();
});

it.each(["ordered", "reversed", "recovery first", "native successor", "native ABA"] as const)(
  "publishes repeated role writes in durable order despite %s receipts",
  async (order) => {
    const state = await createOpenClawTestState({ layout: "state-only", prefix: "role-order-" });
    const first = createDeferredCore();
    const second = createDeferredCore();
    const third = createDeferredCore();
    const releaseThird = createDeferredCore();
    const releaseFirst = createDeferredCore();
    const releaseSecond = createDeferredCore();
    let release = () => {};
    let a: Promise<unknown> | undefined;
    let b: Promise<unknown> | undefined;
    let c: Promise<unknown> | undefined;
    try {
      const profile = ensureProfileForEmail("order@example.test");
      release = retainUserProfileCatalog();
      delivery.afterResult = async (role) => {
        if (role === "first") {
          first.resolve();
          await releaseFirst.promise;
          if (order === "recovery first") {
            throw new Error("synthetic first receipt loss");
          }
        } else if (role === "second") {
          second.resolve();
          await releaseSecond.promise;
        } else {
          third.resolve();
          await releaseThird.promise;
        }
      };
      a = changeUserProfileRole({
        profileId: profile.id,
        role: "first",
        guard,
        onRoleChanged() {},
      });
      void a.catch(() => {});
      await first.promise;
      b = changeUserProfileRole({
        profileId: profile.id,
        role: "second",
        guard,
        onRoleChanged() {},
      });
      await second.promise;
      c = changeUserProfileRole({
        profileId: profile.id,
        role: "third",
        guard,
        onRoleChanged() {},
      });
      await third.promise;
      if (order === "native successor" || order === "native ABA") {
        seedUserProfileRole(profile.id, "native");
        if (order === "native ABA") {
          seedUserProfileRole(profile.id, null);
        }
      }
      if (order === "reversed") {
        releaseThird.resolve();
        await c;
        releaseSecond.resolve();
        await b;
        releaseFirst.resolve();
        await a;
      } else {
        releaseFirst.resolve();
        if (order === "recovery first") {
          await expect(a).rejects.toThrow("synthetic first receipt loss");
        } else {
          await a;
        }
        releaseSecond.resolve();
        await b;
        if (order === "recovery first") {
          expect(readUserProfileIdentity(profile.id)?.role).toBe("third");
        }
        releaseThird.resolve();
        await c;
      }
      const expected =
        order === "native successor" ? "native" : order === "native ABA" ? null : "third";
      expect(getUserProfileRole(profile.id)).toBe(expected);
      expect(readUserProfileIdentity(profile.id)?.role).toBe(expected);
    } finally {
      releaseFirst.resolve();
      releaseSecond.resolve();
      releaseThird.resolve();
      await Promise.allSettled([a, b, c]);
      release();
      await state.cleanup();
    }
  },
);

it("rereads recovery after a newer role admission while its host receipt is held", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "role-recovery-admission-",
  });
  const firstRead = createDeferredCore();
  const releaseFirstRead = createDeferredCore();
  const secondCommitted = createDeferredCore();
  const releaseSecondReceipt = createDeferredCore();
  const reads: unknown[] = [];
  const observed: Array<string | null | undefined> = [];
  const firstEffects = vi.fn();
  const secondEffects = vi.fn();
  let release = () => {};
  let stop = () => {};
  let a: Promise<unknown> | undefined;
  let b: Promise<unknown> | undefined;
  try {
    const profile = ensureProfileForEmail("recovery-admission@example.test");
    release = retainUserProfileCatalog();
    stop = onUserProfilesChanged(() => observed.push(readUserProfileIdentity(profile.id)?.role));
    delivery.afterResult = async (role) => {
      if (role === "first") {
        throw new Error("synthetic first receipt loss");
      }
      secondCommitted.resolve();
      await releaseSecondReceipt.promise;
    };
    delivery.afterRead = async (result) => {
      reads.push(result);
      if (reads.length === 1) {
        firstRead.resolve();
        await releaseFirstRead.promise;
      }
    };
    a = changeUserProfileRole({
      profileId: profile.id,
      role: "first",
      guard,
      onRoleChanged: firstEffects,
    });
    void a.catch(() => {});
    await Promise.race([
      firstRead.promise,
      a.then(() => {
        throw new Error("First role mutation returned before its recovery snapshot");
      }),
    ]);
    expect(reads).toEqual([
      expect.objectContaining({
        value: expect.objectContaining({
          type: "userProfiles.reconcile",
          profile: expect.objectContaining({ role: "first" }),
        }),
      }),
    ]);
    expect(readUserProfileIdentity(profile.id)?.role).toBeNull();
    expect(firstEffects).toHaveBeenCalledExactlyOnceWith(profile.id);

    b = changeUserProfileRole({
      profileId: profile.id,
      role: "second",
      guard,
      onRoleChanged: secondEffects,
    });
    await Promise.race([
      secondCommitted.promise,
      b.then(() => {
        throw new Error("Second role mutation returned before its held receipt");
      }),
    ]);
    expect(getUserProfileRole(profile.id)).toBe("second");
    expect(readUserProfileIdentity(profile.id)?.role).toBeNull();
    expect(secondEffects).not.toHaveBeenCalled();
    expect(delivery.roleCommands).toBe(2);

    releaseFirstRead.resolve();
    await expect(a).rejects.toThrow("synthetic first receipt loss");
    expect(reads).toHaveLength(2);
    expect(reads[1]).toMatchObject({
      value: { type: "userProfiles.reconcile", profile: { role: "second" } },
    });
    expect(observed).toEqual(["second"]);
    expect(readUserProfileIdentity(profile.id)?.role).toBe("second");
    expect(secondEffects).not.toHaveBeenCalled();

    releaseSecondReceipt.resolve();
    await expect(b).resolves.toMatchObject({ id: profile.id, role: "second" });
    expect(getUserProfileRole(profile.id)).toBe("second");
    expect(readUserProfileIdentity(profile.id)?.role).toBe("second");
    expect(observed.every((role) => role === "second")).toBe(true);
    expect(firstEffects).toHaveBeenCalledExactlyOnceWith(profile.id);
    expect(secondEffects).toHaveBeenCalledExactlyOnceWith(profile.id);
    expect(delivery.roleCommands).toBe(2);
    expect(reads).toHaveLength(2);
  } finally {
    releaseFirstRead.resolve();
    releaseSecondReceipt.resolve();
    await Promise.allSettled([a, b]);
    stop();
    release();
    await state.cleanup();
  }
});

it("keeps all six host SQLite methods idle and publishes identity before retained effects", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "role-placement-" });
  let release = () => {};
  try {
    const profile = ensureProfileForEmail("placement@example.test");
    release = retainUserProfileCatalog();
    const { DatabaseSync, StatementSync } = requireNodeSqlite();
    const calls = [
      vi.spyOn(DatabaseSync.prototype, "prepare"),
      vi.spyOn(DatabaseSync.prototype, "exec"),
      ...(["get", "all", "run", "iterate"] as const).map((method) =>
        vi.spyOn(StatementSync.prototype, method),
      ),
    ];
    const onRoleChanged = vi.fn((id: string) => {
      expect(readUserProfileIdentity(id)?.role).toBe("guest");
    });
    const result = await changeUserProfileRole({
      profileId: profile.id,
      role: "guest",
      guard,
      onRoleChanged,
    });
    expect(result).toMatchObject({ id: profile.id, role: "guest" });
    expect(onRoleChanged).toHaveBeenCalledExactlyOnceWith(profile.id);
    expect(calls.map((call) => call.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
    calls.forEach((call) => call.mockRestore());
  } finally {
    vi.restoreAllMocks();
    release();
    await state.cleanup();
  }
});

it.each(["accepted abort", "lost receipt", "failed recovery", "failed retirement"] as const)(
  "retains committed role effects through %s and close",
  async (fault) => {
    const state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "role-settlement-",
    });
    let release = () => {};
    let closing: Promise<unknown> | undefined;
    const controller = new AbortController();
    const onRoleChanged = vi.fn();
    try {
      const profile = ensureProfileForEmail("settlement@example.test");
      const pathname = openOpenClawStateDatabase().path;
      release = retainUserProfileCatalog();
      delivery.afterResult = async () => {
        controller.abort(new Error("synthetic accepted cancellation"));
        closing = closeOpenClawStateDatabaseByPathAsync(pathname);
        void closing.catch(() => {});
        if (fault !== "accepted abort") {
          throw new Error("synthetic result delivery failure");
        }
      };
      if (fault === "failed recovery") {
        delivery.readFailure = new Error("synthetic recovery failure");
      }
      if (fault === "failed retirement") {
        delivery.closeFailure = new Error("synthetic recovery retirement failure");
      }
      const pending = changeUserProfileRole({
        profileId: profile.id,
        role: "guest",
        guard,
        onRoleChanged,
        signal: controller.signal,
      });
      if (fault === "accepted abort") {
        await expect(pending).resolves.toMatchObject({ role: "guest" });
      } else {
        await expect(pending).rejects.toThrow();
      }
      if (fault === "failed recovery" || fault === "failed retirement") {
        await expect(closing).rejects.toThrow();
        expect(onRoleChanged).toHaveBeenCalledExactlyOnceWith(profile.id);
        expect(() =>
          acquireStateDatabaseHandleExclusion({ databasePath: pathname, busyTimeoutMs: 0 }),
        ).toThrow();
        delivery.readFailure = undefined;
        delivery.closeFailure = undefined;
        await closeOpenClawStateDatabaseByPathAsync(pathname);
      } else {
        await closing;
      }
      expect(onRoleChanged).toHaveBeenCalledExactlyOnceWith(profile.id);
      expect(readUserProfileIdentity(profile.id)?.role).toBe("guest");
      expect(getUserProfileRole(profile.id)).toBe("guest");
    } finally {
      delivery.readFailure = undefined;
      delivery.closeFailure = undefined;
      await Promise.allSettled([closing]);
      release();
      await state.cleanup();
    }
  },
);

it("does not publish a refused legacy-role mutation after rolling schema preparation back", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "role-legacy-refusal-",
  });
  let release = () => {};
  let stop = () => {};
  try {
    const db = createLegacyUserProfilesTable();
    const profile = ensureProfileForEmail("legacy@example.test");
    expect(tableHasColumn(db, "user_profiles", "role")).toBe(false);
    release = retainUserProfileCatalog();
    const changed = vi.fn();
    stop = onUserProfilesChanged(changed);
    const onRoleChanged = vi.fn();
    let checks = 0;
    await expect(
      changeUserProfileRole({
        profileId: profile.id,
        role: "guest",
        onRoleChanged,
        guard: {
          ...guard,
          assertRequester() {
            if (++checks === 2) {
              throw new Error("synthetic commit refusal");
            }
          },
        },
      }),
    ).rejects.toThrow("synthetic commit refusal");
    expect(checks).toBe(2);
    expect(tableHasColumn(db, "user_profiles", "role")).toBe(false);
    expect(readUserProfileIdentity(profile.id)?.role).toBeNull();
    expect(changed).not.toHaveBeenCalled();
    expect(onRoleChanged).not.toHaveBeenCalled();
  } finally {
    stop();
    release();
    await state.cleanup();
  }
});

it("keeps native profile responses current after a worker adds the optional role column", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "role-host-schema-",
  });
  try {
    const db = createLegacyUserProfilesTable();
    const profile = ensureProfileForEmail("host-schema@example.test");
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    expect(tableHasColumn(db, "user_profiles", "role")).toBe(false);
    await changeUserProfileRole({
      profileId: profile.id,
      role: "guest",
      guard,
      onRoleChanged() {},
    });
    expect(getUserProfileListItem(profile.id)).toMatchObject({ role: "guest" });
    expect(setDisplayName(profile.id, "After assignment")).toMatchObject({ role: "guest" });
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(version);
  } finally {
    await state.cleanup();
  }
});
