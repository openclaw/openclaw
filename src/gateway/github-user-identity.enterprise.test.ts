import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import {
  GIT_COAUTHOR_PREFERENCE_KEY,
  validateUsersSelfResult,
} from "../../packages/gateway-protocol/src/index.js";
import {
  prepareGitCoauthorAttribution,
  resolveGitCoauthorAttribution,
} from "../agents/git-coauthor-attribution.js";
import { captureRuntimeConfigAsyncReader } from "../config/io.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { recordSessionParticipant } from "../config/sessions/session-accessor.sqlite-participants.native.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { prepareUserProfileRoleAuthority } from "../state/user-channel-identity-operations.js";
import { getUserPreferences, setUserPreferences } from "../state/user-preferences.test-support.js";
import { getUserProfileListItem } from "../state/user-profile-list-item.test-support.js";
import { mergeCanonicalUserProfiles } from "../state/user-profile-writes.js";
import { linkEmail, syncGitHubIdentity } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGitHubPublicationContent } from "./github-publication-content.js";
import { createAuthenticatedGitHubIdentitySync } from "./github-user-identity.js";
import { createControlUiRequestOptions } from "./server-methods/control-ui-request.test-support.js";
import { identifiedClient } from "./server-methods/sessions-sharing.test-support.js";
import type { RespondFn } from "./server-methods/types.js";
import { usersHandlers } from "./server-methods/users.js";

function enterpriseSync(email?: string, host = "ghe.example.test") {
  return expectDefined(
    createAuthenticatedGitHubIdentitySync({
      authResult: { ok: true, method: "trusted-proxy", user: `github:${host}:101` },
      config: { gateway: { github: { host } } },
      authConfig: { mode: "trusted-proxy", trustedProxy: { userHeader: "x-factory-principal" } },
      requestHeaders: {
        "x-factory-github-login": "enterprise-ada",
        "x-factory-github-name": "Ada",
        ...(email ? { "x-factory-github-email": email } : {}),
      },
    }),
    "Enterprise GitHub identity sync",
  );
}

afterEach(() => vi.restoreAllMocks());

