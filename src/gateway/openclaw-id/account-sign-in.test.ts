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
      redirectUri: "http://127.0.0.1:18789/steal",
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

// A fake issuer offering the device grant; `decision` is what the user did on /device.
function fakeDeviceIssuer(options: { idToken?: Record<string, unknown> } = {}) {
  let decision: "pending" | "approved" | "denied" = "pending";
  let slowDown = false;
  let claims: Record<string, unknown> = options.idToken ?? {
    iss: ISSUER,
    aud: "ui",
    sub: "acct-1",
    exp: 1_700_036_000,
    email: "person@example.test",
    name: "Person",
  };
  const tokenPolls: URLSearchParams[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const form = new URLSearchParams(init?.body instanceof URLSearchParams ? init.body : "");
    if (url.endsWith("/.well-known/openid-configuration")) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth2/authorize`,
        token_endpoint: `${ISSUER}/oauth2/token`,
        device_authorization_endpoint: `${ISSUER}/oauth2/device-authorization`,
      });
    }
    if (url.endsWith("/oauth2/device-authorization")) {
      expect(form.get("client_id")).toBe("ui");
      expect(form.get("scope")).toBe("openid profile email");
      return Response.json({
        device_code: "the-device-code",
        user_code: "WDJB-MJHT",
        verification_uri: "https://issuer.example.test/device",
        verification_uri_complete: "https://issuer.example.test/device?user_code=WDJB-MJHT",
        expires_in: 600,
        interval: 5,
      });
    }
    if (url.endsWith("/oauth2/token")) {
      tokenPolls.push(form);
      if (slowDown) {
        slowDown = false;
        return Response.json({ error: "slow_down" }, { status: 400 });
      }
      if (decision !== "approved") {
        return Response.json(
          { error: decision === "denied" ? "access_denied" : "authorization_pending" },
          { status: 400 },
        );
      }
      return Response.json({
        id_token: jwt(claims),
        token_type: "Bearer",
      });
    }
    return new Response("not found", { status: 404 });
  });
  return {
    fetchImpl,
    tokenPolls,
    decide: (next: "approved" | "denied") => {
      decision = next;
    },
    slowDown: () => {
      slowDown = true;
    },
    // The next approved sign-in gets a different ID token.
    issueAs: (sub: string) => {
      claims = { ...claims, sub };
    },
  };
}

describe("device sign-in", () => {
  function clock() {
    let ms = 1_700_000_000_000;
    return { now: () => ms, advance: (by: number) => (ms += by) };
  }

  async function beginDevice(signIn: ReturnType<typeof createOpenClawIdSignIn>, owner = "p1") {
    const started = await signIn.beginDevice({ issuerUrl: ISSUER, clientId: "ui", owner });
    if ("ok" in started) {
      throw new Error(started.detail);
    }
    return started;
  }

  it("shows the user code, polls at the issuer's pace and returns the account once", async () => {
    const time = clock();
    const issuer = fakeDeviceIssuer();
    const signIn = createOpenClawIdSignIn({ fetchImpl: issuer.fetchImpl, now: time.now });
    const started = await beginDevice(signIn);
    expect(started).toMatchObject({
      userCode: "WDJB-MJHT",
      verificationUri: "https://issuer.example.test/device",
      verificationUriComplete: "https://issuer.example.test/device?user_code=WDJB-MJHT",
      interval: 5,
      expiresAt: time.now() + 600_000,
    });

    // Polling sooner than the interval never reaches the issuer.
    expect(await signIn.pollDevice({ state: started.state, owner: "p1" })).toEqual({
      pending: true,
      interval: 5,
    });
    expect(issuer.tokenPolls).toHaveLength(0);
    time.advance(5_000);
    expect(await signIn.pollDevice({ state: started.state, owner: "p1" })).toEqual({
      pending: true,
      interval: 5,
    });
    expect(issuer.tokenPolls[0]?.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:device_code",
    );
    expect(issuer.tokenPolls[0]?.get("device_code")).toBe("the-device-code");

    issuer.slowDown();
    time.advance(5_000);
    expect(await signIn.pollDevice({ state: started.state, owner: "p1" })).toEqual({
      pending: true,
      interval: 10,
    });

    // Another connection identity can neither redeem nor cancel this sign-in.
    issuer.decide("approved");
    time.advance(10_000);
    expect(await signIn.pollDevice({ state: started.state, owner: "p2" })).toMatchObject({
      ok: false,
      code: "state_mismatch",
    });
    expect(await signIn.pollDevice({ state: started.state, owner: "p1" })).toMatchObject({
      account: { sub: "acct-1", email: "person@example.test", name: "Person" },
      idToken: expect.any(String),
    });
    time.advance(10_000);
    expect(await signIn.pollDevice({ state: started.state, owner: "p1" })).toMatchObject({
      ok: false,
      code: "state_mismatch",
    });
  });

  it("reports a denial and refuses a token for another client or carrying a nonce", async () => {
    const time = clock();
    const denied = fakeDeviceIssuer();
    const signIn = createOpenClawIdSignIn({ fetchImpl: denied.fetchImpl, now: time.now });
    const started = await beginDevice(signIn);
    denied.decide("denied");
    time.advance(5_000);
    expect(await signIn.pollDevice({ state: started.state, owner: "p1" })).toMatchObject({
      ok: false,
      code: "access_denied",
    });

    for (const idToken of [
      { iss: ISSUER, aud: "someone-else", sub: "acct-1", exp: 1_700_036_000 },
      { iss: ISSUER, aud: "ui", sub: "acct-1", exp: 1_700_036_000, nonce: "injected" },
      { iss: ISSUER, aud: "ui", sub: "acct-1", exp: 1_699_999_000 },
    ]) {
      const issuer = fakeDeviceIssuer({ idToken });
      const other = createOpenClawIdSignIn({ fetchImpl: issuer.fetchImpl, now: time.now });
      const pending = await beginDevice(other);
      issuer.decide("approved");
      time.advance(5_000);
      expect(await other.pollDevice({ state: pending.state, owner: "p1" })).toMatchObject({
        ok: false,
        code: "id_token_invalid",
      });
    }
  });

  it("reuses only a held token it redeemed, for the same profile, issuer and client", async () => {
    const time = clock();
    const issuer = fakeDeviceIssuer();
    const signIn = createOpenClawIdSignIn({ fetchImpl: issuer.fetchImpl, now: time.now });
    const started = await beginDevice(signIn);
    issuer.decide("approved");
    time.advance(5_000);
    const done = await signIn.pollDevice({ state: started.state, owner: "p1" });
    if (!("idToken" in done)) {
      throw new Error("device sign-in did not finish");
    }
    const held = { idToken: done.idToken, owner: "p1", issuerUrl: ISSUER, clientId: "ui" };
    expect(signIn.verifyHeld(held)).toEqual({ account: done.account });
    expect(signIn.verifyHeld({ ...held, issuerUrl: `${ISSUER}/` })).toEqual({
      account: done.account,
    });

    const notHeld = { ok: false, code: "sign_in_not_held" };
    // Another profile, issuer or client; a token with the same claims the issuer never sent.
    for (const other of [
      { ...held, owner: "p2" },
      { ...held, issuerUrl: "https://other-issuer.example.test" },
      { ...held, clientId: "other-client" },
      { ...held, idToken: jwt({ iss: ISSUER, aud: "ui", sub: "acct-1", exp: 1_700_036_000 }) },
      { ...held, idToken: undefined },
    ]) {
      expect(signIn.verifyHeld(other)).toMatchObject(notHeld);
    }
    expect(createOpenClawIdSignIn({ now: time.now }).verifyHeld(held)).toMatchObject(notHeld);

    // Once its exp passes, the held token is refused and forgotten.
    time.advance(36_000_000);
    expect(signIn.verifyHeld(held)).toMatchObject(notHeld);
  });

  describe("device sign-in and held-token capacity", () => {
    // The old global limits were 16 pending device sign-ins and 64 held tokens.
    const OLD_PENDING = 16;
    const OLD_HELD = 64;
    const BACKSTOP = 256;
    const poll = (
      signIn: ReturnType<typeof createOpenClawIdSignIn>,
      state: string,
      owner: string,
    ) => signIn.pollDevice({ state, owner });
    const notFound = { ok: false, code: "state_mismatch" };

    function setup() {
      const time = clock();
      const issuer = fakeDeviceIssuer();
      const signIn = createOpenClawIdSignIn({ fetchImpl: issuer.fetchImpl, now: time.now });
      return { time, issuer, signIn };
    }

    function redeemer() {
      const { time, issuer, signIn } = setup();
      issuer.decide("approved");
      const redeem = async (owner: string, sub: string) => {
        issuer.issueAs(sub);
        const started = await beginDevice(signIn, owner);
        time.advance(5_000);
        const done = await poll(signIn, started.state, owner);
        if (!("idToken" in done)) {
          throw new Error("device sign-in did not finish");
        }
        return { idToken: done.idToken, owner, issuerUrl: ISSUER, clientId: "ui" };
      };
      return { signIn, redeem };
    }

    it("keeps one person's device code when another person starts more than the old limit", async () => {
      const { signIn } = setup();
      const mine = await beginDevice(signIn, "a");
      for (let i = 0; i < OLD_PENDING + 20; i += 1) {
        await beginDevice(signIn, "b");
      }
      expect(await poll(signIn, mine.state, "a")).toMatchObject({ pending: true });
    });

    it("keeps one person's held token when another person redeems more than the old limit", async () => {
      const { signIn, redeem } = redeemer();
      const mine = await redeem("a", "acct-a");
      for (let i = 0; i < OLD_HELD + 6; i += 1) {
        await redeem("b", `acct-b${i}`);
      }
      expect(signIn.verifyHeld(mine)).toHaveProperty("account");
    });

    it("lets one person hold more than 8 and more than the old limit of device sign-ins", async () => {
      const { signIn } = setup();
      const started = [];
      for (let i = 0; i < OLD_PENDING + 4; i += 1) {
        started.push(await beginDevice(signIn, "a"));
      }
      for (const one of started) {
        expect(await poll(signIn, one.state, "a")).toMatchObject({ pending: true });
      }
    });

    it("lets one person hold more than 8 and more than the old limit of tokens", async () => {
      const { signIn, redeem } = redeemer();
      const tokens = [];
      for (let i = 0; i < OLD_HELD + 6; i += 1) {
        tokens.push(await redeem("a", `acct-a${i}`));
      }
      for (const token of tokens) {
        expect(signIn.verifyHeld(token)).toHaveProperty("account");
      }
    });

    it("drops the oldest device sign-in of the heaviest person when the map is full", async () => {
      const { signIn } = setup();
      const light = await beginDevice(signIn, "a");
      const heavy = [];
      for (let i = 0; i < BACKSTOP - 1; i += 1) {
        heavy.push(await beginDevice(signIn, "b"));
      }
      const newcomer = await beginDevice(signIn, "c");
      const [oldest, second] = heavy;
      if (!oldest || !second) {
        throw new Error("no sign-ins started");
      }
      expect(await poll(signIn, oldest.state, "b")).toMatchObject(notFound);
      expect(await poll(signIn, second.state, "b")).toMatchObject({ pending: true });
      expect(await poll(signIn, light.state, "a")).toMatchObject({ pending: true });
      expect(await poll(signIn, newcomer.state, "c")).toMatchObject({ pending: true });
    });

    it("drops the oldest entry when every person holds the same number", async () => {
      const { signIn } = setup();
      const all = [];
      for (let i = 0; i < BACKSTOP; i += 1) {
        all.push(await beginDevice(signIn, `p${i}`));
      }
      await beginDevice(signIn, "newcomer");
      const [first, second] = all;
      if (!first || !second) {
        throw new Error("no sign-ins started");
      }
      expect(await poll(signIn, first.state, "p0")).toMatchObject(notFound);
      expect(await poll(signIn, second.state, "p1")).toMatchObject({ pending: true });
    });

    it("drops the oldest held token of the heaviest person when the map is full", async () => {
      const { signIn, redeem } = redeemer();
      const light = await redeem("a", "acct-a");
      const heavy = [];
      for (let i = 0; i < BACKSTOP - 1; i += 1) {
        heavy.push(await redeem("b", `acct-b${i}`));
      }
      const newcomer = await redeem("c", "acct-c");
      const [oldest, second] = heavy;
      if (!oldest || !second) {
        throw new Error("no tokens redeemed");
      }
      expect(signIn.verifyHeld(oldest)).toMatchObject({ ok: false, code: "sign_in_not_held" });
      expect(signIn.verifyHeld(second)).toHaveProperty("account");
      expect(signIn.verifyHeld(light)).toHaveProperty("account");
      expect(signIn.verifyHeld(newcomer)).toHaveProperty("account");
    });

    it("prunes expired device sign-ins, so they never count toward a full map", async () => {
      const { time, signIn } = setup();
      await beginDevice(signIn, "x");
      time.advance(11 * 60_000);
      const fresh = [];
      for (let i = 0; i < BACKSTOP - 1; i += 1) {
        fresh.push(await beginDevice(signIn, "a"));
      }
      await beginDevice(signIn, "b");
      const [first] = fresh;
      if (!first) {
        throw new Error("no sign-ins started");
      }
      // With the expired entry still counted the map is full and the heaviest person's oldest goes.
      expect(await poll(signIn, first.state, "a")).toMatchObject({ pending: true });
    });
  });

  it("refuses an issuer without a device endpoint on its own origin", async () => {
    for (const device of [undefined, "https://elsewhere.example.test/device-authorization"]) {
      const signIn = createOpenClawIdSignIn({
        fetchImpl: vi.fn(async () =>
          Response.json({
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}/oauth2/authorize`,
            token_endpoint: `${ISSUER}/oauth2/token`,
            ...(device ? { device_authorization_endpoint: device } : {}),
          }),
        ),
      });
      expect(
        await signIn.beginDevice({ issuerUrl: ISSUER, clientId: "ui", owner: "p1" }),
      ).toMatchObject({ ok: false, code: "device_unsupported" });
    }
  });
});
