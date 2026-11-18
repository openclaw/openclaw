import { expect, it } from "vitest";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db.js";
import { listProfiles } from "./user-profile-reads.js";
import {
  ensureCanonicalDelegatedUserProfile,
  ensureCanonicalUserProfileForEmail,
  ensureCanonicalUserProfileForTailscaleIdentity,
  linkCanonicalUserProfileEmail,
  mergeCanonicalUserProfiles,
  setCanonicalUserProfileDisplayName,
} from "./user-profile-writes.js";
import { useProfileDatabase } from "./user-profiles-fixture.test-support.js";

const { options, hydrate } = useProfileDatabase("user-profile-delegation-");
const identity = (suffix: string) => ({
  authority: "oce" as const,
  subject: `oce:v1:${suffix.repeat(64)}`,
});

it("atomically binds delegated identities without aliases and retains them after reopening", async () => {
  const first = identity("a");
  const concurrent = await Promise.all(
    Array.from({ length: 4 }, () => ensureCanonicalDelegatedUserProfile(first, options)),
  );
  expect(new Set(concurrent.map((profile) => profile.id)).size).toBe(1);
  const profile = concurrent[0]!;
  const second = await ensureCanonicalDelegatedUserProfile(identity("b"), options);
  const email = await ensureCanonicalUserProfileForEmail(first.subject, options);
  const tailscale = await ensureCanonicalUserProfileForTailscaleIdentity(
    { login: `${first.subject}@oce` },
    options,
  );
  expect(new Set([profile.id, second.id, email.id, tailscale.id]).size).toBe(4);
  await setCanonicalUserProfileDisplayName(profile.id, "Preferred name", options);
  await closeOpenClawStateDatabaseAsync();
  expect(await ensureCanonicalDelegatedUserProfile(first, options)).toMatchObject({
    id: profile.id,
    displayName: "Preferred name",
  });
  await hydrate();
  expect((await listProfiles(options)).find(({ id }) => id === profile.id)).toMatchObject({
    emails: [],
    githubIdentity: null,
  });
});

it("refuses native linking and merging into or out of delegated profiles", async () => {
  const first = await ensureCanonicalDelegatedUserProfile(identity("a"), options);
  const second = await ensureCanonicalDelegatedUserProfile(identity("b"), options);
  const email = await ensureCanonicalUserProfileForEmail("person@example.test", options);
  for (const [source, target] of [
    [first, second],
    [first, email],
    [email, first],
  ]) {
    await expect(mergeCanonicalUserProfiles(source!.id, target!.id, options)).rejects.toThrow(
      "Delegated profiles cannot",
    );
  }
  await expect(
    linkCanonicalUserProfileEmail("person@example.test", first.id, options),
  ).rejects.toThrow("Delegated profiles cannot");
  expect(await ensureCanonicalDelegatedUserProfile(identity("a"), options)).toMatchObject({
    id: first.id,
  });
  expect(await ensureCanonicalUserProfileForEmail("person@example.test", options)).toMatchObject({
    id: email.id,
  });
});
