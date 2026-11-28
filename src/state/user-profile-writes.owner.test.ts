import { expect, it, vi } from "vitest";
import type { UserProfile as UserProfileListItem } from "../../packages/gateway-protocol/src/schema/users.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import {
  executeOpenClawStateWorker as executeWorker,
  runOpenClawStateWorkerOperation as runWorker,
} from "./openclaw-state-worker-store.js";
import { publishUserProfilesChange } from "./user-profile-list.js";
import { listProfiles } from "./user-profile-reads.js";
import {
  ensureCanonicalGatewayOwnerProfile as ensureOwner,
  ensureCanonicalUserProfileForEmail as ensureEmail,
  ensureCanonicalUserProfileForTailscaleIdentity as ensureTailscale,
  linkCanonicalUserProfileEmail as linkEmail,
  setCanonicalUserProfileRole as setRole,
  setCanonicalUserProfileDisplayName as setName,
  syncCanonicalGitHubIdentity as syncGitHub,
} from "./user-profile-writes.js";
import { useProfileState } from "./user-profiles-fixture.test-support.js";
import { ensureProfileForEmail } from "./user-profiles.js";

vi.mock("./openclaw-state-worker-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openclaw-state-worker-store.js")>();
  return {
    ...actual,
    runOpenClawStateWorkerOperation: vi.fn(actual.runOpenClawStateWorkerOperation),
    executeOpenClawStateWorker: vi.fn(actual.executeOpenClawStateWorker),
  };
});

const catalog = useProfileState();

it("reuses committed email profiles and roster facts without writer admission across edits and merges", async () => {
  const first = await ensureEmail("first@example.test");
  const second = await ensureEmail("second@example.test");
  await catalog.hydrate();
  const expectResident = async (
    profile: typeof first,
    githubIdentity: UserProfileListItem["githubIdentity"] = null,
  ) => {
    const { id, displayName, avatarMime, mergedInto, createdAt, updatedAt, role } = profile;
    const expected = {
      id,
      displayName,
      avatarMime,
      mergedInto,
      createdAt,
      updatedAt,
      ...(role ? { role } : {}),
    };
    vi.mocked(runWorker).mockClear();
    vi.mocked(executeWorker).mockClear();
    const sql = observeMainThreadSql();
    try {
      expect(await ensureEmail(" FIRST@EXAMPLE.TEST ")).toEqual(expected);
      expect(await ensureTailscale({ login: "first@example.test", name: "Provider Name" })).toEqual(
        expected,
      );
      expect(await listProfiles()).toContainEqual({
        ...expected,
        emails:
          profile.id === first.id
            ? ["first@example.test"]
            : ["first@example.test", "second@example.test"],
        githubIdentity,
        hasAvatar: false,
      });
      expect(runWorker).not.toHaveBeenCalled();
      expect(executeWorker).not.toHaveBeenCalled();
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  };
  await expectResident(first);
  const renamed = (await setName(first.id, "Saved Name")).profile;
  await expectResident(renamed);
  const assigned = await setRole(first.id, "reader");
  await expectResident(assigned);
  const githubIdentity = {
    login: "first-account",
    profileUrl: "https://github.com/first-account",
    avatarUrl: "https://avatars.githubusercontent.com/u/101?v=4",
  };
  const verified = await syncGitHub({
    identity: { accountId: 101, login: "first-account" },
    authenticationAlias: { kind: "email", email: "first@example.test" },
  });
  await expectResident(verified, githubIdentity);
  const linked = await linkEmail("first@example.test", second.id);
  await expectResident(linked.profile, githubIdentity);
  await expect(
    ensureEmail("first@example.test", {
      assertCurrent() {
        throw new Error("connection revoked");
      },
    }),
  ).rejects.toThrow("connection revoked");
  expect(await ensureEmail("new@example.test")).toMatchObject({ displayName: "new" });
});

it("serves the first owner ensure after catalog hydration and applies write receipts", async () => {
  const owner = await ensureOwner("Host Person");
  await catalog.hydrate();
  vi.mocked(runWorker).mockClear();
  const sql = observeMainThreadSql();
  const reused = await ensureOwner("Host Person");
  expect(reused).toEqual(owner);
  expect(runWorker).not.toHaveBeenCalled();
  sql.expectIdle();
  const hostName = vi.fn(async () => "Host Person");
  expect(await ensureOwner(hostName)).toEqual(owner);
  expect(hostName).not.toHaveBeenCalled();
  vi.restoreAllMocks();

  reused.displayName = "Caller mutation";
  expect((await ensureOwner("Host Person")).displayName).toBe("Host Person");
  await setName(owner.id, "Saved Owner");
  vi.mocked(runWorker).mockClear();
  expect((await ensureOwner(hostName)).displayName).toBe("Saved Owner");
  expect(runWorker).not.toHaveBeenCalled();
  expect(hostName).not.toHaveBeenCalled();

  await setName(owner.id, null);
  await ensureOwner(null);
  vi.mocked(runWorker).mockClear();
  const missingName = vi.fn(async () => null);
  const unnamedSql = observeMainThreadSql();
  expect((await ensureOwner(missingName)).displayName).toBeNull();
  expect(missingName).toHaveBeenCalledOnce();
  expect(runWorker).not.toHaveBeenCalled();
  unnamedSql.expectIdle();
  vi.restoreAllMocks();
  const adoptedName = vi.fn(async () => "New Host Name");
  expect((await ensureOwner(adoptedName)).displayName).toBe("New Host Name");
  expect(adoptedName).toHaveBeenCalledOnce();

  await setName(owner.id, null);
  const renamedDuringLookup = await ensureOwner(async () => {
    await setName(owner.id, "Saved during lookup");
    vi.mocked(runWorker).mockClear();
    return null;
  });
  expect(renamedDuringLookup.displayName).toBe("Saved during lookup");
  expect(runWorker).not.toHaveBeenCalled();
});

it.each(["missing", "misbound", "merged"] as const)(
  "observes a committed %s owner binding or row without resolving it to a person",
  async (kind) => {
    const owner = await ensureOwner("Host Person");
    const person = ensureProfileForEmail("person@example.test");
    await catalog.hydrate();
    const { db } = openOpenClawStateDatabase();
    runOpenClawStateWriteTransaction(() => {
      if (kind === "missing") {
        db.prepare("DELETE FROM user_profile_identities WHERE provider = 'gateway.local'").run();
      } else if (kind === "misbound") {
        db.prepare(
          "UPDATE user_profile_identities SET profile_id = ? WHERE provider = 'gateway.local'",
        ).run(person.id);
      } else {
        db.prepare("UPDATE user_profiles SET merged_into = ? WHERE id = ?").run(
          person.id,
          owner.id,
        );
      }
      publishUserProfilesChange(db, owner.id, person.id);
    });
    vi.mocked(runWorker).mockClear();
    if (kind === "missing") {
      expect(await ensureOwner(null)).toEqual(owner);
      expect(runWorker).toHaveBeenCalledOnce();
      vi.mocked(runWorker).mockClear();
      expect(await ensureOwner(null)).toEqual(owner);
      expect(runWorker).not.toHaveBeenCalled();
    } else {
      await expect(ensureOwner(null)).rejects.toMatchObject({
        name: "UserProfileOwnerError",
        code: "repair-required",
      });
      expect(runWorker).toHaveBeenCalledOnce();
    }
  },
);
