import { expect, it, vi } from "vitest";
import { setDatabaseEngineReadOnlyAdmission } from "../infra/database-engine/context.js";
import * as stateReads from "./openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { prepareExistingUserProfileAuthentication } from "./user-profile-reads.js";
import {
  ensureCanonicalEnterpriseGitHubProfile,
  linkCanonicalUserProfileEmail,
  syncCanonicalGitHubIdentity,
  ensureCanonicalUserProfileForOpenClawIdIdentity,
} from "./user-profile-writes.js";
import { setUserProfileRole } from "./user-profile-writes.worker.js";
import { ensureProfileForEmail, ensureProfileForTailscaleIdentity } from "./user-profiles.js";
import { useUserStateFixture } from "./user-state.test-support.js";

const stateFixture = useUserStateFixture("existing-profile-authentication-");

function fixture() {
  const options = stateFixture();
  return {
    options,
    read: (selector: Parameters<typeof prepareExistingUserProfileAuthentication>[0]) =>
      prepareExistingUserProfileAuthentication(selector, options),
  };
}

it("resolves exact provider subjects without using email lookalikes or creating missing profiles", async () => {
  const { options, read } = fixture();
  const github = ensureProfileForTailscaleIdentity({ login: "person@github" }, options);
  const passkey = ensureProfileForTailscaleIdentity({ login: "person@passkey" }, options);
  const email = ensureProfileForEmail("person@github", options);
  const count = () =>
    openOpenClawStateDatabase(options)
      .db.prepare("SELECT count(*) AS count FROM user_profiles")
      .get();
  const ocid = await ensureCanonicalUserProfileForOpenClawIdIdentity(
    { accountId: "Opaque-Account-A" },
    options,
  );
  const before = count();
  setDatabaseEngineReadOnlyAdmission(true);
  try {
    for (const [provider, expected] of [
      ["github", github],
      ["passkey", passkey],
    ] as const) {
      const prepared = await read({ kind: "provider", provider, subject: "person" });
      expect(prepared.profile?.profileId).toBe(expected.id);
      prepared.assertCurrent();
    }
    const exactOcid = await read({
      kind: "provider",
      provider: "openclaw.id",
      subject: "Opaque-Account-A",
    });
    expect(exactOcid.profile?.profileId).toBe(ocid.id);
    const wrongCase = await read({
      kind: "provider",
      provider: "openclaw.id",
      subject: "opaque-account-a",
    });
    expect(wrongCase.profile).toBeUndefined();
    const missing = await read({ kind: "provider", provider: "other", subject: "person" });
    expect(missing.profile).toBeUndefined();
    expect((await read({ kind: "email", email: "person@github" })).profile?.profileId).toBe(
      email.id,
    );
  } finally {
    setDatabaseEngineReadOnlyAdmission(false, () => {});
  }
  expect(count()).toEqual(before);
});

it("requires the verified public account/email and exact Enterprise principal proof", async () => {
  const { options, read } = fixture();
  const publicProfile = await syncCanonicalGitHubIdentity(
    {
      identity: { accountId: 123, login: "person" },
      authenticationAlias: { kind: "email", email: "person@example.test" },
    },
    options,
  );
  const principal = "github:git.example.test:456";
  const enterprise = await ensureCanonicalEnterpriseGitHubProfile(principal, "Person", options, {
    login: "enterprise-person",
    email: "person@example.test",
  });
  const readPublic = (accountId: number) =>
    read({ kind: "github", binding: { accountId, email: "person@example.test" } });
  expect((await readPublic(123)).profile?.profileId).toBe(publicProfile.id);
  expect((await readPublic(999)).profile).toBeUndefined();
  const exactEnterprise = await read({
    kind: "enterprise-github",
    principal,
    login: "enterprise-person",
    email: "person@example.test",
  });
  expect(exactEnterprise.profile?.profileId).toBe(enterprise.id);
  const wrongEmail = await read({
    kind: "enterprise-github",
    principal,
    email: "different@example.test",
  });
  expect(wrongEmail.profile).toBeUndefined();
  const other = ensureProfileForEmail("other@example.test", options);
  await linkCanonicalUserProfileEmail(principal, other.id, options);
  expect((await read({ kind: "enterprise-github", principal })).profile).toBeUndefined();
});

it("rejects role changes during lookup and retires a returned identity after its alias moves", async () => {
  const { options, read } = fixture();
  const profile = ensureProfileForTailscaleIdentity({ login: "person@passkey" }, options);
  const readOriginal = stateReads.executeExistingOpenClawStateRead;
  const delayed = vi
    .spyOn(stateReads, "executeExistingOpenClawStateRead")
    .mockImplementation(async (...args) => {
      const result = await readOriginal(...args);
      if (args[1].type === "userProfiles.authenticationIdentity") {
        setUserProfileRole(profile.id, "member", options);
      }
      return result;
    });
  try {
    await expect(
      read({ kind: "provider", provider: "passkey", subject: "person" }),
    ).rejects.toThrow("Profile authentication binding changed");
  } finally {
    delayed.mockRestore();
  }
  const email = ensureProfileForEmail("person@example.test", options);
  const other = ensureProfileForEmail("other@example.test", options);
  const held = await read({ kind: "email", email: "person@example.test" });
  expect(held.profile?.profileId).toBe(email.id);
  await linkCanonicalUserProfileEmail("person@example.test", other.id, options);
  expect(held.assertCurrent).toThrow("Profile authentication binding changed");
});
