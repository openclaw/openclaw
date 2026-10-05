import { afterEach, expect, it } from "vitest";
import { GIT_COAUTHOR_PREFERENCE_KEY } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { resolveGitCoauthorAttribution } from "../agents/git-coauthor-attribution.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { recordSessionParticipant } from "../config/sessions/session-accessor.sqlite-participants.native.js";
import {
  closeOpenClawStateDatabaseForTest,
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { setCanonicalUserPreferences } from "../state/user-preferences.js";
import {
  prepareUserProfileGitHubAttribution,
  resolveUserProfileGitHubAttribution,
} from "../state/user-profile-github-identity.js";
import { linkEmail, syncGitHubIdentity } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createAuthenticatedGitHubIdentitySync } from "./github-user-identity.js";

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});

it("credits trusted Enterprise email only with explicit consent and the operation's issuer", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const principal = "github:microsoft.ghe.com:700001";
    const sync = createAuthenticatedGitHubIdentitySync({
      authConfig: { mode: "trusted-proxy", trustedProxy: { userHeader: "x-factory-principal" } },
      authResult: { ok: true, method: "trusted-proxy", user: principal },
      requestHeaders: {
        "x-factory-github-login": "enterprise-human",
        "x-factory-github-email": " VERIFIED@example.test ",
      },
    })!;
    const enterprise = await sync();
    const publicPerson = syncGitHubIdentity(
      {
        identity: { accountId: 700001, login: "public-human" },
        authenticationAlias: { kind: "email", email: "public-human@example.test" },
      },
      { env: state.env },
    );
    const scope = {
      agentId: "main",
      env: state.env,
      sessionKey: "agent:main:enterprise-coauthor",
    };
    await upsertSessionEntryCore(scope, { sessionId: "enterprise-coauthor", updatedAt: 1 });
    for (const profileId of [enterprise.profileId, publicPerson.id]) {
      recordSessionParticipant(scope, {
        identity: { type: "profile", id: profileId },
        promptedAt: 1,
        sessionAgentId: "main",
      });
    }
    const read = (host: string, excludeIdentity?: { host: string; accountId: number }) =>
      resolveGitCoauthorAttribution({ ...scope, config: {}, host, excludeIdentity });
    for (const consent of [undefined, false, "yes", true]) {
      if (consent !== undefined) {
        await setCanonicalUserPreferences(enterprise.profileId, {
          [GIT_COAUTHOR_PREFERENCE_KEY]: consent,
        });
      }
      expect(await read("microsoft.ghe.com")).toEqual(
        consent === true
          ? {
              logins: ["enterprise-human"],
              trailers: ["Co-authored-by: enterprise-human <verified@example.test>"],
            }
          : undefined,
      );
    }
    expect(await read("github.com")).toEqual({
      logins: ["public-human"],
      trailers: ["Co-authored-by: public-human <700001+public-human@users.noreply.github.com>"],
    });
    expect(
      await read("microsoft.ghe.com", { host: "microsoft.ghe.com", accountId: 700001 }),
    ).toBeUndefined();
    expect(await read("github.com", { host: "github.com", accountId: 700001 })).toBeUndefined();
    expect(await read("microsoft.ghe.com", { host: "github.com", accountId: 700001 })).toEqual(
      await read("microsoft.ghe.com"),
    );
    expect(
      await resolveGitCoauthorAttribution({
        ...scope,
        config: {
          gateway: {
            github: { host: "microsoft.ghe.com", apiBaseUrl: "https://api.microsoft.ghe.com" },
          },
        },
      }),
    ).toEqual(await read("microsoft.ghe.com"));
    const row = openOpenClawStateDatabase()
      .db.prepare(
        "SELECT provider, subject, verified_email_json FROM user_profile_identities WHERE profile_id = ?",
      )
      .all(enterprise.profileId);
    expect(row).toEqual([
      {
        provider: "github:microsoft.ghe.com",
        subject: "700001",
        verified_email_json: JSON.stringify({
          email: "verified@example.test",
          profileId: enterprise.profileId,
        }),
      },
    ]);
    expect(
      (await resolveUserProfileGitHubAttribution([enterprise.profileId])).get(enterprise.profileId),
    ).toBeNull();
    const switched = await createAuthenticatedGitHubIdentitySync({
      authConfig: { mode: "trusted-proxy", trustedProxy: { userHeader: "x-factory-principal" } },
      authResult: { ok: true, method: "trusted-proxy", user: "github:microsoft.ghe.com:700004" },
      requestHeaders: {
        "x-factory-github-login": "switched-human",
        "x-factory-github-email": "switched@example.test",
      },
    })!();
    expect(switched.profileId).not.toBe(enterprise.profileId);
    expect(
      (
        await resolveUserProfileGitHubAttribution([switched.profileId], {
          host: "microsoft.ghe.com",
        })
      ).get(switched.profileId),
    ).toBeNull();
  });
});

