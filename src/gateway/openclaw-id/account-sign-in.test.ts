import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createOpenClawIdSignIn } from "./account-sign-in.js";
import { createOpenClawIdAuthority } from "./authority.js";
import { linkedClaw, memoryStore, serviceFor } from "./openclaw-id.test-support.js";

const ISSUER = "https://issuer.example.test/api/auth";
const REDIRECT = "http://127.0.0.1:18789/openclaw-id/callback";

function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "EdDSA" })}.${part(claims)}.sig`;
}

// A fake issuer and Discovery: metadata, token endpoint and enrollment codes. Like a
// real issuer, the token endpoint remembers the authorization request's nonce and
// S256 challenge (`authorize`) and redeems the code only with the matching verifier.
function fakeServices(tokenClaims: (nonce: string) => Record<string, unknown>) {
  let nonce = "";
  let challenge = "";
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth2/authorize`,
        token_endpoint: `${ISSUER}/oauth2/token`,
      });
    }
    if (url.endsWith("/oauth2/token")) {
      const body = init?.body;
      const form =
        body instanceof URLSearchParams
          ? body
          : new URLSearchParams(typeof body === "string" ? body : "");
      const verifier = form.get("code_verifier") ?? "";
      const derived = createHash("sha256").update(verifier).digest("base64url");
      if (!verifier || derived !== challenge || form.get("code") !== "the-code") {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      return Response.json({ id_token: jwt(tokenClaims(nonce)) });
    }
    if (url === "https://discovery.example.test/v1/enrollment-codes") {
      const auth = new Headers(init?.headers).get("authorization");
      return auth === "Bearer good"
        ? Response.json({ code: "ABCDE-FGHJK", expires_at: 1_700_000_600 }, { status: 201 })
        : new Response("{}", { status: 401 });
    }
    return new Response("not found", { status: 404 });
  });
  // Records what the browser's authorization request carried, as the issuer would.
  const authorize = (authorizationUrl: string) => {
    const query = new URL(authorizationUrl).searchParams;
    expect(query.get("code_challenge_method")).toBe("S256");
    nonce = query.get("nonce") ?? "";
    challenge = query.get("code_challenge") ?? "";
  };
  return { fetchImpl, authorize };
}

async function begin(signIn: ReturnType<typeof createOpenClawIdSignIn>) {
  const started = await signIn.begin({ issuerUrl: ISSUER, clientId: "ui", redirectUri: REDIRECT });
  if ("ok" in started) {
    throw new Error(started.detail);
  }
  return started;
}