it.each(["ghe.example.test", "code.example.test"])(
  "carries configured %s identity through users.self and opted-in credit without public-ID collisions",
  async (host) => {
    const principal = `github:${host}:101`;
    await withOpenClawTestState(
      { scenario: "minimal", prepareProfileCatalog: true },
      async (state) => {
        await captureRuntimeConfigAsyncReader()();
        const transport = vi
          .spyOn(globalThis, "fetch")
          .mockRejectedValue(new Error("No external lookup allowed"));
        const publicProfile = syncGitHubIdentity({
          identity: { accountId: 101, login: "public-ada" },
          authenticationAlias: { kind: "email", email: "public@example.test" },
        });
        const profile = ensureProfileForEmail(principal);
        setUserPreferences(profile.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: true });
        const sync = enterpriseSync("ada@enterprise.example", host);
        expect((await sync()).profileId).toBe(profile.id);
        const client = {
          ...identifiedClient(profile.id),
          connId: "enterprise-credit",
          authenticatedGitHubIdentitySync: sync,
        };
        const respond = vi.fn<RespondFn>();
        const request = createControlUiRequestOptions(() => ({}))({}, respond, { client });
        await expectDefined(
          usersHandlers["users.self"],
          "users.self handler",
        )({ ...request, client });
        expect(respond).toHaveBeenCalledWith(true, {
          profile: expect.objectContaining({
            id: profile.id,
            emails: [principal],
            githubIdentity: {
              host,
              login: "enterprise-ada",
              profileUrl: `https://${host}/enterprise-ada`,
              avatarUrl: `https://${host}/avatars/u/101`,
            },
          }),
        });
        expect(validateUsersSelfResult(respond.mock.calls[0]?.[1])).toBe(true);
        respond.mockClear();
        await expectDefined(
          usersHandlers["users.list"],
          "users.list handler",
        )({ ...request, client });
        expect(respond).toHaveBeenCalledWith(true, {
          profiles: expect.arrayContaining([
            expect.objectContaining({
              id: profile.id,
              githubIdentity: expect.objectContaining({ host, login: "enterprise-ada" }),
            }),
          ]),
        });
        expect(JSON.stringify(respond.mock.calls[0]?.[1])).not.toContain("ada@enterprise.example");
        expect((await prepareUserProfileRoleAuthority(profile.id))?.githubLogin).toBeNull();
        expect(getUserProfileListItem(publicProfile.id).githubIdentity?.login).toBe("public-ada");
        const scope = {
          agentId: "main",
          env: state.env,
          sessionKey: "agent:main:enterprise-credit",
        };
        await upsertSessionEntryCore(scope, { sessionId: "enterprise-credit", updatedAt: 1 });
        for (const id of [profile.id, publicProfile.id]) {
          recordSessionParticipant(scope, {
            identity: { type: "profile", id },
            promptedAt: 1,
            sessionAgentId: "main",
          });
        }
        const params = { ...scope, config: { gateway: { github: { host } } } };
        const prepared = await prepareGitCoauthorAttribution(params);
        expect(prepared.attribution).toEqual({
          logins: ["enterprise-ada"],
          trailers: ["Co-authored-by: enterprise-ada <ada@enterprise.example>"],
        });
        expect(await resolveGitCoauthorAttribution({ ...scope, config: {} })).toEqual({
          logins: ["public-ada"],
          trailers: ["Co-authored-by: public-ada <101+public-ada@users.noreply.github.com>"],
        });
        const publication = {
          row: {
            request_id: "enterprise-credit",
            agent_id: "main",
            session_id: "enterprise-credit",
            session_key: scope.sessionKey,
            branch: "work",
            title: "Prepared change",
          },
          storePath: resolveSessionStorePathForScope(scope, {}),
          accountId: 999,
          assertCurrent: () => {},
          description: "Synthetic publication",
        };
        const content = await prepareGitHubPublicationContent({
          ...publication,
          host,
        });
        expect(content.trailers).toEqual([
          "Co-authored-by: enterprise-ada <ada@enterprise.example>",
        ]);
        expect(content.commitMessage).not.toContain("public-ada");
        const publicContent = await prepareGitHubPublicationContent({
          ...publication,
          host: "github.com",
        });
        expect(publicContent.trailers).toEqual([
          "Co-authored-by: public-ada <101+public-ada@users.noreply.github.com>",
        ]);
        setUserPreferences(profile.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: false });
        expect(prepared.isCurrent()).toBe(false);
        expect(() => content.assertAction()).toThrow("contributor credit changed");
        expect(await resolveGitCoauthorAttribution(params)).toBeUndefined();
        await enterpriseSync("ada@enterprise.example", host)();
        expect(getUserPreferences(profile.id, [GIT_COAUTHOR_PREFERENCE_KEY])).toEqual({
          [GIT_COAUTHOR_PREFERENCE_KEY]: false,
        });
        setUserPreferences(profile.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: true });
        await enterpriseSync(undefined, host)();
        expect(getUserProfileListItem(profile.id).githubIdentity?.login).toBe("enterprise-ada");
        expect(await resolveGitCoauthorAttribution(params)).toBeUndefined();
        expect(getUserPreferences(profile.id, [GIT_COAUTHOR_PREFERENCE_KEY])).toEqual({
          [GIT_COAUTHOR_PREFERENCE_KEY]: true,
        });
        expect(transport).not.toHaveBeenCalled();
      },
    );
  },
);

it("requires fresh sign-in after historical evidence or a principal alias move without importing preferences or email aliases", async () => {
  const principal = "github:ghe.example.test:101";
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const profile = ensureProfileForEmail(principal);
    const { db } = openOpenClawStateDatabase();
    linkEmail("anchor@example.test", profile.id);
    db.prepare(
      "INSERT INTO user_profile_identities(provider,subject,profile_id,canonical_login,verified_email_json,created_at) VALUES(?,?,?,?,?,1)",
    ).run(
      "github:ghe.example.test",
      "101",
      profile.id,
      "historical",
      JSON.stringify({ email: "old@example.test", profileId: profile.id }),
    );
    expect(getUserProfileListItem(profile.id).githubIdentity).toBeNull();
    await enterpriseSync("ada@enterprise.example")();
    expect(getUserProfileListItem(profile.id).githubIdentity?.login).toBe("enterprise-ada");
    const other = ensureProfileForEmail("other@example.test");
    linkEmail(principal, other.id);
    expect(getUserProfileListItem(other.id).githubIdentity).toBeNull();
    linkEmail(principal, profile.id);
    expect(getUserProfileListItem(profile.id).githubIdentity).toBeNull();
    await enterpriseSync("ada@enterprise.example")();
    expect(getUserProfileListItem(profile.id).githubIdentity?.login).toBe("enterprise-ada");
    expect(getUserProfileListItem(profile.id).emails).not.toContain("ada@enterprise.example");
    expect(getUserPreferences(profile.id, [GIT_COAUTHOR_PREFERENCE_KEY])).toEqual({});
  });
});

