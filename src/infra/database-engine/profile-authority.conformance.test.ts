import { MessagePort, receiveMessageOnPort } from "node:worker_threads";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { GIT_COAUTHOR_PREFERENCE_KEY } from "../../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { sessionSqlFixture } from "../../commands/doctor-session-sqlite.sql.test-support.js";
import { authorizationClient } from "../../gateway/server-methods.authorization.test-support.js";
import { preparePersonalProfileAction } from "../../gateway/server-methods/personal-profile-authorization.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
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
import { prepareProfileAuthorityRead } from "../../state/user-profile-authority.js";
import { captureUserProfileAuthorityRead } from "../../state/user-profile-events.js";
import { setCanonicalUserProfileRole } from "../../state/user-profile-writes.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import type { BridgeRequest } from "../postgres-sync/protocol.js";
import { isPostgresSqlConnection } from "../sql-connection.js";
import { withEngineStoreAdmission as admit } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

// Drop only an acknowledged real COMMIT reply; every other bridge operation stays native.
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return { ...actual, receiveMessageOnPort: vi.fn(actual.receiveMessageOnPort) };
});

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
    const prepareAction = (person: ReturnType<typeof profile>) => {
      const connId = "profile-authority";
      const client = authorizationClient(connId, ["operator.write"], {
        authenticatedUserProfile: {
          profileId: person.id,
          displayName: null,
          hasAvatar: false,
          updatedAt: person.updatedAt,
        },
      });
      const context = {
        getRuntimeConfig: () => ({}),
        getClientConnIds: (filter?: (candidate: typeof client) => boolean) =>
          new Set(!filter || filter(client) ? [connId] : []),
      } as GatewayRequestContext;
      return preparePersonalProfileAction({ client, context }, "operator.write");
    };
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

    it.each([false, true])(
      "fences production action and transferred readers at native COMMIT (rollback=%s)",
      async (rollback) => {
        const person = profile(`native-fence-${rollback}`);
        const action = await prepareAction(person);
        const authority = await captureUserProfileAuthorityRead(
          captureOpenClawStateWorkerContext({}).admission,
        );
        const bound = authority.bind(person.id)!;
        const readBound = prepareProfileAuthorityRead(structuredClone(bound.transferable));
        const readSettled = prepareProfileAuthorityRead(
          structuredClone(authority.transferSettled(person.id)),
        );
        const perform = (value: boolean) =>
          setCanonicalUserPreferences(
            person.id,
            { "synthetic.authority": value },
            { assertCurrent: action.assertCurrent },
          );
        await expect(perform(true)).resolves.toMatchObject({ ok: true });

        const { db } = admit(() => openOpenClawStateDatabase());
        const execute = db.exec.bind(db);
        let commits = 0;
        using _commit = vi.spyOn(db, "exec").mockImplementation((sql) => {
          if (sql === "COMMIT") {
            commits++;
            expect([bound(), readBound(), readSettled()]).toEqual([false, "pending", "pending"]);
            expect(() => authority.assertSettled(person.id)).toThrow("has not settled");
            expect(action.assertCurrent).toThrow("Personal profile owner changed");
            if (rollback) {
              throw new Error("synthetic native COMMIT refusal");
            }
          }
          return execute(sql);
        });
        const mutate = () =>
          admit(() =>
            runOpenClawStateWriteTransaction(() => {
              setUserProfileRole(person.id, "member");
              expect([bound(), readBound(), readSettled()]).toEqual([true, "current", "current"]);
            }),
          );
        if (rollback) {
          expect(mutate).toThrow("synthetic native COMMIT refusal");
          await expect(perform(false)).resolves.toMatchObject({ ok: true });
        } else {
          mutate();
          await expect(perform(false)).rejects.toThrow("Personal profile owner changed");
        }
        expect(commits).toBe(1);
        expect([bound(), readBound(), readSettled()]).toEqual([
          rollback,
          rollback ? "current" : "revoked",
          "current",
        ]);
        expect(() => authority.assertSettled(person.id)).not.toThrow();
        await expect(getCanonicalUserPreferences(person.id)).resolves.toMatchObject({
          entries: { "synthetic.authority": !rollback },
        });
      },
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

    it.runIf(engine === "postgres")(
      "keeps production authority closed after losing a real COMMIT reply",
      async () => {
        const person = profile("lost-role-commit");
        const action = await prepareAction(person);
        const authority = await captureUserProfileAuthorityRead(
          captureOpenClawStateWorkerContext({}).admission,
        );
        const bound = authority.bind(person.id)!;
        const readBound = prepareProfileAuthorityRead(structuredClone(bound.transferable));
        const readSettled = prepareProfileAuthorityRead(
          structuredClone(authority.transferSettled(person.id)),
        );
        expect([bound(), readBound(), readSettled()]).toEqual([true, "current", "current"]);
        const { db } = admit(() => openOpenClawStateDatabase());
        if (!isPostgresSqlConnection(db)) {
          throw new Error("Expected the configured PostgreSQL state owner");
        }
        const close = db.close.bind(db);
        let beforeClose: string | undefined;
        using _closed = vi.spyOn(db, "close").mockImplementation(() => {
          beforeClose = readSettled();
          return close();
        });
        const actual =
          await vi.importActual<typeof import("node:worker_threads")>("node:worker_threads");
        using sent = vi.spyOn(MessagePort.prototype, "postMessage");
        let dropped = 0;
        vi.mocked(receiveMessageOnPort).mockImplementation((port) => {
          const received = actual.receiveMessageOnPort(port);
          const index = sent.mock.contexts.findLastIndex((source) => source === port);
          const request = sent.mock.calls[index]?.[0] as BridgeRequest | undefined;
          if (
            request?.operation === "query" &&
            request.sql === "COMMIT" &&
            received?.message.id === request.id
          ) {
            expect(received.message.result.command).toBe("COMMIT");
            dropped++;
            return undefined;
          }
          return received;
        });
        try {
          expect(() => admit(() => setUserProfileRole(person.id, "member"))).toThrow(
            expect.objectContaining({ code: "outcome-unknown" }),
          );
        } finally {
          vi.mocked(receiveMessageOnPort).mockImplementation(actual.receiveMessageOnPort);
        }
        expect(dropped).toBe(1);
        expect(beforeClose).toBe("uncertain");
        expect([bound(), readBound(), readSettled()]).toEqual([false, "uncertain", "uncertain"]);
        expect(() => authority.assertSettled(person.id)).toThrow("requires canonical recovery");
        await expect(
          setCanonicalUserPreferences(
            person.id,
            { "synthetic.authority": false },
            { assertCurrent: action.assertCurrent },
          ),
        ).rejects.toThrow("Personal profile owner changed");
        const observer = new Client({ connectionString: mixedAgentConnection });
        await observer.connect();
        try {
          const durable = await observer.query(
            `SELECT role FROM "${db.schema}".user_profiles WHERE id = $1`,
            [person.id],
          );
          expect(durable.rows).toEqual([{ role: "member" }]);
        } finally {
          await observer.end();
        }
      },
    );
  },
);
