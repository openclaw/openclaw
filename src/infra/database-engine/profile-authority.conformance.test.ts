import { describe, expect, it } from "vitest";
import { GIT_COAUTHOR_PREFERENCE_KEY } from "../../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { sessionSqlFixture } from "../../commands/doctor-session-sqlite.sql.test-support.js";
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
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withEngineStoreAdmission as admit } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

const writeProfile = (run: (sql: ReturnType<typeof sessionSqlFixture>) => void) =>
  admit(() => runOpenClawStateWriteTransaction(({ db }) => run(sessionSqlFixture(db))));

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
        return sessionSqlFixture(db)`SELECT authorization_id, authorization_basis_json
          FROM user_profile_identities WHERE subject = ${subject}`.get();
      });
    const seedCustody = (subject: string) =>
      writeProfile((sql) =>
        sql`UPDATE user_profile_identities SET authorization_id = ${`synthetic-custody:${subject}`},
          authorization_basis_json = 'null' WHERE subject = ${subject}`.run(),
      );

    it("persists and removes coauthor preferences through the state worker", async () => {
      const person = profile("coauthor");
      for (const value of [true, null]) {
        await expect(
          setCanonicalUserPreferences(person.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: value }),
        ).resolves.toMatchObject({ ok: true });
        await expect(getCanonicalUserPreferences(person.id)).resolves.toEqual({
          profileId: person.id,
          entries: value === null ? {} : { [GIT_COAUTHOR_PREFERENCE_KEY]: true },
        });
      }
    });

    it("writes and resolves a role through the state worker and clears recovery custody", async () => {
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

    it("persists channel authority until its policy changes", async () => {
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
      const subject = userChannelIdentitySubject(channel);
      seedCustody(subject);
      await publishCanonicalUserChannelPolicy({ roles: { definitions: {}, default: "member" } });
      expect(custody(subject)).toEqual({ authorization_id: null, authorization_basis_json: null });
    });

    it("reads configured command owner policy through the state reader", async () => {
      await publishCanonicalUserChannelPolicy(undefined, ["synthetic-owner"]);
      await expect(
        prepareConfiguredCommandOwnerAuthority(["synthetic-owner"]),
      ).resolves.toMatchObject({ recoveryReference: { version: 2, id: expect.any(String) } });
    });
  },
);
