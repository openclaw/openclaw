import { afterEach, expect, it, vi } from "vitest";
import type { SqliteWorkerOperationSettlement } from "../infra/sqlite-worker-operation-settlement.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { ensureProfileIdForEmail } from "./user-profile-email.js";
import { readUserProfileVersion } from "./user-profile-events.js";
import { readUserProfileEmailBindings } from "./user-profile-identity.read.js";
import {
  prepareUserProfileIdentity,
  readResidentUserProfileId,
  prepareUserProfileCatalog,
} from "./user-profile-list.js";
import { linkCanonicalUserProfileEmail } from "./user-profile-writes.js";
import { linkEmail } from "./user-profile-writes.worker.js";
import { ensureProfileForEmail, ensureProfileForTailscaleIdentity } from "./user-profiles.js";

const delivery = vi.hoisted(() => ({
  afterResult: undefined as (() => void) | undefined,
  heldSettlement: undefined as
    | {
        observed: (settlement: SqliteWorkerOperationSettlement) => void;
        resume: Promise<void>;
      }
    | undefined,
}));
vi.mock("./openclaw-state-worker-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openclaw-state-worker-store.js")>();
  return {
    ...actual,
    runOpenClawStateWorkerOperation: (
      context: Parameters<typeof actual.runOpenClawStateWorkerOperation>[0],
      operation: Parameters<typeof actual.runOpenClawStateWorkerOperation>[1],
      options: Parameters<typeof actual.runOpenClawStateWorkerOperation>[2],
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
afterEach(() => {
  delivery.afterResult = undefined;
  delivery.heldSettlement = undefined;
});

it.each(["lost during close", "after alias reassignment"] as const)(
  "publishes current email bindings when the creation reply arrives %s",
  async (reply) => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const pathname = openOpenClawStateDatabase().path;
      const existing = ensureProfileForEmail("existing@example.test");
      const retained = await prepareUserProfileIdentity(existing.id);
      const release = (await prepareUserProfileCatalog()).release;
      let closing: ReturnType<typeof closeOpenClawStateDatabaseByPathAsync> | undefined;
      let originalBinding: string | null | undefined;
      try {
        const before = readUserProfileVersion();
        delivery.afterResult = () => {
          if (reply === "lost during close") {
            closing = closeOpenClawStateDatabaseByPathAsync(pathname);
            throw new Error("synthetic profile result loss");
          }
          const created = ensureProfileForEmail("new@example.test");
          originalBinding = readUserProfileEmailBindings(
            openOpenClawStateDatabase().db,
            created.id,
          )[0]?.bindingId;
          linkEmail("retained@example.test", created.id);
          linkEmail("new@example.test", existing.id);
          linkEmail("new@example.test", created.id);
        };
        let profileId: string;
        if (reply === "lost during close") {
          await expect(ensureProfileIdForEmail("new@example.test")).rejects.toThrow(
            "synthetic profile result loss",
          );
          await closing;
          profileId = ensureProfileForEmail("new@example.test").id;
          expect(readResidentUserProfileId(profileId)).toBe(profileId);
          expect(readUserProfileVersion()).toBe(before + 1);
        } else {
          profileId = await ensureProfileIdForEmail("new@example.test");
          expect(originalBinding).toEqual(expect.any(String));
        }
        const current = await prepareUserProfileIdentity(profileId);
        try {
          if (reply === "lost during close") {
            expect(current.emailBindingIds).toEqual([expect.any(String)]);
          } else {
            expect(current.emailBindingIds).toHaveLength(2);
            expect(current.emailBindingIds).not.toContain(originalBinding);
            expect(() => current.readCurrentFacts([originalBinding!])).toThrow(
              "user profile not found",
            );
          }
          expect(() => current.readCurrentFacts(current.emailBindingIds)).not.toThrow();
        } finally {
          current.release();
        }
      } finally {
        await closing;
        release();
        retained.release();
      }
    });
  },
);

it.each(["native supersession", "accepted precursor"] as const)(
  "publishes the latest binding and canonical profile after %s",
  async (order) => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const email = "moving@example.test";
      const source = ensureProfileForEmail(email);
      linkEmail("source-retained@example.test", source.id);
      const target =
        order === "native supersession"
          ? ensureProfileForEmail("target-retained@example.test")
          : ensureProfileForTailscaleIdentity({ login: "target@github" });
      const sourceReader = await prepareUserProfileIdentity(source.id);
      const targetReader = await prepareUserProfileIdentity(target.id);
      const database = openOpenClawStateDatabase();
      const held: Array<{
        release: () => void;
        result: ReturnType<typeof linkCanonicalUserProfileEmail>;
      }> = [];
      const holdLink = async (profileId: string) => {
        const settled = createDeferredCore<SqliteWorkerOperationSettlement>();
        const publication = createDeferredCore();
        delivery.heldSettlement = { observed: settled.resolve, resume: publication.promise };
        const result = linkCanonicalUserProfileEmail(email, profileId);
        delivery.heldSettlement = undefined;
        const pending = { release: publication.resolve, result };
        held.push(pending);
        await expect(
          Promise.race([settled.promise, result.then(() => undefined)]),
        ).resolves.toMatchObject({ kind: "completed" });
        return pending;
      };
      try {
        const initial = readUserProfileEmailBindings(database.db, source.id).find(
          (binding) => binding.email === email,
        );
        if (!initial?.bindingId) {
          throw new Error("Expected the original email binding");
        }
        const initialBindingId = initial.bindingId;
        const sourceBindings = sourceReader.emailBindingIds.filter((id) => id !== initialBindingId);
        const targetBindings = targetReader.emailBindingIds;
        const first = await holdLink(target.id);
        if (order === "native supersession") {
          linkEmail(email, source.id);
        }
        const finalProfileId = order === "native supersession" ? target.id : source.id;
        const second = await holdLink(finalProfileId);
        const committed = readUserProfileEmailBindings(database.db, finalProfileId).find(
          (binding) => binding.email === email,
        );
        if (!committed?.bindingId) {
          throw new Error("Expected the latest committed email binding");
        }
        first.release();
        await first.result;
        second.release();
        await second.result;

        const native = vi.spyOn(database.db, "prepare");
        try {
          const current = order === "native supersession" ? targetReader : sourceReader;
          expect(current.readCurrentFacts([committed.bindingId]).profile.emails).toContain(email);
          expect(() => sourceReader.readCurrentFacts([initialBindingId])).toThrow(
            "user profile not found",
          );
          expect(() => sourceReader.readCurrentFacts(sourceBindings)).not.toThrow();
          if (order === "accepted precursor") {
            expect(() => targetReader.readCurrentFacts()).toThrow("user profile not found");
          } else {
            expect(targetReader.readCurrentFacts(targetBindings).profile.emails).toEqual([
              email,
              "target-retained@example.test",
            ]);
            expect(sourceReader.readCurrentFacts().profile.emails).toEqual([
              "source-retained@example.test",
            ]);
          }
          expect(native).not.toHaveBeenCalled();
        } finally {
          native.mockRestore();
        }
      } finally {
        delivery.heldSettlement = undefined;
        for (const pending of held) {
          pending.release();
        }
        await Promise.allSettled(held.map((pending) => pending.result));
        sourceReader.release();
        targetReader.release();
      }
    });
  },
);
