import { afterEach, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createDeferredCore } from "../shared/deferred.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { onUserProfilesChanged } from "./user-profile-events.js";
import { getUserProfileListItem } from "./user-profile-list-item.test-support.js";
import { readResidentUserProfileIdentity } from "./user-profile-list.js";
import { setCanonicalUserProfileRole } from "./user-profile-writes.js";
import { setUserProfileRole } from "./user-profile-writes.worker.js";
import { useProfileState } from "./user-profiles-fixture.test-support.js";
import { ensureProfileForEmail } from "./user-profiles.js";

const delivery = vi.hoisted(() => ({
  afterResult: undefined as ((index: number) => Promise<void>) | undefined,
  roleCommands: 0,
}));
vi.mock("./openclaw-state-worker-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openclaw-state-worker-store.js")>();
  return {
    ...actual,
    runOpenClawStateWorkerOperation: vi
      .fn(actual.runOpenClawStateWorkerOperation)
      .mockImplementation((context, operation, options) =>
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
      ),
  };
});

const catalog = useProfileState();
afterEach(() => {
  delivery.afterResult = undefined;
  delivery.roleCommands = 0;
  vi.restoreAllMocks();
});

it.each(["ordered", "reversed", "recovery first", "native successor", "native ABA"] as const)(
  "preserves durable role order through %s result delivery",
  async (order) => {
    const gates = Array.from({ length: 3 }, () => ({
      received: createDeferredCore(),
      resume: createDeferredCore(),
    }));
    const pending: Array<ReturnType<typeof setCanonicalUserProfileRole>> = [];
    const lostDelivery = new Error("synthetic first role result delivery failure");
    try {
      const profile = ensureProfileForEmail("role-order@example.test");
      await catalog.hydrate();
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
      expect(getUserProfileListItem(profile.id).role ?? null).toBe(expected);
      expect(readResidentUserProfileIdentity(profile.id)?.role).toBe(expected);
    } finally {
      for (const gate of gates) {
        gate.resume.resolve();
      }
      await Promise.allSettled(pending);
      catalog.release();
    }
  },
);

it.each(["delivered", "lost during close"] as const)(
  "publishes committed roles before observers when the reply is %s",
  async (reply) => {
    const lostDelivery = new Error("synthetic committed role result delivery failure");
    let stop = () => {};
    let closing: ReturnType<typeof closeOpenClawStateDatabaseByPathAsync> | undefined;
    try {
      const profile = ensureProfileForEmail("role-placement@example.test");
      const pathname = openOpenClawStateDatabase().path;
      await catalog.hydrate();
      const observed: Array<string | null | undefined> = [];
      stop = onUserProfilesChanged(() => {
        observed.push(readResidentUserProfileIdentity(profile.id)?.role);
      });
      if (reply === "lost during close") {
        delivery.afterResult = async () => {
          closing = closeOpenClawStateDatabaseByPathAsync(pathname);
          void closing.catch(() => {});
          throw lostDelivery;
        };
        await expect(setCanonicalUserProfileRole(profile.id, "guest")).rejects.toBe(lostDelivery);
        await closing;
        expect(delivery.roleCommands).toBe(1);
      } else {
        requireNodeSqlite();
        const sql = observeMainThreadSql();
        await expect(setCanonicalUserProfileRole(profile.id, "guest")).resolves.toMatchObject({
          id: profile.id,
          role: "guest",
        });
        sql.expectIdle();
      }
      expect(observed).toEqual(["guest"]);
      vi.restoreAllMocks();
      if (reply === "lost during close") {
        catalog.release();
        await catalog.hydrate();
      }
      expect(readResidentUserProfileIdentity(profile.id)?.role).toBe("guest");
      expect(getUserProfileListItem(profile.id).role).toBe("guest");
    } finally {
      vi.restoreAllMocks();
      await Promise.allSettled([closing]);
      stop();
      catalog.release();
    }
  },
);
