// A device-code approval (RFC 8628) does not show who approved it, so a device sign-in only
// recognizes an existing OpenClaw ID link and never creates a profile's first one. Real profile state.
import { afterAll, beforeAll, expect, vi } from "vitest";
import { bytesToBase64url } from "../../../packages/openclaw-id-protocol/src/index.js";
import { stateTest } from "../../plugin-state/plugin-state-fixtures.test-support.js";
import {
  linkCanonicalOpenClawIdUserProfile,
  readOpenClawIdLinkedProfile,
  readOpenClawIdLinksOfProfile,
} from "../../state/user-profile-openclaw-id.js";
import { ensureCanonicalUserProfileForEmail } from "../../state/user-profile-writes.js";
import type { GatewayRequestHandlerOptions } from "../server-methods/types.js";
import { readStoredClaw, writeStoredClaw } from "./claw-store.js";
import { linkedClaw, ownerInvite, redemptionMail, serviceFor } from "./openclaw-id.test-support.js";

const ISSUER = "https://issuer.example.test/api/auth";
const PROFILE_EMAIL = "person@example.test";

// The personal-profile authority owner has its own tests; here it admits the caller's profile.
vi.mock("../server-methods/personal-profile-authorization.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server-methods/personal-profile-authorization.js")>()),
  preparePersonalProfileAction: vi.fn(
    async (opts: { client: { authenticatedUserProfile: { profileId: string } } }) => ({
      owner: opts.client.authenticatedUserProfile.profileId,
      signal: new AbortController().signal,
      assertCurrent: () => {},
    }),
  ),
}));

function idToken(claims: Record<string, unknown>) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part(claims)}.sig`;
}

// The account that approved the user code; by default a second account with the profile's email.
let approver = "ocid-other";
// Extra ID token claims for the next device sign-in (email, email_verified).
let claims: Record<string, unknown> = {};
let handlers: typeof import("../server-methods/openclaw-id.js").openclawIdHandlers;

beforeAll(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/.well-known/openid-configuration")) {
        return Response.json({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/oauth2/authorize`,
          token_endpoint: `${ISSUER}/oauth2/token`,
          device_authorization_endpoint: `${ISSUER}/oauth2/device-authorization`,
        });
      }
      if (url.endsWith("/oauth2/device-authorization")) {
        return Response.json({
          device_code: "dc",
          user_code: "WDJB-MJHT",
          verification_uri: "https://issuer.example.test/device",
          expires_in: 600,
          interval: 0.001,
        });
      }
      return Response.json({
        id_token: idToken({
          iss: ISSUER,
          aud: "control-ui",
          sub: approver,
          exp: Math.floor(Date.now() / 1000) + 3600,
          email: PROFILE_EMAIL,
          ...claims,
        }),
      });
    }),
  );
  // The sign-in flow captures fetch when the handler module loads.
  ({ openclawIdHandlers: handlers } = await import("../server-methods/openclaw-id.js"));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const config = {
  gateway: { openclawId: { enabled: true, issuerUrl: ISSUER, clientId: "control-ui" } },
};

async function call(client: { connId: string }, params: Record<string, unknown>) {
  let reply: { ok: boolean; payload?: unknown; code?: string } | undefined;
  await handlers["openclawId.account"]!({
    params,
    client,
    respond: (ok: boolean, payload?: unknown, error?: { details?: { code?: string } }) => {
      reply = { ok, payload, code: error?.details?.code };
    },
    context: {
      getRuntimeConfig: () => config,
      getClientConnIds: (match: (candidate: unknown) => boolean) =>
        new Set([client].filter(match).map((current) => current.connId)),
    },
  } as unknown as GatewayRequestHandlerOptions);
  return reply!;
}

