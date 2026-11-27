// Device sign-in can confirm an approved OpenClaw ID profile binding, not establish one.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "../server-methods/types.js";

const ISSUER = "https://issuer.example.test/api/auth";
const OPENCLAW_ID = { enabled: true, issuerUrl: ISSUER, clientId: "control-ui" };

// mock-isolation: profile storage has its own tests; this file exercises Gateway link outcomes.
const store = vi.hoisted(() => ({
  link: vi.fn(async () => ({ ok: true as const })),
  linkedProfile: vi.fn(
    async (_accountId: string): Promise<{ profileId: string; updatedAt: number } | null> => ({
      profileId: "profile-josh",
      updatedAt: 0,
    }),
  ),
  unlink: vi.fn(async () => ({ unlinked: true })),
  linksOf: vi.fn(async () => [{ accountId: "acct-other", email: "josh@id.test" }]),
}));
// The personal-profile authority owner has its own tests; here it admits the caller's own
// profile, and the handler adds the route and Labs checks around it.
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
vi.mock("../../state/user-profile-openclaw-id.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/user-profile-openclaw-id.js")>()),
  linkCanonicalOpenClawIdUserProfile: store.link,
  readOpenClawIdLinkedProfile: store.linkedProfile,
  unlinkCanonicalOpenClawIdUserProfile: store.unlink,
  readOpenClawIdLinksOfProfile: store.linksOf,
}));

