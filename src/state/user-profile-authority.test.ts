import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { assertExistingOpenClawStateRuntimeSchema } from "./openclaw-state-db-existing-schema.js";
import { ensureSecretStoreSchema } from "./openclaw-state-db-schema-additive.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { readProfileAuthority } from "./user-profile-authority.js";
import {
  captureUserProfileAuthorityRead,
  fenceUserProfileMutationAuthority,
} from "./user-profile-events.js";
import { setUserProfileRole } from "./user-profile-writes.worker.js";
import { ensureProfileForEmail } from "./user-profiles.js";

const paths: string[] = [];
const roots = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const pathname of paths.splice(0)) {
      await closeOpenClawStateDatabaseByPathAsync(pathname);
    }
    cleanup();
  });
});

async function fixture() {
  const options = { path: path.join(roots.make("profile-authority-"), "openclaw.sqlite") };
  paths.push(options.path);
  const profile = ensureProfileForEmail("person@example.test", options);
  const other = ensureProfileForEmail("other@example.test", options);
  const context = captureOpenClawStateWorkerContext(options);
  const authority = await captureUserProfileAuthorityRead(context.admission);
  const bound = authority.bind(profile.id)!;
  const unrelated = authority.bind(other.id)!;
  const settled = authority.transferSettled(profile.id);
  return { options, profile, context, authority, bound, unrelated, settled };
}

it("preserves profile authority through unrelated feature schema admission", async () => {
  const { options, profile, context } = await fixture();
  const { db } = openOpenClawStateDatabase(options);
  assertExistingOpenClawStateRuntimeSchema(db, options.path, context.stateIntegrity);
  const authority = await captureUserProfileAuthorityRead(context.admission);
  const bound = authority.bind(profile.id)!;
  const settled = authority.transferSettled(profile.id);
  expect(bound()).toBe(true);

  runOpenClawStateWriteTransaction(() => ensureSecretStoreSchema(db), options);
  expect(bound()).toBe(true);
  expect(readProfileAuthority(bound.transferable)).toBe("current");
  expect(readProfileAuthority(settled)).toBe("current");
  expect(() => authority.assertSettled(profile.id)).not.toThrow();

  setUserProfileRole(profile.id, "member", options);
  expect(bound()).toBe(false);
  expect(readProfileAuthority(bound.transferable)).toBe("revoked");
  expect(readProfileAuthority(settled)).toBe("current");
});

it.each([false, true])(
  "fences transferred readers before native COMMIT (rollback=%s)",
  async (rollback) => {
    const { options, profile, bound, unrelated, settled } = await fixture();
    const { db } = openOpenClawStateDatabase(options);
    const execute = db.exec.bind(db);
    let commits = 0;
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql === "COMMIT") {
        commits += 1;
        expect(readProfileAuthority(bound.transferable)).toBe("pending");
        expect(readProfileAuthority(settled)).toBe("pending");
        expect(bound()).toBe(false);
        expect(unrelated()).toBe(true);
        if (rollback) {
          throw new Error("synthetic native COMMIT refusal");
        }
      }
      return execute(sql);
    });
    const mutate = () =>
      runOpenClawStateWriteTransaction(() => {
        setUserProfileRole(profile.id, "member", options);
        // A tentative SQL update can still roll back without retiring its bound authority.
        expect(bound()).toBe(true);
        expect(readProfileAuthority(bound.transferable)).toBe("current");
      }, options);
    if (rollback) {
      expect(mutate).toThrow("synthetic native COMMIT refusal");
    } else {
      mutate();
    }
    expect(commits).toBe(1);
    expect(readProfileAuthority(bound.transferable)).toBe(rollback ? "current" : "revoked");
    expect(readProfileAuthority(settled)).toBe("current");
    expect(unrelated()).toBe(true);
  },
);

it("keeps unknown native COMMIT authority closed before disposing the connection", async () => {
  const { options, profile, bound, settled } = await fixture();
  const { db } = openOpenClawStateDatabase(options);
  const execute = db.exec.bind(db);
  const close = db.close.bind(db);
  let beforeClose: ReturnType<typeof readProfileAuthority> | undefined;
  vi.spyOn(db, "close").mockImplementation(() => {
    beforeClose = readProfileAuthority(settled);
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
  expect(beforeClose).toBe("uncertain");
  expect(bound()).toBe(false);
  expect(readProfileAuthority(settled)).not.toBe("current");
});

it("keeps exact bindings retired while current-fact readers follow known settlement", async () => {
  const { context, profile, authority, bound, unrelated, settled } = await fixture();
  const mutation = fenceUserProfileMutationAuthority(context.admission, {
    profiles: [profile.id],
    identities: [],
    channels: [],
  });
  expect(readProfileAuthority(bound.transferable)).toBe("revoked");
  expect(readProfileAuthority(settled)).toBe("pending");
  expect(unrelated()).toBe(true);
  mutation.settle(true);
  expect(readProfileAuthority(bound.transferable)).toBe("revoked");
  expect(readProfileAuthority(settled)).toBe("current");
  expect(() => authority.assertSettled(profile.id)).not.toThrow();

  const unknown = fenceUserProfileMutationAuthority(context.admission, {
    profiles: [profile.id],
    identities: [],
    channels: [],
  });
  unknown.settle(false);
  unknown.settle(true);
  expect(readProfileAuthority(settled)).toBe("uncertain");
  expect(() => authority.assertSettled(profile.id)).toThrow("requires canonical recovery");
});

it("rejects late registration after retirement and never revives a previous store generation", async () => {
  const { options, profile, bound, settled } = await fixture();
  await closeOpenClawStateDatabaseByPathAsync(options.path);
  const late = structuredClone(bound.transferable);
  expect(readProfileAuthority(late)).toBe("revoked");
  expect(readProfileAuthority(settled)).toBe("revoked");
  openOpenClawStateDatabase(options);
  const replacement = await captureUserProfileAuthorityRead(
    captureOpenClawStateWorkerContext(options).admission,
  );
  const current = replacement.bind(profile.id)!;
  expect(readProfileAuthority(current.transferable)).toBe("current");
  expect(readProfileAuthority(late)).toBe("revoked");
  expect(current.transferable.generation).not.toBe(late.generation);
});

it("retires pre-creation authority when the same admission becomes a physical file", async () => {
  const options = { path: path.join(roots.make("profile-authority-create-"), "openclaw.sqlite") };
  paths.push(options.path);
  const context = captureOpenClawStateWorkerContext(options);
  expect(context.admission.identity.key).toMatch(/^path:/);
  const before = await captureUserProfileAuthorityRead(context.admission);
  const boundBefore = before.bind("not-created-yet")!;
  const transferredBefore = before.transferSettled("not-created-yet");

  const profile = ensureProfileForEmail("created@example.test", options);
  context.admission.assertCurrent();
  expect(context.admission.identity.key).toMatch(/^file:/);
  expect(boundBefore()).toBe(false);
  expect(before.bind(profile.id)).toBeUndefined();
  expect(() => before.assertSettled(profile.id)).toThrow("Profile authority store changed");
  expect(readProfileAuthority(transferredBefore)).toBe("revoked");
  expect(readProfileAuthority(boundBefore.transferable)).toBe("revoked");

  const after = await captureUserProfileAuthorityRead(context.admission);
  const boundAfter = after.bind(profile.id)!;
  expect(boundAfter()).toBe(true);
  setUserProfileRole(profile.id, "member", options);
  expect(boundAfter()).toBe(false);
  expect(readProfileAuthority(boundAfter.transferable)).toBe("revoked");
});