describe("createOpenClawIdSignIn", () => {
  const now = () => 1_700_000_000_000;
  const valid = (nonce: string) => ({
    iss: ISSUER,
    aud: "ui",
    sub: "acct-1",
    nonce,
    exp: 1_700_003_600,
    email: "owner@example.test",
    name: "Owner",
  });

  it("builds a PKCE authorization URL and redeems the code once", async () => {
    const services = fakeServices(valid);
    const signIn = createOpenClawIdSignIn({ fetchImpl: services.fetchImpl, now });
    const started = await begin(signIn);
    const url = new URL(started.authorizationUrl);
    expect(url.pathname).toBe("/api/auth/oauth2/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(started.state);
    services.authorize(started.authorizationUrl);

    const done = await signIn.complete({ state: started.state, code: "the-code" });
    expect(done).toMatchObject({
      account: { sub: "acct-1", email: "owner@example.test", name: "Owner" },
    });
    const again = await signIn.complete({ state: started.state, code: "the-code" });
    expect(again).toMatchObject({ ok: false, code: "state_mismatch" });
  });

  it("persists only verified display claims and binds them to the linked owner across restart", async () => {
    const store = memoryStore();
    const authority = createOpenClawIdAuthority(store);
    const services = fakeServices(valid);
    const signIn = createOpenClawIdSignIn({ fetchImpl: services.fetchImpl, now });
    const started = await begin(signIn);
    services.authorize(started.authorizationUrl);
    await signIn.complete({
      state: started.state,
      code: "the-code",
      onVerifiedAccount: (account) => authority.recordVerifiedAccount(account),
    });
    expect((await store.read())?.owner_profile).toEqual({
      sub: "acct-1",
      email: "owner@example.test",
      name: "Owner",
    });
    const unlinked = serviceFor(authority).service;
    expect(await unlinked.connectionIdentity("local_operator", undefined)).toEqual({
      kind: "local",
      accountEmail: "owner@example.test",
      accountName: "Owner",
    });
    await unlinked.stop();
    // The sign-in precedes the local link; registration establishes which subject owns it.
    const claw = await linkedClaw(store);
    await claw.authority.recordDiscovery({ owner_account_id: "acct-1" });
    const restarted = createOpenClawIdAuthority(store);
    const { service } = serviceFor(restarted);
    expect(await service.connectionIdentity("tunnel", claw.w1)).toMatchObject({
      kind: "owner",
      accountEmail: "owner@example.test",
      accountName: "Owner",
    });
    await restarted.recordVerifiedAccount({
      sub: "someone-else",
      email: "other@example.test",
      name: "Other",
      exp: 2_000_000_000,
    });
    expect((await store.read())?.owner_profile?.sub).toBe("acct-1");
    await service.stop();
  });

  it("never adopts a verified profile for a different linked account", async () => {
    const claw = await linkedClaw();
    await claw.authority.recordVerifiedAccount({
      sub: "acct-1",
      email: "owner@example.test",
      name: "Owner",
      exp: 2_000_000_000,
    });
    await claw.authority.recordDiscovery({ owner_account_id: "another-owner" });
    const { service } = serviceFor(claw.authority);
    expect(await service.connectionIdentity("tunnel", claw.w1)).toMatchObject({
      ownerAccountId: "another-owner",
      accountEmail: null,
      accountName: null,
    });
    expect((await claw.store.read())?.owner_profile).toBeUndefined();
    await service.stop();
  });

  it.each(["email", "name", "both"])("publishes when verified claims omit %s", async (missing) => {
    const store = memoryStore();
    const authority = createOpenClawIdAuthority(store);
    const services = fakeServices((nonce) => {
      const { email, name, ...required } = valid(nonce);
      return {
        ...required,
        ...(missing === "name" ? { email } : {}),
        ...(missing === "email" ? { name } : {}),
      };
    });
    const signIn = createOpenClawIdSignIn({ fetchImpl: services.fetchImpl, now });
    const started = await begin(signIn);
    services.authorize(started.authorizationUrl);
    await signIn.complete({
      state: started.state,
      code: "the-code",
      onVerifiedAccount: (account) => authority.recordVerifiedAccount(account),
    });
    await authority.recordDiscovery({ owner_account_id: "acct-1", published_snapshot_seq: 1 });
    expect((await store.read())?.owner_profile).toEqual({
      sub: "acct-1",
      ...(missing === "name" ? { email: "owner@example.test" } : {}),
      ...(missing === "email" ? { name: "Owner" } : {}),
    });
  });

  it("sends the verifier that matches the S256 challenge, and fails with another sign-in's", async () => {
    const services = fakeServices(valid);
    const signIn = createOpenClawIdSignIn({ fetchImpl: services.fetchImpl, now });
    const first = await begin(signIn);
    const second = await begin(signIn);
    const challenge = (started: { authorizationUrl: string }) =>
      new URL(started.authorizationUrl).searchParams.get("code_challenge");
    expect(challenge(first)).not.toBe(challenge(second));
    // The issuer saw the first request's challenge; the second sign-in's verifier fails it.
    services.authorize(first.authorizationUrl);
    expect(await signIn.complete({ state: second.state, code: "the-code" })).toMatchObject({
      ok: false,
      code: "token_exchange_failed",
    });
    expect(await signIn.complete({ state: first.state, code: "the-code" })).toMatchObject({
      account: { sub: "acct-1" },
    });
  });

  it("refuses an ID token whose nonce is not this sign-in's", async () => {
    const services = fakeServices((nonce) => ({ ...valid(nonce), nonce: `${nonce}-replayed` }));
    const signIn = createOpenClawIdSignIn({ fetchImpl: services.fetchImpl, now });
    const started = await begin(signIn);
    services.authorize(started.authorizationUrl);
    const onVerifiedAccount = vi.fn(async () => {});
    const done = await signIn.complete({
      state: started.state,
      code: "the-code",
      onVerifiedAccount,
    });
    expect(done).toMatchObject({ ok: false, code: "id_token_invalid" });
    expect(onVerifiedAccount).not.toHaveBeenCalled();
  });

  it("refuses an ID token issued to another client", async () => {
    const services = fakeServices((nonce) => ({ ...valid(nonce), aud: "someone-else" }));
    const signIn = createOpenClawIdSignIn({ fetchImpl: services.fetchImpl, now });
    const started = await begin(signIn);
    services.authorize(started.authorizationUrl);
    const onVerifiedAccount = vi.fn(async () => {});
    const done = await signIn.complete({
      state: started.state,
      code: "the-code",
      onVerifiedAccount,
    });
    expect(done).toMatchObject({ ok: false, code: "id_token_invalid" });
    expect(onVerifiedAccount).not.toHaveBeenCalled();
  });

  it("only accepts the Control UI callback path as redirect URI", async () => {
    const signIn = createOpenClawIdSignIn({ fetchImpl: fakeServices(valid).fetchImpl, now });
    const refused = await signIn.begin({
      issuerUrl: ISSUER,
      clientId: "ui",
      redirectUri: "https://evil.example.test/steal?x=1",
    });
    expect(refused).toMatchObject({ ok: false, code: "malformed" });
  });

  it("refuses a callback on a non-loopback origin", async () => {
    const signIn = createOpenClawIdSignIn({ fetchImpl: fakeServices(valid).fetchImpl, now });
    for (const redirectUri of [
      "https://studio-k7x2q.crabd.xyz/openclaw-id/callback",
      "http://192.168.1.20:18789/openclaw-id/callback",
    ]) {
      expect(await signIn.begin({ issuerUrl: ISSUER, clientId: "ui", redirectUri })).toMatchObject({
        ok: false,
        code: "malformed",
      });
    }
    const local = await signIn.begin({
      issuerUrl: ISSUER,
      clientId: "ui",
      redirectUri: "http://localhost:18789/openclaw-id/callback",
    });
    expect(local).toHaveProperty("authorizationUrl");
  });

  it("turns an unreachable or malformed issuer into a refusal", async () => {
    const offline = createOpenClawIdSignIn({
      fetchImpl: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
      now,
    });
    expect(
      await offline.begin({ issuerUrl: ISSUER, clientId: "ui", redirectUri: REDIRECT }),
    ).toMatchObject({ ok: false, code: "issuer_unavailable" });

    const garbled = createOpenClawIdSignIn({
      fetchImpl: vi.fn(async () => new Response("<html>", { status: 200 })),
      now,
    });
    expect(
      await garbled.begin({ issuerUrl: ISSUER, clientId: "ui", redirectUri: REDIRECT }),
    ).toMatchObject({ ok: false, code: "issuer_unavailable" });

    const foreignToken = createOpenClawIdSignIn({
      fetchImpl: vi.fn(async () =>
        Response.json({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/oauth2/authorize`,
          token_endpoint: "https://elsewhere.example.test/token",
        }),
      ),
      now,
    });
    expect(
      await foreignToken.begin({ issuerUrl: ISSUER, clientId: "ui", redirectUri: REDIRECT }),
    ).toMatchObject({ ok: false, code: "issuer_invalid" });
  });

  it("gets a Discovery link code with the ID token", async () => {
    const signIn = createOpenClawIdSignIn({ fetchImpl: fakeServices(valid).fetchImpl, now });
    const discoveryUrl = "https://discovery.example.test";
    expect(await signIn.enrollmentCode({ discoveryUrl, idToken: "good" })).toEqual({
      code: "ABCDE-FGHJK",
      expiresAt: 1_700_000_600,
    });
    expect(await signIn.enrollmentCode({ discoveryUrl, idToken: "stale" })).toMatchObject({
      ok: false,
      code: "signed_out",
    });
  });
});
