import { expect, it, vi } from "vitest";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { runOpenClawStateWorkerOperation } from "./openclaw-state-worker-store.js";
import { prepareUserProfileCatalog, publishUserProfilesChange } from "./user-profile-list.js";
import {
  ensureCanonicalGatewayOwnerProfile,
  setCanonicalUserProfileDisplayName,
} from "./user-profile-writes.js";
import { ensureProfileForEmail } from "./user-profiles.js";

vi.mock("./openclaw-state-worker-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openclaw-state-worker-store.js")>();
  return {
    ...actual,
    runOpenClawStateWorkerOperation: vi.fn(actual.runOpenClawStateWorkerOperation),
  };
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
    const adoptedName = vi.fn(async () => "New Host Name");
    expect((await ensureCanonicalGatewayOwnerProfile(adoptedName)).displayName).toBe(
      "New Host Name",
    );
    expect(adoptedName).toHaveBeenCalledOnce();
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
