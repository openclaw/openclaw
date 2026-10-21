import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { assertExistingOpenClawStateRuntimeSchema as assertRuntimeSchema } from "./openclaw-state-db-existing-schema.js";
import { ensureSecretStoreSchema } from "./openclaw-state-db-schema-additive.js";
import {
  closeOpenClawStateDatabaseByPathAsync as closeDatabase,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext as captureContext } from "./openclaw-state-worker-context.js";
import { readProfileAuthority as readAuthority } from "./user-profile-authority.js";
import {
  captureUserProfileAuthorityRead as captureAuthority,
  fenceUserProfileMutationAuthority as fenceAuthority,
} from "./user-profile-events.js";
import { setUserProfileRole } from "./user-profile-writes.worker.js";
import { ensureProfileForEmail } from "./user-profiles.js";
import { useUserStateFixture } from "./user-state.test-support.js";

const stateOptions = useUserStateFixture("profile-authority-");
type Status = ReturnType<typeof readAuthority>;
const expectRetired = (...descriptors: Parameters<typeof readAuthority>[0][]) =>
  expect(descriptors.map(readAuthority)).toEqual(descriptors.map(() => "revoked"));

async function fixture(validateSchema = false) {
  const options = stateOptions();
  const profile = ensureProfileForEmail("person@example.test", options);
  const other = ensureProfileForEmail("other@example.test", options);
  const context = captureContext(options);
  if (validateSchema) {
    const native = requireNativeSqliteDatabase(openOpenClawStateDatabase(options).db);
    assertRuntimeSchema(native, options.path, context.stateIntegrity);
  }
  const authority = await captureAuthority(context.admission);
  const bound = authority.bind(profile.id)!;
  const unrelated = authority.bind(other.id)!;
  const settled = authority.transferSettled(profile.id);
  const check = (binding: Status, settlement: Status) => {
    const actual = [bound(), readAuthority(bound.transferable), readAuthority(settled)];
    expect(actual).toEqual([binding === "current", binding, settlement]);
    expect(unrelated()).toBe(true);
  };
  return { options, profile, context, authority, bound, unrelated, settled, check };
}

it("preserves profile authority through unrelated feature schema admission", async () => {
  const { options, profile, authority, bound, check } = await fixture(true);
  const { db } = openOpenClawStateDatabase(options);
  const checkSchema = () => {
    runOpenClawStateWriteTransaction(() => ensureSecretStoreSchema(db), options);
    check("current", "current");
    expect(() => authority.assertSettled(profile.id)).not.toThrow();
  };
  expect(bound()).toBe(true);
  checkSchema();

  const repeatedDdl: string[] = [];
  const observation = observeHostDataSql((sql, database) => {
    if (database === db && /\b(?:CREATE|ALTER|DROP)\b/iu.test(sql)) {
      repeatedDdl.push(sql);
    }
  });
  try {
    checkSchema();
    expect(repeatedDdl).toEqual([]);
  } finally {
    observation.restore();
  }

  setUserProfileRole(profile.id, "member", options);
  check("revoked", "current");
});

it.each([false, true])(
  "fences transferred readers before native COMMIT (rollback=%s)",
  async (rollback) => {
    const { options, profile, check } = await fixture();
    const { db } = openOpenClawStateDatabase(options);
    const execute = db.exec.bind(db);
    let commits = 0;
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql === "COMMIT") {
        commits += 1;
        check("pending", "pending");
        if (rollback) {
          throw new Error("synthetic native COMMIT refusal");
        }
      }
      return execute(sql);
    });
    const mutate = () =>
      runOpenClawStateWriteTransaction(() => {
        setUserProfileRole(profile.id, "member", options);
        check("current", "current");
      }, options);
    if (rollback) {
      expect(mutate).toThrow("synthetic native COMMIT refusal");
    } else {
      mutate();
    }
    expect(commits).toBe(1);
    check(rollback ? "current" : "revoked", "current");
  },
);

it("keeps unknown native COMMIT authority closed before disposing the connection", async () => {
  const { options, profile, bound, settled } = await fixture();
  const { db } = openOpenClawStateDatabase(options);
  const execute = db.exec.bind(db);
  const close = db.close.bind(db);
  let beforeClose: Status | undefined;
  vi.spyOn(db, "close").mockImplementation(() => {
    beforeClose = readAuthority(settled);
    return close();
  });
  vi.spyOn(db, "exec").mockImplementation((sql) => {
    if (sql === "ROLLBACK") {
      throw new Error("synthetic unavailable rollback");
    }
    const result = execute(sql);
    if (sql === "COMMIT") {
      throw new Error("synthetic lost COMMIT outcome");
    }
    return result;
  });
  expect(() => setUserProfileRole(profile.id, "member", options)).toThrow(
    "synthetic lost COMMIT outcome",
  );
  expect([beforeClose, bound()]).toEqual(["uncertain", false]);
  expect(readAuthority(settled)).not.toBe("current");
});

it("keeps exact bindings retired while current-fact readers follow known settlement", async () => {
  const { context, profile, authority, check } = await fixture();
  const fence = () =>
    fenceAuthority(context.admission, {
      profiles: [profile.id],
      identities: [],
      channels: [],
    });
  const mutation = fence();
  check("revoked", "pending");
  mutation.settle(true);
  check("revoked", "current");
  expect(() => authority.assertSettled(profile.id)).not.toThrow();

  const unknown = fence();
  unknown.settle(false);
  unknown.settle(true);
  check("revoked", "uncertain");
  expect(() => authority.assertSettled(profile.id)).toThrow("requires canonical recovery");
});

it("rejects late registration after retirement and never revives a previous store generation", async () => {
  const { options, profile, bound, settled } = await fixture();
  await closeDatabase(options.path);
  const late = structuredClone(bound.transferable);
  expectRetired(late, settled);
  openOpenClawStateDatabase(options);
  const replacement = await captureAuthority(captureContext(options).admission);
  const current = replacement.bind(profile.id)!;
  expect(readAuthority(current.transferable)).toBe("current");
  expectRetired(late);
  expect(current.transferable.generation).not.toBe(late.generation);
});

it("retires pre-creation authority when the same admission becomes a physical file", async () => {
  const options = stateOptions();
  const context = captureContext(options);
  expect(context.admission.identity.key).toMatch(/^path:/);
  const before = await captureAuthority(context.admission);
  const boundBefore = before.bind("not-created-yet")!;
  const transferredBefore = before.transferSettled("not-created-yet");

  const profile = ensureProfileForEmail("created@example.test", options);
  context.admission.assertCurrent();
  expect(context.admission.identity.key).toMatch(/^file:/);
  expect([boundBefore(), before.bind(profile.id)]).toEqual([false, undefined]);
  expect(() => before.assertSettled(profile.id)).toThrow("Profile authority store changed");
  expectRetired(transferredBefore, boundBefore.transferable);

  const after = await captureAuthority(context.admission);
  const boundAfter = after.bind(profile.id)!;
  expect(boundAfter()).toBe(true);
  setUserProfileRole(profile.id, "member", options);
  expect(boundAfter()).toBe(false);
  expectRetired(boundAfter.transferable);
});
