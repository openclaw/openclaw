// A device-code approval (RFC 8628) does not show who approved it, so a device sign-in creates a
// profile's first OpenClaw ID link only for a verified email equal to the connection's own login
// email; otherwise it only recognizes an existing link. Real profile state.
import { afterAll, beforeAll, expect, vi } from "vitest";
import { bytesToBase64url } from "../../../packages/openclaw-id-protocol/src/index.js";
import { stateTest } from "../../plugin-state/plugin-state-fixtures.test-support.js";
import {
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

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
// The account that approves the next user code, and extra ID token claims it carries.
let approver = "ocid-other";
let claims: Record<string, unknown> = {};
let handlers: typeof import("../server-methods/openclaw-id.js").openclawIdHandlers;

beforeAll(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/.well-known/openid-configuration")) {
        const endpoint = (path: string) => `${ISSUER}/oauth2/${path}`;
        return Response.json({
          issuer: ISSUER,
          authorization_endpoint: endpoint("authorize"),
          token_endpoint: endpoint("token"),
          device_authorization_endpoint: endpoint("device-authorization"),
        });
      }
      if (url.endsWith("/oauth2/device-authorization")) {
        const verification_uri = "https://issuer.example.test/device";
        return Response.json({
          device_code: "dc",
          user_code: "WDJB-MJHT",
          verification_uri,
          expires_in: 600,
          interval: 0.001,
        });
      }
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const token = { iss: ISSUER, aud: "control-ui", sub: approver, exp, email: PROFILE_EMAIL };
      return Response.json({
        id_token: `${part({ alg: "RS256" })}.${part({ ...token, ...claims })}.sig`,
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
type Method = "openclawId.account" | "openclawId.authority" | "openclawId.people";
type Client = { connId: string };

async function call(
  client: Client,
  params: Record<string, unknown>,
  method: Method = "openclawId.account",
  service?: unknown,
) {
  let reply: { ok: boolean; payload?: unknown; code?: string } | undefined;
  await handlers[method]!({
    params,
    client,
    respond: (ok: boolean, payload?: unknown, error?: { details?: { code?: string } }) => {
      reply = { ok, payload, code: error?.details?.code };
    },
    context: {
      openclawIdService: service,
      getRuntimeConfig: () => config,
      getClientConnIds: (match: (candidate: unknown) => boolean) =>
        new Set([client].filter(match).map((current) => current.connId)),
    },
  } as unknown as GatewayRequestHandlerOptions);
  return reply!;
}

// A personal connection whose own sign-in verified `ownEmail` (a Tailscale or trusted-proxy
// login); `undefined` models a login that is not an email address.
const personal = (profileId: string, ownEmail?: string, connId = "conn-person") => ({
  connId,
  connect: { role: "operator", scopes: ["operator.read"] },
  internal: { authenticatedOperator: true },
  authenticatedUserProfile: { profileId },
  ...(ownEmail === undefined ? {} : { authenticatedUserId: ownEmail }),
});

// device_begin, approval of the code by `sub` with `tokenClaims`, then device_poll.
async function signIn(client: Client, sub: string, link: boolean, tokenClaims = {}) {
  approver = sub;
  claims = tokenClaims;
  const { state } = (await call(client, { action: "device_begin" })).payload as { state: string };
  await new Promise((resolve) => {
    setTimeout(resolve, 5);
  });
  const polled = await call(client, { action: "device_poll", state, link });
  return { polled, held: (polled.payload as { idToken: string }).idToken };
}

const it = stateTest("openclaw-id-account-link-persistence");

it("links an admin's profile to the claw owner account through the owner browser's invite", async ({
  state,
}) => {
  state.applyEnv();
  const profile = await ensureCanonicalUserProfileForEmail(PROFILE_EMAIL);
  // The setup connection over Tailscale, and an approved owner browser (direct loopback here).
  const setup = personal(profile.id);
  const owner = { connId: "conn-owner", internal: { isLocalClient: true } };
  const claw = await linkedClaw({ read: readStoredClaw, write: writeStoredClaw });
  // After remote access setup the claw has an owner account; the invite links it like any other.
  await claw.authority.recordDiscovery({ owner_account_id: "acct-owner" });
  const { service } = serviceFor(claw.authority);
  const as = (
    client: Client,
    params: Record<string, unknown>,
    method: Method = "openclawId.authority",
  ) => call(client, params, method, service);
  try {
    const { polled, held } = await signIn(setup, "acct-owner", true);
    expect(polled).toMatchObject({ payload: { link: "link_approval_required" } });
    const invite = await ownerInvite(claw, { email: PROFILE_EMAIL });
    const register = {
      action: "register_invite",
      cap: invite.cap,
      proofKey: bytesToBase64url(invite.proofKey),
      existingProfileId: profile.id,
    };
    // People and the invite form need an owner browser.
    expect(await as(setup, {}, "openclawId.people")).toMatchObject({
      ok: false,
      code: "not_owner",
    });
    expect(await as(setup, register)).toMatchObject({ ok: false, code: "not_direct" });
    expect(await as(owner, {}, "openclawId.people")).toMatchObject({
      payload: { link: { existingProfiles: [{ id: profile.id }] } },
    });
    expect(await as(owner, register)).toMatchObject({ ok: true });
    // The /join page and Discovery mailbox are outside this repository; the redemption arrives
    // as the mailbox reader delivers it.
    const mail = await redemptionMail({
      clawId: claw.clawId,
      ...invite,
      accountId: "acct-owner",
      email: PROFILE_EMAIL,
    });
    expect(
      await claw.authority.redeem(mail.message.payload.redemption, mail.message.from),
    ).toMatchObject({ ok: true });
    const add = {
      op: "add" as const,
      account_id: "acct-owner",
      role: "operator",
      peer_keys: [mail.peerKey],
      invite_id: invite.inviteId,
    };
    const approval = { action: "submit", statement: await claw.sign(add) };
    expect(await as(setup, approval)).toMatchObject({ ok: false, code: "not_direct" });
    expect(await readOpenClawIdLinkedProfile("acct-owner")).toBeNull();
    expect(await as(owner, approval)).toMatchObject({ ok: true });
    expect(await readOpenClawIdLinksOfProfile(profile.id)).toEqual([
      { accountId: "acct-owner", email: PROFILE_EMAIL },
    ]);
    expect(await call(setup, { action: "link_held", idToken: held })).toMatchObject({
      payload: { link: "linked" },
    });
    // The owner account is now also a member; its owner devices keep owner authority.
    expect(await claw.authority.resolvePeer(claw.w1)).toMatchObject({ kind: "owner" });
  } finally {
    await service.stop();
  }
});

const OTHER_LOGIN = "other-login@example.test";
const ME = PROFILE_EMAIL;
const verified = (email?: string) => ({ ...(email ? { email } : {}), email_verified: true });
// [name, this sign-in's own email, ID token claims, linked]; "alias" is the profile's own alias.
const cases: Array<[string, string | undefined, Record<string, unknown>, boolean]> = [
  ["same verified email", ME, verified(), true],
  ["case and spacing that normalize equal", ME, verified("  Person@EXAMPLE.test "), true],
  ["unverified email", ME, { email_verified: false }, false],
  ["missing email_verified", ME, {}, false],
  ["string email_verified", ME, { email_verified: "true" }, false],
  ["different verified email", ME, verified("someone@example.test"), false],
  ["the profile's alias while this sign-in's email differs", OTHER_LOGIN, verified("alias"), false],
  ["a sign-in without an email", undefined, verified(), false],
  ["a provider login", "person@github", verified("person@github"), false],
  ["look-alike exampIe", ME, verified("person@exampIe.test"), false],
  ["look-alike inner space", ME, verified("per son@example.test"), false],
  ["look-alike plus tag", ME, verified("person+1@example.test"), false],
  ["look-alike trailing dot", ME, verified("person@example.test."), false],
  ["look-alike Cyrillic letter", ME, verified("p\u0435rson@example.test"), false],
];

it.for(cases)("first link for %s", async ([, own, tokenClaims, linked], { state }) => {
  state.applyEnv();
  // The profile's own email alias is never compared with the account's email.
  const alias = `alias-${PROFILE_EMAIL}`;
  const profile = await ensureCanonicalUserProfileForEmail(alias);
  const reported = tokenClaims.email === "alias" ? { ...tokenClaims, email: alias } : tokenClaims;
  const { polled } = await signIn(personal(profile.id, own), "ocid-case", true, reported);
  expect(polled).toMatchObject({
    ok: true,
    payload: { link: linked ? "linked" : "link_approval_required" },
  });
  expect(await readOpenClawIdLinksOfProfile(profile.id)).toHaveLength(linked ? 1 : 0);
});

// The held path follows the same rule; a linked profile then recognizes its account and tells a
// second account to unlink first, and the second account is never added.
it("applies the same rule to a held sign-in, then recognizes the link and refuses a second account", async ({
  state,
}) => {
  state.applyEnv();
  const profile = await ensureCanonicalUserProfileForEmail(PROFILE_EMAIL);
  const steps = [
    [OTHER_LOGIN, "ocid-held", "link_approval_required", 0],
    [PROFILE_EMAIL, "ocid-held", "linked", 1],
    [PROFILE_EMAIL, "ocid-held", "linked", 1],
    [PROFILE_EMAIL, "ocid-other", "profile_linked", 1],
  ] as const;
  for (const [own, sub, link, rows] of steps) {
    const connection = personal(profile.id, own, `conn-${own}`);
    const { held } = await signIn(connection, sub, false, verified());
    expect(await call(connection, { action: "link_held", idToken: held })).toMatchObject({
      payload: { link },
    });
    expect(await readOpenClawIdLinksOfProfile(profile.id)).toHaveLength(rows);
  }
  expect(await readOpenClawIdLinkedProfile("ocid-other")).toBeNull();
});
