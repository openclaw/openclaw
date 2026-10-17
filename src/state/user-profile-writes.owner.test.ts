import { expect, it, vi } from "vitest";
import type { UserProfile as UserProfileListItem } from "../../packages/gateway-protocol/src/schema/users.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import {
  executeOpenClawStateWorker,
  runOpenClawStateWorkerOperation,
} from "./openclaw-state-worker-store.js";
import { prepareUserProfileCatalog, publishUserProfilesChange } from "./user-profile-list.js";
import { listProfiles } from "./user-profile-reads.js";
import {
  ensureCanonicalGatewayOwnerProfile,
  ensureCanonicalUserProfileForEmail,
  ensureCanonicalUserProfileForTailscaleIdentity,
  linkCanonicalUserProfileEmail,
  setCanonicalUserProfileRole,
  setCanonicalUserProfileDisplayName,
  syncCanonicalGitHubIdentity,
} from "./user-profile-writes.js";
import { ensureProfileForEmail } from "./user-profiles.js";

vi.mock("./openclaw-state-worker-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openclaw-state-worker-store.js")>();
  return {
    ...actual,
    runOpenClawStateWorkerOperation: vi.fn(actual.runOpenClawStateWorkerOperation),
    executeOpenClawStateWorker: vi.fn(actual.executeOpenClawStateWorker),
  };
});

it("reuses committed email profiles and roster facts without writer admission across edits and merges", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "profile-reuse-" });
  let release = () => {};
  try {
    const first = await ensureCanonicalUserProfileForEmail("first@example.test");
    const second = await ensureCanonicalUserProfileForEmail("second@example.test");
    release = (await prepareUserProfileCatalog()).release;
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
      vi.mocked(runOpenClawStateWorkerOperation).mockClear();
      vi.mocked(executeOpenClawStateWorker).mockClear();
      const sql = observeMainThreadSql();
      try {
        expect(await ensureCanonicalUserProfileForEmail(" FIRST@EXAMPLE.TEST ")).toEqual(expected);
        expect(
          await ensureCanonicalUserProfileForTailscaleIdentity({
            login: "first@example.test",
            name: "Provider Name",
          }),
        ).toEqual(expected);
        expect(await listProfiles()).toContainEqual({
          ...expected,
          emails:
            profile.id === first.id
              ? ["first@example.test"]
              : ["first@example.test", "second@example.test"],
          githubIdentity,
          hasAvatar: false,
        });
        expect(runOpenClawStateWorkerOperation).not.toHaveBeenCalled();
        expect(executeOpenClawStateWorker).not.toHaveBeenCalled();
        sql.expectIdle();
      } finally {
        sql.restore();
      }
    };
    await expectResident(first);
    const renamed = (await setCanonicalUserProfileDisplayName(first.id, "Saved Name")).profile;
    await expectResident(renamed);
    const assigned = await setCanonicalUserProfileRole(first.id, "reader");
    await expectResident(assigned);
    const githubIdentity = {
      login: "first-account",
      profileUrl: "https://github.com/first-account",
      avatarUrl: "https://avatars.githubusercontent.com/u/101?v=4",
    };
    const verified = await syncCanonicalGitHubIdentity({
      identity: { accountId: 101, login: "first-account" },
      authenticationAlias: { kind: "email", email: "first@example.test" },
    });
    await expectResident(verified, githubIdentity);
    const linked = await linkCanonicalUserProfileEmail("first@example.test", second.id);
    await expectResident(linked.profile, githubIdentity);
    await expect(
      ensureCanonicalUserProfileForEmail("first@example.test", {
        assertCurrent() {
          throw new Error("connection revoked");
        },
      }),
    ).rejects.toThrow("connection revoked");
    expect(await ensureCanonicalUserProfileForEmail("new@example.test")).toMatchObject({
      displayName: "new",
    });
  } finally {
    vi.restoreAllMocks();
    release();
    await state.cleanup();
  }
});