// openclawId.authority and openclawId.people for `client`, against a running service.
async function authorityCall(
  method: "openclawId.authority" | "openclawId.people",
  client: object,
  service: unknown,
  params: Record<string, unknown> = {},
) {
  let reply: { ok: boolean; payload?: unknown; code?: string } | undefined;
  await handlers[method]!({
    params,
    client,
    respond: (ok: boolean, payload?: unknown, error?: { details?: { code?: string } }) => {
      reply = { ok, payload, code: error?.details?.code };
    },
    context: { openclawIdService: service, getRuntimeConfig: () => config },
  } as unknown as GatewayRequestHandlerOptions);
  return reply!;
}

async function deviceSignIn(client: { connId: string }, link: boolean) {
  const started = await call(client, { action: "device_begin" });
  const state = (started.payload as { state: string }).state;
  await new Promise((resolve) => {
    setTimeout(resolve, 5);
  });
  return await call(client, { action: "device_poll", state, link });
}

const it = stateTest("openclaw-id-account-link-persistence");

it("a device grant from another account never creates a profile's first link", async ({
  state,
}) => {
  state.applyEnv();
  approver = "ocid-other";
  const existingProfile = await ensureCanonicalUserProfileForEmail(PROFILE_EMAIL);
  const connection = {
    connId: "conn-person",
    connect: { role: "operator", scopes: ["operator.read"] },
    internal: { authenticatedOperator: true },
    authenticatedUserProfile: { profileId: existingProfile.id },
  };

  const polled = await deviceSignIn(connection, true);
  expect(polled).toMatchObject({
    ok: true,
    payload: { account: { sub: "ocid-other" }, link: "link_approval_required" },
  });
  const { idToken: held } = polled.payload as { idToken: string };
  expect(await call(connection, { action: "link_held", idToken: held })).toMatchObject({
    ok: true,
    payload: { link: "link_approval_required" },
  });
  expect(await readOpenClawIdLinkedProfile("ocid-other")).toBeNull();
  expect(await readOpenClawIdLinksOfProfile(existingProfile.id)).toEqual([]);

  // A binding approved elsewhere (here written directly) is still recognized after sign-in.
  approver = "ocid-person";
  expect(
    await linkCanonicalOpenClawIdUserProfile({
      profileId: existingProfile.id,
      accountId: "ocid-person",
      email: PROFILE_EMAIL,
    }),
  ).toEqual({ ok: true });
  expect(await deviceSignIn(connection, true)).toMatchObject({
    ok: true,
    payload: { account: { sub: "ocid-person" }, link: "linked" },
  });
  // Another account on the now-linked profile is told to unlink first, and is not added.
  approver = "ocid-other";
  expect(await deviceSignIn(connection, true)).toMatchObject({
    ok: true,
    payload: { account: { sub: "ocid-other" }, link: "profile_linked" },
  });
  expect(await readOpenClawIdLinkedProfile("ocid-other")).toBeNull();
  expect(await readOpenClawIdLinksOfProfile(existingProfile.id)).toEqual([
    { accountId: "ocid-person", email: PROFILE_EMAIL },
  ]);
});

