import { afterEach, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { onUserProfilesChanged } from "./user-profile-events.js";
import { readUserProfileIdentity, retainUserProfileCatalog } from "./user-profile-list.js";
import { setCanonicalUserProfileRole } from "./user-profile-writes.js";
import { ensureProfileForEmail, getUserProfileRole, setUserProfileRole } from "./user-profiles.js";

const delivery = vi.hoisted(() => ({
  afterResult: undefined as ((index: number) => Promise<void>) | undefined,
  roleCommands: 0,
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
              const result = await scope.execute(command, executeOptions);
              if (command.type === "userProfiles.setRole") {
                await delivery.afterResult?.(delivery.roleCommands++);
              }
              return result;
            },
          }),
        options,
      ),
  };
});

afterEach(() => {
  delivery.afterResult = undefined;
  delivery.roleCommands = 0;
  vi.restoreAllMocks();
});

it.each(["ordered", "reversed", "recovery first", "native successor", "native ABA"] as const)(
  "preserves durable role order through %s result delivery",
  async (order) => {
    const state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "canonical-role-order-",
    });
    const gates = Array.from({ length: 3 }, () => ({
      received: createDeferredCore(),
      resume: createDeferredCore(),
    }));
    const pending: Array<ReturnType<typeof setCanonicalUserProfileRole>> = [];
    const lostDelivery = new Error("synthetic first role result delivery failure");
    let release = () => {};
    try {
      const profile = ensureProfileForEmail("role-order@example.test");
      release = retainUserProfileCatalog();
      delivery.afterResult = async (index) => {
        const gate = gates[index]!;
        gate.received.resolve();
        await gate.resume.promise;
        if (index === 0 && order === "recovery first") {
          throw lostDelivery;
        }
      };
      for (const [index, role] of ["first", "second", "third"].entries()) {
        const mutation = setCanonicalUserProfileRole(profile.id, role);
        pending.push(mutation);
        void mutation.catch(() => {});
        await Promise.race([
          gates[index]!.received.promise,
          mutation.then(() => {
            throw new Error("Role mutation returned before its held result");
          }),
        ]);
      }
      expect(delivery.roleCommands).toBe(3);
      if (order === "native successor" || order === "native ABA") {
        setUserProfileRole(profile.id, "native");
        if (order === "native ABA") {
          setUserProfileRole(profile.id, null);
        }
      }
      const expected =
        order === "native successor" ? "native" : order === "native ABA" ? null : "third";
      const indexes = order === "reversed" ? [2, 1, 0] : [0, 1, 2];
      for (const index of indexes) {
        gates[index]!.resume.resolve();
        if (index === 0 && order === "recovery first") {
          await expect(pending[index]).rejects.toBe(lostDelivery);
        } else {
          await expect(pending[index]).resolves.toMatchObject({
            id: profile.id,
            role: ["first", "second", "third"][index],
          });
        }
      }
      expect(getUserProfileRole(profile.id)).toBe(expected);
      expect(readUserProfileIdentity(profile.id)?.role).toBe(expected);
    } finally {
      for (const gate of gates) {
        gate.resume.resolve();
      }
      await Promise.allSettled(pending);
      release();
      await state.cleanup();
    }
  },
);

it("keeps all six host SQLite methods idle and publishes the role before observers", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "canonical-role-placement-",
  });
  let release = () => {};
  let stop = () => {};
  try {
    const profile = ensureProfileForEmail("role-placement@example.test");
    release = retainUserProfileCatalog();
    const observed: Array<string | null | undefined> = [];
    stop = onUserProfilesChanged(() => {
      observed.push(readUserProfileIdentity(profile.id)?.role);
    });
    const { DatabaseSync, StatementSync } = requireNodeSqlite();
    const calls = [
      vi.spyOn(DatabaseSync.prototype, "prepare"),
      vi.spyOn(DatabaseSync.prototype, "exec"),
      ...(["get", "all", "run", "iterate"] as const).map((method) =>
        vi.spyOn(StatementSync.prototype, method),
      ),
    ];
    await expect(setCanonicalUserProfileRole(profile.id, "guest")).resolves.toMatchObject({
      id: profile.id,
      role: "guest",
    });
    expect(observed).toEqual(["guest"]);
    expect(calls.map((call) => call.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
  } finally {
    vi.restoreAllMocks();
    stop();
    release();
    await state.cleanup();
  }
});

it("settles a committed role and its catalog when result delivery fails during close", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "canonical-role-result-loss-",
  });
  const lostDelivery = new Error("synthetic committed role result delivery failure");
  let release = () => {};
  let stop = () => {};
  let closing: ReturnType<typeof closeOpenClawStateDatabaseByPathAsync> | undefined;
  try {
    const profile = ensureProfileForEmail("role-result-loss@example.test");
    const pathname = openOpenClawStateDatabase().path;
    release = retainUserProfileCatalog();
    const observed: Array<string | null | undefined> = [];
    stop = onUserProfilesChanged(() => {
      observed.push(readUserProfileIdentity(profile.id)?.role);
    });
    delivery.afterResult = async () => {
      closing = closeOpenClawStateDatabaseByPathAsync(pathname);
      void closing.catch(() => {});
      throw lostDelivery;
    };
    await expect(setCanonicalUserProfileRole(profile.id, "guest")).rejects.toBe(lostDelivery);
    await closing;
    expect(delivery.roleCommands).toBe(1);
    expect(observed).toEqual(["guest"]);
    expect(readUserProfileIdentity(profile.id)?.role).toBe("guest");
    expect(getUserProfileRole(profile.id)).toBe("guest");
  } finally {
    await Promise.allSettled([closing]);
    stop();
    release();
    await state.cleanup();
  }
});
