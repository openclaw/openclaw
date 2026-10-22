import { afterEach, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import type { SqliteWorkerOperationSettlement as Settlement } from "../infra/sqlite-worker-operation-settlement.js";
import { createDeferredCore } from "../shared/deferred.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  closeOpenClawStateDatabaseByPathAsync as closeDatabase,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { ensureProfileIdForEmail } from "./user-profile-email.js";
import { onUserProfilesChanged, readUserProfileVersion } from "./user-profile-events.js";
import { readUserProfileEmailBindings } from "./user-profile-identity.read.js";
import { getUserProfileListItem } from "./user-profile-list-item.test-support.js";
import {
  prepareUserProfileIdentity as prepareIdentity,
  readResidentUserProfileId,
  readResidentUserProfileIdentity,
  prepareUserProfileCatalog,
} from "./user-profile-list.js";
import {
  linkCanonicalUserProfileEmail as linkCanonicalEmail,
  setCanonicalUserProfileRole,
} from "./user-profile-writes.js";
import { linkEmail, setUserProfileRole } from "./user-profile-writes.worker.js";
import { useProfileState } from "./user-profiles-fixture.test-support.js";
import { ensureProfileForEmail, ensureProfileForTailscaleIdentity } from "./user-profiles.js";

const delivery = vi.hoisted(() => ({
  afterResult: undefined as (() => void) | undefined,
  afterRoleResult: undefined as ((index: number) => Promise<void>) | undefined,
  roleCommands: 0,
  heldSettlement: undefined as
    | {
        observed: (settlement: Settlement) => void;
        resume: Promise<void>;
      }
    | undefined,
}));
vi.mock("./openclaw-state-worker-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openclaw-state-worker-store.js")>();
  return {
    ...actual,
    runOpenClawStateWorkerOperation: (
      ...[context, operation, options]: Parameters<typeof actual.runOpenClawStateWorkerOperation>
    ) => {
      const held = delivery.heldSettlement;
      const createAdmission = options?.createAdmission;
      if (held && !createAdmission) {
        throw new Error("Expected canonical profile write admission");
      }
      return actual.runOpenClawStateWorkerOperation(
        context,
        (scope) =>
          operation({
            execute: async (command, executeOptions) => {
              const result = await scope.execute(command, executeOptions);
              if (command.type === "userProfiles.ensureEmail") {
                delivery.afterResult?.();
              } else if (command.type === "userProfiles.setRole") {
                await delivery.afterRoleResult?.(delivery.roleCommands++);
              }
              return result;
            },
          }),
        held && createAdmission
          ? {
              ...options,
              createAdmission: (retained) =>
                createAdmission({
                  settled: retained.settled.then(async (settlement) => {
                    held.observed(settlement);
                    await held.resume;
                    return settlement;
                  }),
                }),
            }
          : options,
      );
    },
  };
});
const catalog = useProfileState();
afterEach(() => {
  vi.restoreAllMocks();
  delivery.afterResult = undefined;
  delivery.afterRoleResult = undefined;
  delivery.roleCommands = 0;
  delivery.heldSettlement = undefined;
});

const notFound = "user profile not found";
const resultLost = "synthetic profile result loss";
function bindingId(profileId: string, email: string) {
  const binding = readUserProfileEmailBindings(openOpenClawStateDatabase().db, profileId).find(
    (entry) => entry.email === email,
  )?.bindingId;
  if (!binding) {
    throw new Error("Expected committed email binding");
  }
  return binding;
}

