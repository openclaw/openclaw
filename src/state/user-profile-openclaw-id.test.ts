import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db.js";
import {
  ensureCanonicalUserProfileForOpenClawIdIdentity as ensureIdentity,
  linkCanonicalOpenClawIdUserProfile as link,
  readOpenClawIdLinkedProfile,
  readOpenClawIdLinksOfProfile,
  readOpenClawIdUserProfiles,
  unlinkCanonicalOpenClawIdUserProfile as unlink,
} from "./user-profile-openclaw-id.js";
import { listProfiles } from "./user-profile-reads.js";
import {
  ensureCanonicalGatewayOwnerProfile,
  ensureCanonicalUserProfileForEmail,
  ensureCanonicalUserProfileForTailscaleIdentity,
  mergeCanonicalUserProfiles,
  setCanonicalUserProfileDisplayName,
  setCanonicalUserProfileRole,
} from "./user-profile-writes.js";
import { useProfileDatabase } from "./user-profiles-fixture.test-support.js";

const { options, hydrate } = useProfileDatabase("user-profile-openclaw-id-");

it("keys profiles by exact OCID, without email merging, aliases, or inherited roles", async () => {
  const emailOwner = await ensureCanonicalUserProfileForEmail("shared@example.test", options);
  await setCanonicalUserProfileRole(emailOwner.id, "admin", options);
  const first = await ensureIdentity(
    { accountId: "Account-A", name: "First", email: "shared@example.test" },
    options,
  );
  const second = await ensureIdentity(
    { accountId: "Account-B", email: "shared@example.test" },
    options,
  );
  const caseDistinct = await ensureIdentity({ accountId: "account-a" }, options);
  const tailscale = await ensureCanonicalUserProfileForTailscaleIdentity(
    { login: "Account-A@openclaw-id" },
    options,
  );
  expect(new Set([emailOwner.id, first.id, second.id, caseDistinct.id, tailscale.id]).size).toBe(5);
  expect(await ensureIdentity({ accountId: "Account-A" }, options)).toEqual(first);
  await hydrate();
  const roster = await listProfiles(options);
  for (const profile of [first, second, caseDistinct]) {
    expect(roster.find(({ id }) => id === profile.id)).toMatchObject({
      emails: [],
      githubIdentity: null,
    });
    expect(roster.find(({ id }) => id === profile.id)?.role).toBeUndefined();
  }
  expect(await ensureCanonicalUserProfileForEmail("shared@example.test", options)).toMatchObject({
    id: emailOwner.id,
    role: "admin",
  });
});

it("persists bounded display metadata, preserves user edits, and adopts only empty names", async () => {
  const first = await ensureIdentity(
    { accountId: "saved", name: " Provider Name ", email: " Person@Example.test " },
    options,
  );
  expect(first.displayName).toBe("Provider Name");
  await setCanonicalUserProfileDisplayName(first.id, "My Name", options);
  await ensureIdentity(
    { accountId: "saved", name: "Replacement", email: "updated@example.test" },
    options,
  );
  await ensureIdentity({ accountId: "saved" }, options);
  const limited = await ensureIdentity(
    {
      accountId: "bounded",
      name: ` ${"n".repeat(255)}😀tail `,
      email: ` ${"e".repeat(255)}😀@example.test `,
    },
    options,
  );
  expect(limited.displayName).toBe("n".repeat(255));
  await closeOpenClawStateDatabaseAsync();
  expect(await readOpenClawIdUserProfiles(["saved", "bounded"], options)).toEqual({
    saved: { id: first.id, displayName: "My Name", email: "updated@example.test" },
    bounded: { id: limited.id, displayName: "n".repeat(255), email: "e".repeat(255) },
  });
  await setCanonicalUserProfileDisplayName(first.id, null, options);
  expect(
    await ensureIdentity({ accountId: "saved", name: " Adopted ", email: null }, options),
  ).toMatchObject({ id: first.id, displayName: "Adopted" });
  expect(await readOpenClawIdUserProfiles(["saved"], options)).toEqual({
    saved: { id: first.id, displayName: "Adopted", email: null },
  });
});