it("links an admin's profile through the owner browser's invite, redeemed by the admin's account", async ({
  state,
}) => {
  state.applyEnv();
  approver = "ocid-person";
  const existingProfile = await ensureCanonicalUserProfileForEmail(PROFILE_EMAIL);
  // The admin's personal connection, as after turning on remote access over Tailscale.
  const personal = {
    connId: "conn-person",
    connect: { role: "operator", scopes: ["operator.read"] },
    internal: { authenticatedOperator: true },
    authenticatedUserProfile: { profileId: existingProfile.id },
  };
  // An approved owner browser: the direct-loopback operator here.
  const ownerBrowser = { connId: "conn-owner", internal: { isLocalClient: true } };
  const claw = await linkedClaw({ read: readStoredClaw, write: writeStoredClaw });
  const { service } = serviceFor(claw.authority);
  try {
    // 1. The setup connection signs in; the account is not linked yet.
    const signedIn = await deviceSignIn(personal, true);
    expect(signedIn).toMatchObject({ ok: true, payload: { link: "link_approval_required" } });
    const { idToken: held } = signedIn.payload as { idToken: string };

    // 2. The setup connection cannot see People or register an invite.
    expect(await authorityCall("openclawId.people", personal, service)).toMatchObject({
      ok: false,
      code: "not_owner",
    });
    const invite = await ownerInvite(claw, { email: PROFILE_EMAIL });
    const register = {
      action: "register_invite",
      cap: invite.cap,
      proofKey: bytesToBase64url(invite.proofKey),
      existingProfileId: existingProfile.id,
    };
    expect(await authorityCall("openclawId.authority", personal, service, register)).toMatchObject({
      ok: false,
      code: "not_direct",
    });

    // 3. The owner browser offers the profile and registers the invite for it.
    const people = await authorityCall("openclawId.people", ownerBrowser, service);
    expect(people).toMatchObject({ ok: true });
    expect(
      (people.payload as { link: { existingProfiles: unknown } }).link.existingProfiles,
    ).toEqual([{ id: existingProfile.id, displayName: "person" }]);
    expect(
      await authorityCall("openclawId.authority", ownerBrowser, service, register),
    ).toMatchObject({ ok: true });

    // 4. The admin's account redeems the invite link. The /join page and Discovery mailbox are
    // outside this repository; the redemption arrives as the mailbox reader delivers it.
    const mail = await redemptionMail({
      clawId: claw.clawId,
      inviteId: invite.inviteId,
      proofKey: invite.proofKey,
      accountId: "ocid-person",
      email: PROFILE_EMAIL,
    });
    expect(
      await claw.authority.redeem(mail.message.payload.redemption, mail.message.from),
    ).toMatchObject({ ok: true });
    expect(await readOpenClawIdLinkedProfile("ocid-person")).toBeNull();

    // 5. The setup connection cannot approve; the owner browser approves in People.
    const approval = {
      action: "submit",
      statement: await claw.sign({
        op: "add",
        account_id: "ocid-person",
        role: "operator",
        peer_keys: [mail.peerKey],
        invite_id: invite.inviteId,
      }),
    };
    expect(await authorityCall("openclawId.authority", personal, service, approval)).toMatchObject({
      ok: false,
      code: "not_direct",
    });
    expect(await readOpenClawIdLinkedProfile("ocid-person")).toBeNull();
    expect(
      await authorityCall("openclawId.authority", ownerBrowser, service, approval),
    ).toMatchObject({ ok: true });

    // 6. The link is on the admin's profile, and the setup connection now sees it.
    expect(await readOpenClawIdLinksOfProfile(existingProfile.id)).toEqual([
      { accountId: "ocid-person", email: PROFILE_EMAIL },
    ]);
    expect(await call(personal, { action: "link_held", idToken: held })).toMatchObject({
      ok: true,
      payload: { link: "linked" },
    });
  } finally {
    await service.stop();
  }
});

// A personal connection whose own sign-in verified `ownEmail`, as a Tailscale or trusted-proxy
// login does; `undefined` models a login that is not an email address.
function personalConnection(profileId: string, ownEmail: string | undefined, connId: string) {
  return {
    connId,
    connect: { role: "operator", scopes: ["operator.read"] },
    internal: { authenticatedOperator: true },
    authenticatedUserProfile: { profileId },
    ...(ownEmail === undefined ? {} : { authenticatedUserId: ownEmail }),
  };
}