it.each(["lost during close", "after alias reassignment"] as const)(
  "publishes current email bindings when the creation reply arrives %s",
  async (reply) => {
    const email = "new@example.test";
    const pathname = openOpenClawStateDatabase().path;
    const existing = ensureProfileForEmail("existing@example.test");
    const retained = await prepareIdentity(existing.id);
    const release = (await prepareUserProfileCatalog()).release;
    let closing: ReturnType<typeof closeDatabase> | undefined;
    let originalBinding: string | null | undefined;
    let releaseCurrent: (() => void) | undefined;
    try {
      const before = readUserProfileVersion();
      delivery.afterResult = () => {
        if (reply === "lost during close") {
          closing = closeDatabase(pathname);
          throw new Error(resultLost);
        }
        const created = ensureProfileForEmail(email);
        originalBinding = bindingId(created.id, email);
        linkEmail("retained@example.test", created.id);
        linkEmail(email, existing.id);
        linkEmail(email, created.id);
      };
      let profileId: string;
      if (reply === "lost during close") {
        await expect(ensureProfileIdForEmail(email)).rejects.toThrow(resultLost);
        await closing;
        profileId = ensureProfileForEmail(email).id;
        expect(readResidentUserProfileId(profileId)).toBe(profileId);
        expect(readUserProfileVersion()).toBe(before + 1);
      } else {
        profileId = await ensureProfileIdForEmail(email);
        expect(originalBinding).toEqual(expect.any(String));
      }
      const current = await prepareIdentity(profileId);
      releaseCurrent = current.release;
      if (reply === "lost during close") {
        expect(current.emailBindingIds).toEqual([expect.any(String)]);
      } else {
        expect(current.emailBindingIds).toHaveLength(2);
        expect(current.emailBindingIds).not.toContain(originalBinding);
        expect(() => current.readCurrentFacts([originalBinding!])).toThrow(notFound);
      }
      expect(() => current.readCurrentFacts(current.emailBindingIds)).not.toThrow();
    } finally {
      releaseCurrent?.();
      await closing;
      release();
      retained.release();
    }
  },
);

it.each(["native supersession", "accepted precursor"] as const)(
  "publishes the latest binding and canonical profile after %s",
  async (order) => {
    const email = "moving@example.test";
    const sourceEmail = "source-retained@example.test";
    const targetEmail = "target-retained@example.test";
    const source = ensureProfileForEmail(email);
    linkEmail(sourceEmail, source.id);
    const target =
      order === "native supersession"
        ? ensureProfileForEmail(targetEmail)
        : ensureProfileForTailscaleIdentity({ login: "target@github" });
    const sourceReader = await prepareIdentity(source.id);
    const targetReader = await prepareIdentity(target.id);
    const held: Array<() => Promise<void>> = [];
    const holdLink = async (profileId: string) => {
      const settled = createDeferredCore<Settlement>();
      const publication = createDeferredCore();
      delivery.heldSettlement = { observed: settled.resolve, resume: publication.promise };
      const result = linkCanonicalEmail(email, profileId);
      delivery.heldSettlement = undefined;
      held.push(async () => {
        publication.resolve();
        await result;
      });
      await expect(
        Promise.race([settled.promise, result.then(() => undefined)]),
      ).resolves.toMatchObject({ kind: "completed" });
      return { release: publication.resolve, result };
    };
    try {
      const initialBindingId = bindingId(source.id, email);
      const sourceBindings = sourceReader.emailBindingIds.filter((id) => id !== initialBindingId);
      const targetBindings = targetReader.emailBindingIds;
      const first = await holdLink(target.id);
      if (order === "native supersession") {
        linkEmail(email, source.id);
      }
      const finalProfileId = order === "native supersession" ? target.id : source.id;
      const second = await holdLink(finalProfileId);
      const committed = bindingId(finalProfileId, email);
      first.release();
      await first.result;
      second.release();
      await second.result;

      const native = vi.spyOn(openOpenClawStateDatabase().db, "prepare");
      const current = order === "native supersession" ? targetReader : sourceReader;
      expect(current.readCurrentFacts([committed]).profile.emails).toContain(email);
      expect(() => sourceReader.readCurrentFacts([initialBindingId])).toThrow(notFound);
      expect(() => sourceReader.readCurrentFacts(sourceBindings)).not.toThrow();
      if (order === "accepted precursor") {
        expect(() => targetReader.readCurrentFacts()).toThrow(notFound);
      } else {
        expect([
          targetReader.readCurrentFacts(targetBindings).profile.emails,
          sourceReader.readCurrentFacts().profile.emails,
        ]).toEqual([[email, targetEmail], [sourceEmail]]);
      }
      expect(native).not.toHaveBeenCalled();
    } finally {
      delivery.heldSettlement = undefined;
      await Promise.allSettled(held.map((release) => release()));
      sourceReader.release();
      targetReader.release();
    }
  },
);

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
      delivery.afterRoleResult = async (index) => {
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
    let closing: ReturnType<typeof closeDatabase> | undefined;
    try {
      const profile = ensureProfileForEmail("role-placement@example.test");
      const pathname = openOpenClawStateDatabase().path;
      await catalog.hydrate();
      const observed: Array<string | null | undefined> = [];
      stop = onUserProfilesChanged(() => {
        observed.push(readResidentUserProfileIdentity(profile.id)?.role);
      });
      if (reply === "lost during close") {
        delivery.afterRoleResult = async () => {
          closing = closeDatabase(pathname);
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