it("does not create state on reads and preserves explicit profile merges", async () => {
  expect(await readOpenClawIdUserProfiles(["unknown"], options)).toEqual({});
  expect(await readOpenClawIdUserProfiles([], options)).toEqual({});
  expect(existsSync(options.path)).toBe(false);
  const source = await ensureIdentity(
    { accountId: "source", name: "Source", email: "source@example.test" },
    options,
  );
  const target = await ensureIdentity({ accountId: "target", name: "Target" }, options);
  await mergeCanonicalUserProfiles(source.id, target.id, options);
  expect(await ensureIdentity({ accountId: "source", name: "Reported" }, options)).toMatchObject({
    id: target.id,
    displayName: "Target",
  });
  expect(await readOpenClawIdUserProfiles(["source", "target", "unknown"], options)).toEqual({
    source: { id: target.id, displayName: "Target", email: "source@example.test" },
    target: { id: target.id, displayName: "Target", email: null },
  });
});

it("links one OCID account to one personal profile, carried by merge and removed by unlink", async () => {
  const person = await ensureCanonicalUserProfileForTailscaleIdentity(
    { login: "josh@example.test", name: "Josh" },
    options,
  );
  const other = await ensureCanonicalUserProfileForEmail("other@example.test", options);
  const owner = await ensureCanonicalGatewayOwnerProfile("Owner", options);
  expect(await readOpenClawIdLinkedProfile("acct-josh", options)).toBeNull();

  expect(
    await link({ profileId: person.id, accountId: "acct-josh", email: "josh@id.test" }, options),
  ).toEqual({ ok: true });
  // Idempotent for the same profile; refused for another profile.
  expect(
    await link({ profileId: person.id, accountId: "acct-josh", email: null }, options),
  ).toEqual({ ok: true });
  expect(await link({ profileId: other.id, accountId: "acct-josh", email: null }, options)).toEqual(
    { ok: false, code: "linked_elsewhere" },
  );
  expect(
    await link({ profileId: owner.id, accountId: "acct-owner", email: null }, options),
  ).toEqual({ ok: false, code: "owner_profile" });
  // A member profile created for an account holds it: linking that account elsewhere is refused.
  await ensureIdentity({ accountId: "acct-member" }, options);
  expect(
    await link({ profileId: other.id, accountId: "acct-member", email: null }, options),
  ).toEqual({ ok: false, code: "linked_elsewhere" });

  expect(await readOpenClawIdLinkedProfile("acct-josh", options)).toMatchObject({
    profileId: person.id,
  });
  expect(await readOpenClawIdLinksOfProfile(person.id, options)).toEqual([
    { accountId: "acct-josh", email: "josh@id.test" },
  ]);
  // Membership-style ensure reuses the linked profile rather than creating another.
  expect((await ensureIdentity({ accountId: "acct-josh" }, options)).id).toBe(person.id);

  // Merging linked profiles keeps every account; status lists them and unlink removes them all.
  await link({ profileId: other.id, accountId: "acct-second", email: "second@id.test" }, options);
  await mergeCanonicalUserProfiles(person.id, other.id, options);
  expect(
    (await readOpenClawIdLinksOfProfile(other.id, options)).map((l) => l.accountId).toSorted(),
  ).toEqual(["acct-josh", "acct-second"]);
  expect(await readOpenClawIdLinkedProfile("acct-josh", options)).toMatchObject({
    profileId: other.id,
  });
  // A link proven for a profile that was merged away meanwhile is not redirected.
  expect(
    await link({ profileId: person.id, accountId: "acct-third", email: null }, options),
  ).toEqual({ ok: false, code: "profile_changed" });
  expect(await unlink({ profileId: other.id }, options)).toEqual({ unlinked: true });
  expect(await readOpenClawIdLinkedProfile("acct-josh", options)).toBeNull();
  expect(await unlink({ profileId: other.id }, options)).toEqual({ unlinked: false });
});