it("serves the first owner ensure after catalog hydration and applies write receipts", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "owner-reuse-" });
  let release = () => {};
  try {
    const owner = await ensureCanonicalGatewayOwnerProfile("Host Person");
    release = (await prepareUserProfileCatalog()).release;
    vi.mocked(runOpenClawStateWorkerOperation).mockClear();
    const sql = observeMainThreadSql();
    const reused = await ensureCanonicalGatewayOwnerProfile("Host Person");
    expect(reused).toEqual(owner);
    expect(runOpenClawStateWorkerOperation).not.toHaveBeenCalled();
    sql.expectIdle();
    const hostName = vi.fn(async () => "Host Person");
    expect(await ensureCanonicalGatewayOwnerProfile(hostName)).toEqual(owner);
    expect(hostName).not.toHaveBeenCalled();
    vi.restoreAllMocks();

    reused.displayName = "Caller mutation";
    expect((await ensureCanonicalGatewayOwnerProfile("Host Person")).displayName).toBe(
      "Host Person",
    );
    await setCanonicalUserProfileDisplayName(owner.id, "Saved Owner");
    vi.mocked(runOpenClawStateWorkerOperation).mockClear();
    expect((await ensureCanonicalGatewayOwnerProfile(hostName)).displayName).toBe("Saved Owner");
    expect(runOpenClawStateWorkerOperation).not.toHaveBeenCalled();
    expect(hostName).not.toHaveBeenCalled();

    await setCanonicalUserProfileDisplayName(owner.id, null);
    await ensureCanonicalGatewayOwnerProfile(null);
    vi.mocked(runOpenClawStateWorkerOperation).mockClear();
    const missingName = vi.fn(async () => null);
    const unnamedSql = observeMainThreadSql();
    expect((await ensureCanonicalGatewayOwnerProfile(missingName)).displayName).toBeNull();
    expect(missingName).toHaveBeenCalledOnce();
    expect(runOpenClawStateWorkerOperation).not.toHaveBeenCalled();
    unnamedSql.expectIdle();
    vi.restoreAllMocks();
    const adoptedName = vi.fn(async () => "New Host Name");
    expect((await ensureCanonicalGatewayOwnerProfile(adoptedName)).displayName).toBe(
      "New Host Name",
    );
    expect(adoptedName).toHaveBeenCalledOnce();

    await setCanonicalUserProfileDisplayName(owner.id, null);
    const renamedDuringLookup = await ensureCanonicalGatewayOwnerProfile(async () => {
      await setCanonicalUserProfileDisplayName(owner.id, "Saved during lookup");
      vi.mocked(runOpenClawStateWorkerOperation).mockClear();
      return null;
    });
    expect(renamedDuringLookup.displayName).toBe("Saved during lookup");
    expect(runOpenClawStateWorkerOperation).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    release();
    await state.cleanup();
  }
});

it.each(["missing", "misbound", "merged"] as const)(
  "observes a committed %s owner binding or row without resolving it to a person",
  async (kind) => {
    const state = await createOpenClawTestState({ layout: "state-only", prefix: "owner-binding-" });
    let release = () => {};
    try {
      const owner = await ensureCanonicalGatewayOwnerProfile("Host Person");
      const person = ensureProfileForEmail("person@example.test");
      release = (await prepareUserProfileCatalog()).release;
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
      vi.mocked(runOpenClawStateWorkerOperation).mockClear();
      if (kind === "missing") {
        expect(await ensureCanonicalGatewayOwnerProfile(null)).toEqual(owner);
        expect(runOpenClawStateWorkerOperation).toHaveBeenCalledOnce();
        vi.mocked(runOpenClawStateWorkerOperation).mockClear();
        expect(await ensureCanonicalGatewayOwnerProfile(null)).toEqual(owner);
        expect(runOpenClawStateWorkerOperation).not.toHaveBeenCalled();
      } else {
        await expect(ensureCanonicalGatewayOwnerProfile(null)).rejects.toMatchObject({
          name: "UserProfileOwnerError",
          code: "repair-required",
        });
        expect(runOpenClawStateWorkerOperation).toHaveBeenCalledOnce();
      }
    } finally {
      vi.restoreAllMocks();
      release();
      await state.cleanup();
    }
  },
);