function idToken(claims: Record<string, unknown>) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part(claims)}.sig`;
}

const personal = {
  connId: "conn-josh",
  connect: { role: "operator", scopes: ["operator.read"] },
  internal: { authenticatedOperator: true },
  authenticatedUserProfile: { profileId: "profile-josh" },
};

// Live connections; the device sign-in's custody check admits only these.
const live = new Set<{ connId: string }>([personal]);
// The issuer; the sign-in flow captures it when the handler module loads.
let issuerFetch: ReturnType<typeof vi.fn>;

let handlers: typeof import("../server-methods/openclaw-id.js").openclawIdHandlers;

beforeAll(async () => {
  vi.stubGlobal(
    "fetch",
    (issuerFetch = vi.fn(async (input: RequestInfo | URL) => {
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
          // A one-millisecond polling interval keeps the test on real time.
          interval: 0.001,
        });
      }
      return Response.json({
        id_token: idToken({
          iss: ISSUER,
          aud: "control-ui",
          sub: "acct-owner",
          exp: Math.floor(Date.now() / 1000) + 3600,
          email: "josh@id.test",
        }),
      });
    })),
  );
  // The sign-in flow captures fetch when the handler module loads.
  ({ openclawIdHandlers: handlers } = await import("../server-methods/openclaw-id.js"));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const config = { gateway: { openclawId: { ...OPENCLAW_ID } } };

async function call(client: unknown, params: Record<string, unknown>) {
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
        new Set([...live].filter(match).map((current) => current.connId)),
    },
  } as unknown as GatewayRequestHandlerOptions);
  return reply!;
}

describe("openclawId.account linking", () => {
  it("confirms an already approved link after device sign-in", async () => {
    const started = await call(personal, { action: "device_begin" });
    const state = (started.payload as { state: string }).state;
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
    const done = await call(personal, { action: "device_poll", state, link: true });
    expect(done).toMatchObject({
      ok: true,
      payload: { account: { sub: "acct-owner" }, link: "linked" },
    });
    expect(store.linkedProfile).toHaveBeenLastCalledWith("acct-owner");
    expect(store.link).not.toHaveBeenCalled();
  });

  it("signs in but reports no link until a separate approval links the account", async () => {
    const started = await call(personal, { action: "device_begin" });
    const state = (started.payload as { state: string }).state;
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
    store.linkedProfile.mockResolvedValueOnce(null);
    expect(await call(personal, { action: "device_poll", state, link: true })).toMatchObject({
      ok: true,
      payload: { account: { sub: "acct-owner" }, link: "link_approval_required" },
    });
    expect(store.link).not.toHaveBeenCalled();
  });

  it("signs in without linking unless asked, and reports and removes only the caller's link", async () => {
    store.link.mockClear();
    const started = await call(personal, { action: "device_begin" });
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
    await call(personal, {
      action: "device_poll",
      state: (started.payload as { state: string }).state,
    });
    expect(store.link).not.toHaveBeenCalled();
    expect(await call(personal, { action: "link_status" })).toMatchObject({
      ok: true,
      payload: { linked: [{ email: "josh@id.test", owner: false }] },
    });
    expect(store.linksOf).toHaveBeenCalledWith("profile-josh");
    expect(await call(personal, { action: "unlink" })).toMatchObject({ ok: true });
    expect(store.unlink).toHaveBeenCalledWith(
      { profileId: "profile-josh" },
      { assertCurrent: expect.any(Function) },
    );
  });

  it("refuses link status and unlink without a personal connection", async () => {
    store.unlink.mockClear();
    for (const client of [
      { internal: { isLocalClient: true } },
      { ...personal, authenticatedUserProfile: undefined },
    ]) {
      for (const action of ["link_status", "unlink"]) {
        expect((await call(client, { action })).code).toBe("not_personal_connection");
      }
    }
    expect(store.unlink).not.toHaveBeenCalled();
  });
  it("confirms or refuses a held sign-in without a second device code", async () => {
    const fetchMock = issuerFetch;
    const started = await call(personal, { action: "device_begin" });
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
    const signedIn = await call(personal, {
      action: "device_poll",
      state: (started.payload as { state: string }).state,
    });
    const held = (signedIn.payload as { idToken: string }).idToken;
    fetchMock.mockClear();
    store.link.mockClear();

    expect(await call(personal, { action: "link_held", idToken: held })).toMatchObject({
      ok: true,
      payload: { account: { sub: "acct-owner" }, link: "linked" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.linkedProfile).toHaveBeenLastCalledWith("acct-owner");
    store.linkedProfile.mockResolvedValueOnce(null);
    expect(await call(personal, { action: "link_held", idToken: held })).toMatchObject({
      ok: true,
      payload: { link: "link_approval_required" },
    });
    store.linkedProfile.mockResolvedValueOnce({ profileId: "profile-other", updatedAt: 0 });
    expect(await call(personal, { action: "link_held", idToken: held })).toMatchObject({
      ok: true,
      payload: { link: "linked_elsewhere" },
    });

    // A token the issuer never sent here, with the same claims, falls back to a device code.
    const forged = held.replace(/\.[^.]*$/, ".forged");
    expect((await call(personal, { action: "link_held", idToken: forged })).code).toBe(
      "sign_in_not_held",
    );
    // Another profile's live connection cannot reuse it; it signs in itself.
    const other = {
      ...personal,
      connId: "conn-other",
      authenticatedUserProfile: { profileId: "profile-other" },
    };
    live.add(other);
    expect((await call(other, { action: "link_held", idToken: held })).code).toBe(
      "sign_in_not_held",
    );
    live.delete(other);
    // Loopback, a connection without a personal profile, or one no longer live is refused.
    for (const client of [
      { internal: { isLocalClient: true } },
      { ...personal, authenticatedUserProfile: undefined },
      { ...personal, connId: "conn-closed" },
    ]) {
      expect((await call(client, { action: "link_held", idToken: held })).code).toBe(
        "not_personal_connection",
      );
    }
    // A profile reassigned before the write is refused.
    const { preparePersonalProfileAction } =
      await import("../server-methods/personal-profile-authorization.js");
    vi.mocked(preparePersonalProfileAction).mockResolvedValueOnce({
      owner: "profile-other",
      signal: new AbortController().signal,
      assertCurrent: () => {},
    } as Awaited<ReturnType<typeof preparePersonalProfileAction>>);
    expect((await call(personal, { action: "link_held", idToken: held })).code).toBe(
      "not_personal_connection",
    );
    // With Labs off nothing is linked.
    config.gateway.openclawId.enabled = false;
    expect((await call(personal, { action: "link_held", idToken: held })).ok).toBe(false);
    config.gateway.openclawId.enabled = true;
    expect(store.link).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
