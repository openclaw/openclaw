import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import {
  GIT_COAUTHOR_PREFERENCE_KEY as CREDIT_KEY,
  validateUsersSelfResult,
} from "../../packages/gateway-protocol/src/index.js";
import {
  prepareGitCoauthorAttribution,
  resolveGitCoauthorAttribution,
} from "../agents/git-coauthor-attribution.js";
import { captureRuntimeConfigAsyncReader } from "../config/io.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { recordSessionParticipant } from "../config/sessions/session-accessor.sqlite-participants.native.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { prepareUserProfileRoleAuthority } from "../state/user-channel-identity-operations.js";
import { getUserPreferences, setUserPreferences } from "../state/user-preferences.test-support.js";
import { getUserProfileListItem } from "../state/user-profile-list-item.test-support.js";
import { mergeCanonicalUserProfiles } from "../state/user-profile-writes.js";
import { linkEmail, syncGitHubIdentity } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
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

async function creditSession(env: NodeJS.ProcessEnv, id: string, participants: string[]) {
  const scope = { agentId: "main", env, sessionKey: `agent:main:${id}` };
  await upsertSessionEntryCore(scope, { sessionId: id, updatedAt: 1 });
  for (const profileId of participants) {
    recordSessionParticipant(scope, {
      identity: { type: "profile", id: profileId },
      promptedAt: 1,
      sessionAgentId: "main",
    });
  }
  return scope;
}

function publicationFor(scope: Awaited<ReturnType<typeof creditSession>>, host: string) {
  const id = scope.sessionKey.slice("agent:main:".length);
  return prepareGitHubPublicationContent({
    host,
    row: {
      request_id: id,
      agent_id: "main",
      session_id: id,
      session_key: scope.sessionKey,
      branch: "work",
      title: "Prepared change",
    },
    storePath: resolveSessionStorePathForScope(scope, {}),
    accountId: 999,
    assertCurrent: () => {},
    readCurrentEntry: () => loadSessionEntryReadOnly(scope),
    description: "Synthetic publication",
  });
}

function userRequests(profileId: string, connId: string, sync: ReturnType<typeof enterpriseSync>) {
  const client = { ...identifiedClient(profileId), connId, authenticatedGitHubIdentitySync: sync };
  const respond = vi.fn<RespondFn>();
  const options = createControlUiRequestOptions(() => ({}));
  return {
    respond,
    call: (method: keyof typeof usersHandlers, params: Record<string, unknown> = {}) =>
      expectDefined(
        usersHandlers[method],
        `${method} handler`,
      )({
        ...options(params, respond, { client }),
        client,
      }),
  };
}

afterEach(() => vi.restoreAllMocks());

function withCreditState(run: (state: OpenClawTestState) => Promise<void>) {
  return withOpenClawTestState(
    { scenario: "minimal", prepareProfileCatalog: true },
    async (state) => {
      await captureRuntimeConfigAsyncReader()();
      await run(state);
    },
  );
}

const enterpriseCredit = {
  logins: ["enterprise-ada"],
  trailers: ["Co-authored-by: enterprise-ada <ada@enterprise.example>"],
};
const publicCredit = {
  logins: ["public-ada"],
  trailers: ["Co-authored-by: public-ada <101+public-ada@users.noreply.github.com>"],
};
const optedIn = { [CREDIT_KEY]: true };
const optedOut = { [CREDIT_KEY]: false };

function publicProfile() {
  return syncGitHubIdentity({
    identity: { accountId: 101, login: "public-ada" },
    authenticationAlias: { kind: "email", email: "public@example.test" },
  });
}

function enterpriseAttribution(scope: Awaited<ReturnType<typeof creditSession>>) {
  return resolveGitCoauthorAttribution({
    ...scope,
    config: { gateway: { github: { host: "ghe.example.test" } } },
  });
}

it.each(["ghe.example.test", "code.example.test"])(
  "carries configured %s identity through users.self and opted-in credit without public-ID collisions",
  async (host) => {
    const principal = `github:${host}:101`;
    await withCreditState(async (state) => {
      const transport = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("No external lookup allowed"));
      const publicUser = publicProfile();
      const profile = ensureProfileForEmail(principal);
      setUserPreferences(profile.id, optedIn);
      const sync = enterpriseSync("ada@enterprise.example", host);
      expect((await sync()).profileId).toBe(profile.id);
      const { respond, call } = userRequests(profile.id, "enterprise-credit", sync);
      await call("users.self");
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
      await call("users.list");
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
      expect(getUserProfileListItem(publicUser.id).githubIdentity?.login).toBe("public-ada");
      const scope = await creditSession(state.env, "enterprise-credit", [
        profile.id,
        publicUser.id,
      ]);
      const params = { ...scope, config: { gateway: { github: { host } } } };
      const prepared = await prepareGitCoauthorAttribution(params);
      expect(prepared.attribution).toEqual(enterpriseCredit);
      expect(await resolveGitCoauthorAttribution({ ...scope, config: {} })).toEqual(publicCredit);
      const content = await publicationFor(scope, host);
      expect(content.trailers).toEqual(enterpriseCredit.trailers);
      expect(content.commitMessage).not.toContain("public-ada");
      const publicContent = await publicationFor(scope, "github.com");
      expect(publicContent.trailers).toEqual(publicCredit.trailers);
      setUserPreferences(profile.id, optedOut);
      expect(prepared.isCurrent()).toBe(false);
      expect(() => content.assertAction()).toThrow("contributor credit changed");
      expect(await resolveGitCoauthorAttribution(params)).toBeUndefined();
      await enterpriseSync("ada@enterprise.example", host)();
      expect(getUserPreferences(profile.id, [CREDIT_KEY])).toEqual(optedOut);
      setUserPreferences(profile.id, optedIn);
      await enterpriseSync(undefined, host)();
      expect(getUserProfileListItem(profile.id).githubIdentity?.login).toBe("enterprise-ada");
      expect(await resolveGitCoauthorAttribution(params)).toBeUndefined();
      expect(getUserPreferences(profile.id, [CREDIT_KEY])).toEqual(optedIn);
      expect(transport).not.toHaveBeenCalled();
    });
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
    expect(getUserPreferences(profile.id, [CREDIT_KEY])).toEqual({});
  });
});

