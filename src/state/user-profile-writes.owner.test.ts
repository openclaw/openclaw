import { expect, it, vi } from "vitest";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { expectCalls } from "./openclaw-state-db-fixtures.test-support.js";
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
async function withoutWriter<T>(run: () => Promise<T>) {
  vi.mocked(runWorker).mockClear();
  vi.mocked(executeWorker).mockClear();
  const sql = observeMainThreadSql();
  try {
    const result = await run();
    expectCalls(0, runWorker, executeWorker);
    sql.expectIdle();
    return result;
  } finally {
    sql.restore();
  }
}

it("reuses committed email profiles and roster facts without writer admission across edits and merges", async () => {
  const first = await ensureEmail("first@example.test");
  const second = await ensureEmail("second@example.test");
  await catalog.hydrate();
  const expectResident = async (profile: typeof first) =>
    expect(await withoutWriter(() => ensureEmail(" FIRST@EXAMPLE.TEST "))).toEqual(profile);
  await expectResident(first);
  expect(
    await withoutWriter(() =>
      ensureTailscale({ login: "first@example.test", name: "Provider Name" }),
    ),
  ).toEqual(first);
  await expectResident((await setName(first.id, "Saved Name")).profile);
  await expectResident(await setRole(first.id, "reader"));
  const githubIdentity = {
    login: "first-account",
    profileUrl: "https://github.com/first-account",
    avatarUrl: "https://avatars.githubusercontent.com/u/101?v=4",
  };
  await expectResident(
    await syncGitHub({
      identity: { accountId: 101, login: "first-account" },
      authenticationAlias: { kind: "email", email: "first@example.test" },
    }),
  );
  const linked = (await linkEmail("first@example.test", second.id)).profile;
  await expectResident(linked);
  expect(await withoutWriter(listProfiles)).toContainEqual({
    ...linked,
    emails: ["first@example.test", "second@example.test"],
    githubIdentity,
    hasAvatar: false,
  });
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
  const reused = await withoutWriter(() => ensureOwner("Host Person"));
  expect(reused).toEqual(owner);
  const hostName = vi.fn(async () => "Host Person");
  expect(await ensureOwner(hostName)).toEqual(owner);

  reused.displayName = "Caller mutation";
  expect((await ensureOwner("Host Person")).displayName).toBe("Host Person");
  await setName(owner.id, "Saved Owner");
  expect((await withoutWriter(() => ensureOwner(hostName))).displayName).toBe("Saved Owner");
  expect(hostName).not.toHaveBeenCalled();

  await setName(owner.id, null);
  await ensureOwner(null);
  const missingName = vi.fn(async () => null);
  expect((await withoutWriter(() => ensureOwner(missingName))).displayName).toBeNull();
  expect(missingName).toHaveBeenCalledOnce();
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
      vi.mocked(runWorker).mockClear();
      expect(await ensureOwner(null)).toEqual(owner);
      expect(runWorker).not.toHaveBeenCalled();
    } else {
      await expect(ensureOwner(null)).rejects.toMatchObject({
        name: "UserProfileOwnerError",
        code: "repair-required",
      });
    }
  },
);
