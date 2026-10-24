import { describe, expect, it } from "vitest";
import { GIT_COAUTHOR_PREFERENCE_KEY } from "../../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { userChannelIdentitySubject } from "../../state/user-channel-identities.js";
import {
  authorizeCanonicalUserChannelIdentity,
  changeCanonicalUserChannelIdentity,
  listCanonicalUserChannelIdentities,
  prepareConfiguredCommandOwnerAuthority,
  prepareUserChannelIdentityAuthority,
  publishCanonicalUserChannelPolicy,
} from "../../state/user-channel-identity-operations.js";
import {
  getCanonicalUserPreferences,
  setCanonicalUserPreferences,
} from "../../state/user-preferences.js";
import { setCanonicalUserProfileRole } from "../../state/user-profile-writes.js";
import { userProfilesDb } from "../../state/user-profiles-internal.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { executeSqliteQuerySync } from "../kysely-sync.js";
import { withEngineStoreAdmission as admit } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection).each(["sqlite", "postgres"] as const)(
  "%s profile authority workers",
  (engine) => {
    useMixedAgentPair(engine, engine);
    const identity = (name: string) => ({
      channelId: "discord",
      accountId: "synthetic",
      senderId: name,
    });
    const profile = (name: string) => admit(() => ensureProfileForEmail(`${name}@example.test`));
    const custody = (subject: string) =>
      admit(() => {
        const { db } = openOpenClawStateDatabase();
        return executeSqliteQuerySync(
          db,
          userProfilesDb(db)
            .selectFrom("user_profile_identities")
            .select(["authorization_id", "authorization_basis_json"])
            .where("subject", "=", subject),
        ).rows[0];
      });
    const seedCustody = (subject: string) =>
      admit(() =>
        runOpenClawStateWriteTransaction(({ db }) => {
          executeSqliteQuerySync(
            db,
            userProfilesDb(db)
              .updateTable("user_profile_identities")
              .set({
                authorization_id: `synthetic-custody:${subject}`,
                authorization_basis_json: "null",
              })
              .where("subject", "=", subject),
          );
        }),
      );

    it("persists and removes coauthor preferences through the state worker", async () => {
      const person = profile("coauthor");
      await expect(
        setCanonicalUserPreferences(person.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: true }),
      ).resolves.toMatchObject({ ok: true });
      await expect(getCanonicalUserPreferences(person.id)).resolves.toEqual({
        profileId: person.id,
        entries: { [GIT_COAUTHOR_PREFERENCE_KEY]: true },
      });
      await expect(
        setCanonicalUserPreferences(person.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: null }),
      ).resolves.toMatchObject({ ok: true });
      await expect(getCanonicalUserPreferences(person.id)).resolves.toEqual({
        profileId: person.id,
        entries: {},
      });
    });

    it("changes a role through the state worker and clears recovery custody", async () => {
      const person = profile("role-custody");
      const channel = identity("role-custody");
      await changeCanonicalUserChannelIdentity("link", person.id, channel);
      const subject = userChannelIdentitySubject(channel);
      seedCustody(subject);
      expect(custody(subject)?.authorization_id).toBe(`synthetic-custody:${subject}`);
      await expect(setCanonicalUserProfileRole(person.id, "reviewer")).resolves.toMatchObject({
        id: person.id,
        role: "reviewer",
      });
      expect(custody(subject)).toEqual({ authorization_id: null, authorization_basis_json: null });
    });

    it("reads the stored role through the role authority worker", async () => {
      const person = profile("role-read");
      admit(() =>
        runOpenClawStateWriteTransaction(({ db }) => {
          executeSqliteQuerySync(
            db,
            userProfilesDb(db)
              .updateTable("user_profiles")
              .set({ role: "reviewer" })
              .where("id", "=", person.id),
          );
        }),
      );
      const context = captureOpenClawStateWorkerContext({});
      await expect(
        runOpenClawStateWorkerOperation(
          context,
          (scope) =>
            scope.execute({
              type: "userProfiles.roleAuthority.resolve",
              input: { profileId: person.id },
            }),
          { existingOnly: true },
        ),
      ).resolves.toMatchObject({ profileId: person.id, role: "reviewer" });
    });

    it("lists linked identities and reads a persisted channel authorization", async () => {
      const person = profile("channel-auth");
      const channel = identity("channel-auth");
      await publishCanonicalUserChannelPolicy(undefined);
      await changeCanonicalUserChannelIdentity("link", person.id, channel);
      await expect(listCanonicalUserChannelIdentities(person.id)).resolves.toEqual([
        { profileId: person.id, identity: channel },
      ]);
      const policy = { roles: null, identityScopes: null };
      const reference = await authorizeCanonicalUserChannelIdentity(
        {
          action: "authorize",
          identity: channel,
          profileId: person.id,
          policy,
          grant: null,
        },
        { assertCurrent() {} },
      );
      expect(reference).toMatchObject({ version: 1, id: expect.any(String) });
      if (!reference) {
        throw new Error("Expected persisted channel authorization");
      }
      await expect(
        prepareUserChannelIdentityAuthority({ authorizationId: reference.id, policy }),
      ).resolves.toMatchObject({ linked: { profileId: person.id, authorization: { reference } } });
    });

    it("reads configured command owner policy through the state reader", async () => {
      await publishCanonicalUserChannelPolicy(undefined, ["synthetic-owner"]);
      await expect(
        prepareConfiguredCommandOwnerAuthority(["synthetic-owner"]),
      ).resolves.toMatchObject({ recoveryReference: { version: 2, id: expect.any(String) } });
    });

    it("clears persisted channel custody when its policy changes", async () => {
      const person = profile("policy-custody");
      const channel = identity("policy-custody");
      await publishCanonicalUserChannelPolicy(undefined);
      await changeCanonicalUserChannelIdentity("link", person.id, channel);
      const subject = userChannelIdentitySubject(channel);
      seedCustody(subject);
      await publishCanonicalUserChannelPolicy({ roles: { definitions: {}, default: "member" } });
      expect(custody(subject)).toEqual({ authorization_id: null, authorization_basis_json: null });
    });
  },
);