it.each([1, 2])(
  "preserves an enterprise opt-out through consecutive merges with %s enterprise hosts before refreshed sign-in",
  async (hostCount) => {
    await withOpenClawTestState(
      { scenario: "minimal", prepareProfileCatalog: true },
      async (state) => {
        await captureRuntimeConfigAsyncReader()();
        const source = await enterpriseSync("ada@enterprise.example")();
        if (hostCount === 2) {
          const secondary = await enterpriseSync("ada@other.example", "code.example.test")();
          await mergeCanonicalUserProfiles(secondary.profileId, source.profileId);
          await enterpriseSync("ada@other.example", "code.example.test")();
        }
        setUserPreferences(source.profileId, { [GIT_COAUTHOR_PREFERENCE_KEY]: false });
        const target = ensureProfileForEmail("survivor@example.test");
        const scope = {
          agentId: "main",
          env: state.env,
          sessionKey: "agent:main:merged-enterprise-credit",
        };
        await upsertSessionEntryCore(scope, {
          sessionId: "merged-enterprise-credit",
          updatedAt: 1,
        });
        recordSessionParticipant(scope, {
          identity: { type: "profile", id: source.profileId },
          promptedAt: 1,
          sessionAgentId: "main",
        });
        await mergeCanonicalUserProfiles(source.profileId, target.id);
        expect(getUserPreferences(target.id, [GIT_COAUTHOR_PREFERENCE_KEY])).toEqual({
          [GIT_COAUTHOR_PREFERENCE_KEY]: false,
        });
        const finalTarget = ensureProfileForEmail("final-survivor@example.test");
        await mergeCanonicalUserProfiles(target.id, finalTarget.id);
        expect(getUserPreferences(finalTarget.id, [GIT_COAUTHOR_PREFERENCE_KEY])).toEqual({
          [GIT_COAUTHOR_PREFERENCE_KEY]: false,
        });
        // Merging preserves consent, but never makes the transferred credit proof current.
        expect(
          await resolveGitCoauthorAttribution({
            ...scope,
            config: { gateway: { github: { host: "ghe.example.test" } } },
          }),
        ).toBeUndefined();
        expect((await enterpriseSync("ada@enterprise.example")()).profileId).toBe(finalTarget.id);
        expect(
          await resolveGitCoauthorAttribution({
            ...scope,
            config: { gateway: { github: { host: "ghe.example.test" } } },
          }),
        ).toBeUndefined();
      },
    );
  },
);

it("retains a public primary identity and host-selected credit after linking an enterprise account", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", prepareProfileCatalog: true },
    async (state) => {
      await captureRuntimeConfigAsyncReader()();
      const enterprise = await enterpriseSync("ada@enterprise.example")();
      const publicProfile = syncGitHubIdentity({
        identity: { accountId: 101, login: "public-ada" },
        authenticationAlias: { kind: "email", email: "public@example.test" },
      });
      await mergeCanonicalUserProfiles(enterprise.profileId, publicProfile.id);
      expect((await enterpriseSync("ada@enterprise.example")()).profileId).toBe(publicProfile.id);
      expect(getUserProfileListItem(publicProfile.id).githubIdentity).toEqual({
        login: "public-ada",
        profileUrl: "https://github.com/public-ada",
        avatarUrl: "https://avatars.githubusercontent.com/u/101?v=4",
      });
      const scope = {
        agentId: "main",
        env: state.env,
        sessionKey: "agent:main:mixed-enterprise-credit",
      };
      await upsertSessionEntryCore(scope, { sessionId: "mixed-enterprise-credit", updatedAt: 1 });
      recordSessionParticipant(scope, {
        identity: { type: "profile", id: publicProfile.id },
        promptedAt: 1,
        sessionAgentId: "main",
      });
      expect(await resolveGitCoauthorAttribution({ ...scope, config: {} })).toEqual({
        logins: ["public-ada"],
        trailers: ["Co-authored-by: public-ada <101+public-ada@users.noreply.github.com>"],
      });
      expect(
        await resolveGitCoauthorAttribution({
          ...scope,
          config: { gateway: { github: { host: "ghe.example.test" } } },
        }),
      ).toEqual({
        logins: ["enterprise-ada"],
        trailers: ["Co-authored-by: enterprise-ada <ada@enterprise.example>"],
      });
    },
  );
});