it("links a first account only when its verified email is this sign-in's own email", async ({
  state,
}) => {
  state.applyEnv();
  const cases: Array<{
    name: string;
    own: string | undefined;
    tokenClaims: Record<string, unknown>;
    linked: boolean;
    /** The account reports exactly the profile's own email alias. */
    reportsAlias?: boolean;
  }> = [
    {
      name: "same verified email",
      own: PROFILE_EMAIL,
      tokenClaims: { email_verified: true },
      linked: true,
    },
    {
      name: "case and spacing that normalize equal",
      own: PROFILE_EMAIL,
      tokenClaims: { email: "  Person@EXAMPLE.test ", email_verified: true },
      linked: true,
    },
    {
      name: "unverified email",
      own: PROFILE_EMAIL,
      tokenClaims: { email_verified: false },
      linked: false,
    },
    { name: "missing email_verified", own: PROFILE_EMAIL, tokenClaims: {}, linked: false },
    {
      name: "string email_verified",
      own: PROFILE_EMAIL,
      tokenClaims: { email_verified: "true" },
      linked: false,
    },
    {
      name: "different verified email",
      own: PROFILE_EMAIL,
      tokenClaims: { email: "someone@example.test", email_verified: true },
      linked: false,
    },
    {
      name: "the profile's alias while this sign-in's email differs",
      own: "other-login@example.test",
      tokenClaims: { email_verified: true },
      linked: false,
      reportsAlias: true,
    },
    {
      name: "a sign-in without an email",
      own: undefined,
      tokenClaims: { email_verified: true },
      linked: false,
    },
    {
      name: "a provider login",
      own: "person@github",
      tokenClaims: { email: "person@github", email_verified: true },
      linked: false,
    },
    ...[
      "person@exampIe.test",
      "per son@example.test",
      "person+1@example.test",
      "person@example.test.",
      "p\u0435rson@example.test",
    ].map((email) => ({
      name: `look-alike ${JSON.stringify(email)}`,
      own: PROFILE_EMAIL,
      tokenClaims: { email, email_verified: true },
      linked: false,
    })),
  ];
  let index = 0;
  for (const current of cases) {
    index += 1;
    approver = `ocid-case-${index}`;
    const alias = `case-${index}-${PROFILE_EMAIL}`;
    claims = current.reportsAlias ? { ...current.tokenClaims, email: alias } : current.tokenClaims;
    // Each case's profile has its own email alias, never compared with the account's email.
    const profile = await ensureCanonicalUserProfileForEmail(alias);
    const connection = personalConnection(profile.id, current.own, `conn-case-${index}`);
    const polled = await deviceSignIn(connection, true);
    expect(polled, current.name).toMatchObject({
      ok: true,
      payload: { link: current.linked ? "linked" : "link_approval_required" },
    });
    expect(await readOpenClawIdLinksOfProfile(profile.id), current.name).toHaveLength(
      current.linked ? 1 : 0,
    );
    expect((await readOpenClawIdLinkedProfile(approver))?.profileId ?? null, current.name).toBe(
      current.linked ? profile.id : null,
    );
  }
  claims = {};
});

it("applies the same rule to a held sign-in", async ({ state }) => {
  state.applyEnv();
  const profile = await ensureCanonicalUserProfileForEmail(PROFILE_EMAIL);
  const elsewhere = personalConnection(profile.id, "other-login@example.test", "conn-held-other");
  const own = personalConnection(profile.id, PROFILE_EMAIL, "conn-held-own");
  approver = "ocid-held";
  claims = { email_verified: true };
  // Sign in without linking, then link with the held token.
  const other = await deviceSignIn(elsewhere, false);
  const { idToken: otherToken } = other.payload as { idToken: string };
  expect(await call(elsewhere, { action: "link_held", idToken: otherToken })).toMatchObject({
    ok: true,
    payload: { link: "link_approval_required" },
  });
  expect(await readOpenClawIdLinksOfProfile(profile.id)).toEqual([]);
  const mine = await deviceSignIn(own, false);
  const { idToken: ownToken } = mine.payload as { idToken: string };
  expect(await call(own, { action: "link_held", idToken: ownToken })).toMatchObject({
    ok: true,
    payload: { link: "linked" },
  });
  expect(await readOpenClawIdLinksOfProfile(profile.id)).toEqual([
    { accountId: "ocid-held", email: PROFILE_EMAIL },
  ]);
  claims = {};
});
