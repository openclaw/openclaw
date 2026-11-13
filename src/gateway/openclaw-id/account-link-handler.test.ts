// openclawId.account links a device-verified OpenClaw ID to the caller's own profile (OCF-510):
// the account comes from the Gateway's own token redemption, the profile from the connection.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "../server-methods/types.js";

const ISSUER = "https://issuer.example.test/api/auth";
const OPENCLAW_ID = { enabled: true, issuerUrl: ISSUER, clientId: "control-ui" };

// mock-isolation: profile storage has its own tests; this file proves which profile and account
// the handler writes, and that it writes only after the issuer verified the account.
const store = vi.hoisted(() => ({
  link: vi.fn(async () => ({ ok: true as const })),
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
    }),
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
      // The caller is a live connection, as the device sign-in's custody check requires.
      getClientConnIds: (match: (candidate: unknown) => boolean) =>
        new Set(match(personal) ? [personal.connId] : []),
    },
  } as unknown as GatewayRequestHandlerOptions);
  return reply!;
}

describe("openclawId.account linking", () => {
  it("links the verified account to the caller's profile after the device sign-in", async () => {
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
    expect(store.link).toHaveBeenCalledExactlyOnceWith(
      { profileId: "profile-josh", accountId: "acct-owner", email: "josh@id.test" },
      { assertCurrent: expect.any(Function) },
    );
    // The write's commit check fails once Labs turns off or the connection's profile changes.
    const [, { assertCurrent }] = store.link.mock.calls[0] as unknown as [
      unknown,
      { assertCurrent: () => void },
    ];
    expect(() => assertCurrent()).not.toThrow();
    config.gateway.openclawId.enabled = false;
    expect(() => assertCurrent()).toThrow("this connection changed");
    config.gateway.openclawId.enabled = true;
    personal.authenticatedUserProfile.profileId = "someone-else";
    expect(() => assertCurrent()).toThrow("this connection changed");
    personal.authenticatedUserProfile.profileId = "profile-josh";
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
});
