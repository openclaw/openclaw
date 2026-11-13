import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { listProfiles } from "./user-profile-reads.js";
import {
  ensureCanonicalLocalUserProfile,
  mergeCanonicalUserProfiles,
  setCanonicalUserProfileDisplayName,
} from "./user-profile-writes.js";
import { useProfileDatabase } from "./user-profiles-fixture.test-support.js";

const { options, hydrate } = useProfileDatabase("user-profile-local-");

it("creates email-less local profiles idempotently without identity proof or roles", async () => {
  const enrollmentId = randomUUID();
  const first = await ensureCanonicalLocalUserProfile(
    { enrollmentId, name: " Local Person " },
    options,
  );
  expect(first.displayName).toBe("Local Person");
  await setCanonicalUserProfileDisplayName(first.id, "Edited", options);
  expect(
    await ensureCanonicalLocalUserProfile({ enrollmentId, name: "Ignored" }, options),
  ).toMatchObject({ id: first.id, displayName: "Edited" });
  const other = await ensureCanonicalLocalUserProfile(
    { enrollmentId: randomUUID(), name: "Edited" },
    options,
  );
  expect(other.id).not.toBe(first.id);
  await hydrate();
  expect((await listProfiles(options)).find(({ id }) => id === first.id)).toMatchObject({
    emails: [],
    githubIdentity: null,
  });
  expect(first.role).toBeUndefined();
  await mergeCanonicalUserProfiles(first.id, other.id, options);
  expect(await ensureCanonicalLocalUserProfile({ enrollmentId }, options)).toMatchObject({
    id: other.id,
  });
});