it("fences Enterprise credit on verified-email change, removal, alias transfer, merge and revocation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const principal = "github:microsoft.ghe.com:700002";
    const sync = (email?: string) =>
      createAuthenticatedGitHubIdentitySync({
        authConfig: {
          mode: "trusted-proxy",
          trustedProxy: { userHeader: "x-factory-principal" },
        },
        authResult: { ok: true, method: "trusted-proxy", user: principal },
        requestHeaders: {
          "x-factory-github-login": "bound-human",
          ...(email ? { "x-factory-github-email": email } : {}),
        },
      })!();
    const person = await sync("bound-one@example.test");
    await setCanonicalUserPreferences(person.profileId, { [GIT_COAUTHOR_PREFERENCE_KEY]: true });
    const prepare = () =>
      prepareUserProfileGitHubAttribution([person.profileId], { host: "microsoft.ghe.com" });
    const first = await prepare();
    expect(first.identities.get(person.profileId)).toMatchObject({
      verifiedEmail: "bound-one@example.test",
    });
    await sync("bound-two@example.test");
    expect(first.isCurrent()).toBe(false);
    const second = await prepare();
    expect(second.identities.get(person.profileId)).toMatchObject({
      verifiedEmail: "bound-two@example.test",
    });
    await sync();
    expect(second.isCurrent()).toBe(false);
    expect((await prepare()).identities.get(person.profileId)).toBeNull();
    await sync("bound-two@example.test");
    const third = await prepare();
    const other = ensureProfileForEmail("bound-target@example.test");
    linkEmail("bound-two@example.test", other.id);
    expect(third.isCurrent()).toBe(false);
    expect((await prepare()).identities.get(person.profileId)).toBeNull();
    await expect(sync("bound-two@example.test")).rejects.toThrow("already bound");
    expect((await prepare()).identities.get(person.profileId)).toBeNull();
    await sync("bound-three@example.test");
    const fourth = await prepare();
    await setCanonicalUserPreferences(person.profileId, { [GIT_COAUTHOR_PREFERENCE_KEY]: false });
    expect(fourth.isCurrent()).toBe(false);
    await setCanonicalUserPreferences(person.profileId, { [GIT_COAUTHOR_PREFERENCE_KEY]: true });
    const fifth = await prepare();
    const proof = openOpenClawStateDatabase()
      .db.prepare(
        "SELECT verified_email_json FROM user_profile_identities WHERE provider = ? AND subject = ?",
      )
      .get("github:microsoft.ghe.com", "700002")?.verified_email_json;
    for (const email of [principal, "bound-one@example.test", "bound-three@example.test"]) {
      linkEmail(email, other.id);
    }
    expect(fifth.isCurrent()).toBe(false);
    expect((await prepare()).identities.get(person.profileId)).toBeNull();
    // A pre-feature merger may copy the old fact while moving its row; that grants no credit.
    openOpenClawStateDatabase()
      .db.prepare(
        "UPDATE user_profile_identities SET verified_email_json = ? WHERE provider = ? AND subject = ?",
      )
      .run(proof ?? null, "github:microsoft.ghe.com", "700002");
    await setCanonicalUserPreferences(other.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: true });
    expect((await prepare()).identities.get(person.profileId)).toBeNull();
  });
});

it("reads an old identity shape without migration and adds verified evidence only through first-use ingress", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const principal = "github:microsoft.ghe.com:700003";
    const profile = ensureProfileForEmail(principal);
    await setCanonicalUserPreferences(profile.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: true });
    // sqlite-allow-raw -- Test-owned old schema fixture; no operator database is opened.
    openOpenClawStateDatabase().db.exec(
      "ALTER TABLE user_profile_identities DROP COLUMN verified_email_json",
    );
    await closeOpenClawStateDatabaseAsync();
    expect(
      (await resolveUserProfileGitHubAttribution([profile.id], { host: "microsoft.ghe.com" })).get(
        profile.id,
      ),
    ).toBeNull();
    const columns = openOpenClawStateDatabase()
      .db.prepare("PRAGMA table_info(user_profile_identities)")
      .all();
    expect(columns.some((column) => column.name === "verified_email_json")).toBe(false);
    await closeOpenClawStateDatabaseAsync();
    await createAuthenticatedGitHubIdentitySync({
      authConfig: { mode: "trusted-proxy", trustedProxy: { userHeader: "x-factory-principal" } },
      authResult: { ok: true, method: "trusted-proxy", user: principal },
      requestHeaders: {
        "x-factory-github-login": "upgraded-human",
        "x-factory-github-email": "upgraded@example.test",
      },
    })!();
    expect(
      (await resolveUserProfileGitHubAttribution([profile.id], { host: "microsoft.ghe.com" })).get(
        profile.id,
      ),
    ).toMatchObject({
      host: "microsoft.ghe.com",
      accountId: 700003,
      verifiedEmail: "upgraded@example.test",
    });
  });
});