it("keeps global consent writable without a display primary after merging two enterprise hosts", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", prepareProfileCatalog: true },
    async (state) => {
      await captureRuntimeConfigAsyncReader()();
      const first = await enterpriseSync("ada@enterprise.example")();
      const second = await enterpriseSync("ada@other.example", "code.example.test")();
      await mergeCanonicalUserProfiles(second.profileId, first.profileId);
      const sync = enterpriseSync("ada@enterprise.example");
      await sync();
      expect((await enterpriseSync("ada@other.example", "code.example.test")()).profileId).toBe(
        first.profileId,
      );
      const client = {
        ...identifiedClient(first.profileId),
        connId: "multi-host-consent",
        authenticatedGitHubIdentitySync: sync,
      };
      const respond = vi.fn<RespondFn>();
      const requestOptions = createControlUiRequestOptions(() => ({}));
      await expectDefined(
        usersHandlers["users.self"],
        "users.self handler",
      )({
        ...requestOptions({}, respond, { client }),
        client,
      });
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
        profile: expect.objectContaining({ id: first.profileId, githubIdentity: null }),
      });
      expect(validateUsersSelfResult(respond.mock.calls[0]?.[1])).toBe(true);
      expect(JSON.stringify(respond.mock.calls[0]?.[1])).not.toContain("ada@");

      const scope = {
        agentId: "main",
        env: state.env,
        sessionKey: "agent:main:multi-host-consent",
      };
      await upsertSessionEntryCore(scope, { sessionId: "multi-host-consent", updatedAt: 1 });
      recordSessionParticipant(scope, {
        identity: { type: "profile", id: second.profileId },
        promptedAt: 1,
        sessionAgentId: "main",
      });
      const publication = {
        row: {
          request_id: "multi-host-consent",
          agent_id: "main",
          session_id: "multi-host-consent",
          session_key: scope.sessionKey,
          branch: "work",
          title: "Prepared change",
        },
        storePath: resolveSessionStorePathForScope(scope, {}),
        accountId: 999,
        assertCurrent: () => {},
        description: "Synthetic publication",
      };
      const firstContent = await prepareGitHubPublicationContent({
        ...publication,
        host: "ghe.example.test",
      });
      const secondContent = await prepareGitHubPublicationContent({
        ...publication,
        host: "code.example.test",
      });
      expect(firstContent.trailers).toEqual([
        "Co-authored-by: enterprise-ada <ada@enterprise.example>",
      ]);
      expect(secondContent.trailers).toEqual([
        "Co-authored-by: enterprise-ada <ada@other.example>",
      ]);
      respond.mockClear();
      await expectDefined(
        usersHandlers["users.prefs.set"],
        "users.prefs.set handler",
      )({
        ...requestOptions({ entries: { [GIT_COAUTHOR_PREFERENCE_KEY]: false } }, respond, {
          client,
        }),
        client,
      });
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, { status: "ok" }, undefined);
      await enterpriseSync("ada@enterprise.example")();
      respond.mockClear();
      await expectDefined(
        usersHandlers["users.prefs.get"],
        "users.prefs.get handler",
      )({
        ...requestOptions({ keys: [GIT_COAUTHOR_PREFERENCE_KEY] }, respond, { client }),
        client,
      });
      expect(respond).toHaveBeenCalledExactlyOnceWith(
        true,
        { status: "ok", entries: { [GIT_COAUTHOR_PREFERENCE_KEY]: false } },
        undefined,
      );
      expect(() => firstContent.assertAction()).toThrow("contributor credit changed");
      expect(() => secondContent.assertAction()).toThrow("contributor credit changed");
      for (const host of ["ghe.example.test", "code.example.test"]) {
        expect((await prepareGitHubPublicationContent({ ...publication, host })).trailers).toEqual(
          [],
        );
      }
    },
  );
});