it.each([1, 2])(
  "preserves an enterprise opt-out through consecutive merges with %s enterprise hosts before refreshed sign-in",
  async (hostCount) => {
    await withCreditState(async (state) => {
      const source = await enterpriseSync("ada@enterprise.example")();
      if (hostCount === 2) {
        const secondary = await enterpriseSync("ada@other.example", "code.example.test")();
        await mergeCanonicalUserProfiles(secondary.profileId, source.profileId);
        await enterpriseSync("ada@other.example", "code.example.test")();
      }
      setUserPreferences(source.profileId, optedOut);
      const target = ensureProfileForEmail("survivor@example.test");
      const scope = await creditSession(state.env, "merged-enterprise-credit", [source.profileId]);
      await mergeCanonicalUserProfiles(source.profileId, target.id);
      expect(getUserPreferences(target.id, [CREDIT_KEY])).toEqual(optedOut);
      const finalTarget = ensureProfileForEmail("final-survivor@example.test");
      await mergeCanonicalUserProfiles(target.id, finalTarget.id);
      expect(getUserPreferences(finalTarget.id, [CREDIT_KEY])).toEqual(optedOut);
      // Merging preserves consent, but never makes the transferred credit proof current.
      expect(await enterpriseAttribution(scope)).toBeUndefined();
      expect((await enterpriseSync("ada@enterprise.example")()).profileId).toBe(finalTarget.id);
      expect(await enterpriseAttribution(scope)).toBeUndefined();
    });
  },
);

it("retains a public primary identity and host-selected credit after linking an enterprise account", async () => {
  await withCreditState(async (state) => {
    const enterprise = await enterpriseSync("ada@enterprise.example")();
    const publicUser = publicProfile();
    await mergeCanonicalUserProfiles(enterprise.profileId, publicUser.id);
    expect((await enterpriseSync("ada@enterprise.example")()).profileId).toBe(publicUser.id);
    expect(getUserProfileListItem(publicUser.id).githubIdentity).toEqual({
      login: "public-ada",
      profileUrl: "https://github.com/public-ada",
      avatarUrl: "https://avatars.githubusercontent.com/u/101?v=4",
    });
    const scope = await creditSession(state.env, "mixed-enterprise-credit", [publicUser.id]);
    expect(await resolveGitCoauthorAttribution({ ...scope, config: {} })).toEqual(publicCredit);
    expect(await enterpriseAttribution(scope)).toEqual(enterpriseCredit);
  });
});

it("keeps global consent writable without a display primary after merging two enterprise hosts", async () => {
  await withCreditState(async (state) => {
    const first = await enterpriseSync("ada@enterprise.example")();
    const second = await enterpriseSync("ada@other.example", "code.example.test")();
    await mergeCanonicalUserProfiles(second.profileId, first.profileId);
    const sync = enterpriseSync("ada@enterprise.example");
    await sync();
    expect((await enterpriseSync("ada@other.example", "code.example.test")()).profileId).toBe(
      first.profileId,
    );
    const { respond, call } = userRequests(first.profileId, "multi-host-consent", sync);
    await call("users.self");
    expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
      profile: expect.objectContaining({ id: first.profileId, githubIdentity: null }),
    });
    expect(validateUsersSelfResult(respond.mock.calls[0]?.[1])).toBe(true);
    expect(JSON.stringify(respond.mock.calls[0]?.[1])).not.toContain("ada@");

    const scope = await creditSession(state.env, "multi-host-consent", [second.profileId]);
    const firstContent = await publicationFor(scope, "ghe.example.test");
    const secondContent = await publicationFor(scope, "code.example.test");
    expect(firstContent.trailers).toEqual(enterpriseCredit.trailers);
    expect(secondContent.trailers).toEqual(["Co-authored-by: enterprise-ada <ada@other.example>"]);
    respond.mockClear();
    await call("users.prefs.set", { entries: optedOut });
    expect(respond).toHaveBeenCalledExactlyOnceWith(true, { status: "ok" }, undefined);
    await enterpriseSync("ada@enterprise.example")();
    respond.mockClear();
    await call("users.prefs.get", { keys: [CREDIT_KEY] });
    expect(respond).toHaveBeenCalledExactlyOnceWith(
      true,
      { status: "ok", entries: optedOut },
      undefined,
    );
    expect(() => firstContent.assertAction()).toThrow("contributor credit changed");
    expect(() => secondContent.assertAction()).toThrow("contributor credit changed");
    for (const host of ["ghe.example.test", "code.example.test"]) {
      expect((await publicationFor(scope, host)).trailers).toEqual([]);
    }
  });
});
