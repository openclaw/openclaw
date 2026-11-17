// Turn on remote access over a verified personal sign-in (OCF-511): which connections may run
// the root ceremony, what the service sees, the profile link at commit and the audit record.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "../server-methods/types.js";

const ISSUER = "https://issuer.example.test/api/auth";
const DISCOVERY = "https://discovery.example.test";
const OPENCLAW_ID = {
  enabled: true,
  issuerUrl: ISSUER,
  clientId: "control-ui",
  discoveryUrl: DISCOVERY,
  loaderDomain: "claws.example.test",
};

// mock-isolation: profile storage has its own tests; this file proves which profile and
// account the ceremony links, and that a refused caller never reaches it.
const store = vi.hoisted(() => ({
  link: vi.fn(async (_input: unknown, _options: { assertCurrent: () => void }) => ({
    ok: true as const,
  })),
}));
// The personal-profile authority owner has its own tests; here it grants what the socket
// holds unless the person's current role was lowered (`roleLowered`).
vi.mock("../server-methods/personal-profile-authorization.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server-methods/personal-profile-authorization.js")>()),
  preparePersonalProfileAction: vi.fn(
    async (
      opts: {
        client: {
          authenticatedUserProfile: { profileId: string };
          connect: { scopes: string[] };
          roleLowered?: boolean;
        };
      },
      scope = "operator.read",
    ) => {
      const check = () => {
        if (opts.client.roleLowered || !opts.client.connect.scopes.includes(scope)) {
          throw new Error(`Personal profile requires current ${scope} permission.`);
        }
      };
      check();
      return {
        owner: opts.client.authenticatedUserProfile.profileId,
        signal: new AbortController().signal,
        assertCurrent: check,
      };
    },
  ),
}));
vi.mock("../../state/user-profile-openclaw-id.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/user-profile-openclaw-id.js")>()),
  linkCanonicalOpenClawIdUserProfile: store.link,
}));
const security = vi.hoisted(() => vi.fn());
vi.mock("../../infra/diagnostic-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/diagnostic-events.js")>()),
  emitTrustedSecurityEvent: security,
}));

function idToken(claims: Record<string, unknown>) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part(claims)}.sig`;
}

type Client = {
  connId?: string;
  connect: { role: string; scopes: string[] };
  internal: Record<string, unknown>;
  authenticatedUserProfile?: { profileId: string };
  authenticatedUserId?: string;
  authPolicy?: { authMethod: string };
  roleLowered?: boolean;
};

const admin = (): Client => ({
  connId: "conn-josh",
  connect: { role: "operator", scopes: ["operator.admin", "operator.read"] },
  internal: { authenticatedOperator: true },
  authenticatedUserProfile: { profileId: "profile-josh" },
  authenticatedUserId: "josh@tailnet.example",
  authPolicy: { authMethod: "tailscale" },
});
const member = (): Client => ({
  ...admin(),
  connId: "conn-graham",
  connect: { role: "operator", scopes: ["operator.read", "operator.write"] },
  authenticatedUserProfile: { profileId: "profile-graham" },
  authenticatedUserId: "graham@tailnet.example",
});
const loopback = (): Client => ({
  connect: { role: "operator", scopes: ["operator.admin"] },
  internal: { isLocalClient: true },
});

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
      if (url.startsWith(DISCOVERY)) {
        return Response.json({ code: "synthetic-link-code", expires_at: 4_102_444_800 });
      }
      return Response.json({
        id_token: idToken({
          iss: ISSUER,
          aud: "control-ui",
          sub: "acct-josh",
          exp: Math.floor(Date.now() / 1000) + 3600,
          email: "josh@id.test",
        }),
      });
    }),
  );
  ({ openclawIdHandlers: handlers } = await import("../server-methods/openclaw-id.js"));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const config = { gateway: { openclawId: { ...OPENCLAW_ID } } };
const live = new Set<Client>();
const service = {
  checkClawName: vi.fn(async () => ({
    name: "lab",
    accountTag: "e61zr",
    hostname: "lab-e61zr.claws.example.test",
    available: true,
  })),
  prepareLink: vi.fn(async () => ({ claw_id: "c1", hostname: "lab-e61zr.claws.example.test" })),
  commitLink: vi.fn(
    async (
      _channel: unknown,
      _input: unknown,
      _code: unknown,
      _assertCurrent?: () => void,
    ): Promise<
      { ok: true; publication?: unknown } | { ok: false; code: string; detail: string }
    > => ({
      ok: true,
      publication: { state: "published" },
    }),
  ),
  publish: vi.fn(async () => ({ state: "published" })),
  rebind: vi.fn(async () => ({ ok: true })),
  submitStatement: vi.fn(async (channel: unknown) =>
    channel ? { ok: true, status: "applied" } : { ok: false, code: "not_direct", detail: "" },
  ),
  recordVerifiedAccount: vi.fn(async () => {}),
  prepareOwnerClientCheck: vi.fn(async (channel: unknown) => () => channel === "local_operator"),
  isOwnerClient: vi.fn(async (channel: unknown) => channel === "local_operator"),
  linkSummary: vi.fn(async () => ({ linked: true, clawId: "c1" })),
  linkStatus: vi.fn(async () => ({
    linked: true,
    publication: { state: "failed", code: "needs_link_code" },
  })),

  connectionIdentity: vi.fn(async () => ({ kind: "none" })),
  ownerDeviceCount: vi.fn(async () => 1),
  status: vi.fn(() => ({ state: "on" })),
};
const logGateway = { info: vi.fn(), warn: vi.fn() };

async function call(method: string, client: Client, params: Record<string, unknown>) {
  let reply: { ok: boolean; payload?: unknown; code?: string } | undefined;
  live.add(client);
  await handlers[method]!({
    params,
    client,
    respond: (ok: boolean, payload?: unknown, error?: { details?: { code?: string } }) => {
      reply = { ok, payload, code: error?.details?.code };
    },
    context: {
      getRuntimeConfig: () => config,
      getClientConnIds: (match: (candidate: unknown) => boolean) =>
        new Set([...live].filter(match).map((entry) => entry.connId ?? "")),
      openclawIdService: service,
      logGateway,
    },
  } as unknown as GatewayRequestHandlerOptions);
  return reply!;
}

const authority = (client: Client, params: Record<string, unknown>) =>
  call("openclawId.authority", client, params);

const commitParams = {
  action: "commit",
  rootPub: `ed25519:${"a".repeat(64)}`,
  ownerDevice: { cert: true },
  binding: { binding: true },
  enrollmentCode: "synthetic-link-code",
};

// Signs this client in with a device code; returns the ID token the Gateway redeemed.
async function deviceSignIn(client: Client): Promise<string> {
  const started = await call("openclawId.account", client, { action: "device_begin" });
  await new Promise((resolve) => {
    setTimeout(resolve, 5);
  });
  const done = await call("openclawId.account", client, {
    action: "device_poll",
    state: (started.payload as { state: string }).state,
  });
  return (done.payload as { idToken: string }).idToken;
}

beforeEach(() => {
  vi.clearAllMocks();
  live.clear();
  config.gateway.openclawId = { ...OPENCLAW_ID };
});

describe("Turn on remote access over a personal sign-in", () => {
  it("runs the ceremony for an admin and links their OpenClaw ID to their profile", async () => {
    const josh = admin();
    const token = await deviceSignIn(josh);
    expect(
      await authority(josh, { action: "check_name", enrollmentCode: "c", name: "lab" }),
    ).toMatchObject({ ok: true, payload: { available: true } });
    expect(
      await authority(josh, { action: "prepare", enrollmentCode: "c", name: "lab" }),
    ).toMatchObject({ ok: true });
    const committed = await authority(josh, { ...commitParams, idToken: token });
    expect(committed).toMatchObject({
      ok: true,
      payload: { linked: true, profileLink: "linked", publication: { state: "published" } },
    });
    // The protocol's ceremony channel, for these actions only.
    expect(service.checkClawName).toHaveBeenCalledWith("local_operator", expect.anything());
    expect(service.prepareLink).toHaveBeenCalledWith("local_operator", expect.anything());
    expect(service.commitLink).toHaveBeenCalledWith(
      "local_operator",
      expect.objectContaining({ binding: { binding: true } }),
      "synthetic-link-code",
      expect.any(Function),
    );
    expect(service.recordVerifiedAccount).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "acct-josh", email: "josh@id.test" }),
    );
    expect(store.link).toHaveBeenCalledExactlyOnceWith(
      { profileId: "profile-josh", accountId: "acct-josh", email: "josh@id.test" },
      { assertCurrent: expect.any(Function) },
    );
    // Who ran it and over which identity.
    expect(logGateway.info).toHaveBeenCalledWith(
      "openclaw-id: remote access commit success route=personal_admin via=tailscale profile=profile-josh user=josh@tailnet.example",
    );
    expect(security).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "openclaw_id.remote_access.commit",
        outcome: "success",
        actor: expect.objectContaining({ channel: "tailscale", role: "admin" }),
        attributes: { route: "personal_admin" },
      }),
    );
    expect(JSON.stringify(security.mock.calls)).not.toContain("profile-josh");
  });

  it("stops the write once the admin's authority is gone, and the commit carries that check", async () => {
    const josh = admin();
    await authority(josh, commitParams);
    const assertCurrent = service.commitLink.mock.calls[0]?.[3];
    expect(() => assertCurrent?.()).not.toThrow();
    josh.roleLowered = true;
    expect(() => assertCurrent?.()).toThrow();
    josh.roleLowered = false;
    josh.authenticatedUserProfile = { profileId: "someone-else" };
    expect(() => assertCurrent?.()).toThrow("this connection changed");
    josh.authenticatedUserProfile = { profileId: "profile-josh" };
    config.gateway.openclawId.enabled = false;
    expect(() => assertCurrent?.()).toThrow("this connection changed");
  });

  it("refuses a commit whose write the admin's lost authority stopped", async () => {
    const josh = admin();
    service.commitLink.mockImplementationOnce(async (_channel, _input, _code, guard) => {
      josh.roleLowered = true;
      guard?.();
      return { ok: true };
    });
    expect(await authority(josh, commitParams)).toMatchObject({ ok: false, code: "not_admin" });
    expect(store.link).not.toHaveBeenCalled();
    expect(logGateway.warn).toHaveBeenCalledWith(
      expect.stringContaining("remote access commit denied code=not_admin route=personal_admin"),
    );
  });

  it("keeps the claw linked but reports why the profile was not linked", async () => {
    const josh = admin();
    // No token, or a token this Gateway never redeemed for this profile.
    for (const presented of [undefined, idToken({ iss: ISSUER, aud: "control-ui", sub: "x" })]) {
      expect(await authority(josh, { ...commitParams, idToken: presented })).toMatchObject({
        ok: true,
        payload: { linked: true, profileLink: "sign_in_not_held" },
      });
    }
    // A token another profile signed in with is not this admin's.
    const graham = { ...member(), connect: admin().connect };
    const grahamToken = await deviceSignIn(graham);
    expect(await authority(josh, { ...commitParams, idToken: grahamToken })).toMatchObject({
      payload: { profileLink: "sign_in_not_held" },
    });
    store.link.mockResolvedValueOnce({ ok: false, code: "already_linked" } as never);
    const token = await deviceSignIn(josh);
    expect(await authority(josh, { ...commitParams, idToken: token })).toMatchObject({
      payload: { linked: true, profileLink: "already_linked" },
    });
    expect(logGateway.warn).toHaveBeenCalledWith(
      expect.stringContaining("remote access link_profile failure code=already_linked"),
    );
  });

  it("links nothing for the loopback operator", async () => {
    expect(await authority(loopback(), commitParams)).toMatchObject({
      ok: true,
      payload: { linked: true, profileLink: null },
    });
    expect(store.link).not.toHaveBeenCalled();
    expect(logGateway.info).toHaveBeenCalledWith(
      "openclaw-id: remote access commit success route=local via=loopback",
    );
  });

  it.each([
    ["a person whose role is not admin", member(), "not_admin"],
    [
      "an admin socket whose current role was lowered",
      { ...admin(), roleLowered: true },
      "not_admin",
    ],
    [
      "a shared token over the network",
      {
        connId: "conn-token",
        connect: { role: "operator", scopes: ["operator.admin"] },
        internal: { authenticatedOperator: true },
        authenticatedUserProfile: { profileId: "gateway-owner" },
        authPolicy: { authMethod: "token" },
      },
      "not_local_operator",
    ],
    [
      "a password connection without a profile",
      {
        connId: "conn-password",
        connect: { role: "operator", scopes: ["operator.admin"] },
        internal: { authenticatedOperator: true },
        authPolicy: { authMethod: "password" },
      },
      "not_local_operator",
    ],
    [
      "an admin relayed by the OpenClaw ID tunnel",
      { ...admin(), internal: { authenticatedOperator: true, openclawIdPeerKey: "iroh:aa" } },
      "not_local_operator",
    ],
  ])("refuses %s", async (_name, client, code) => {
    for (const params of [
      { action: "check_name", enrollmentCode: "c", name: "lab" },
      { action: "prepare", enrollmentCode: "c", name: "lab" },
      commitParams,
      { action: "account_link_code", idToken: "t" },
    ]) {
      expect(await authority(client as Client, params)).toMatchObject({ ok: false, code });
    }
    expect(
      await authority(client as Client, { action: "publish", enrollmentCode: "c" }),
    ).toMatchObject({ ok: false, code: "not_owner" });
    expect(service.checkClawName).not.toHaveBeenCalled();
    expect(service.prepareLink).not.toHaveBeenCalled();
    expect(service.commitLink).not.toHaveBeenCalled();
    expect(service.publish).not.toHaveBeenCalled();
    for (const action of ["commit", "link_code", "publish"]) {
      expect(logGateway.warn).toHaveBeenCalledWith(
        expect.stringContaining(`remote access ${action} denied code=${code}`),
      );
    }
  });

  it("keeps Move to new keys on the computer that runs the claw", async () => {
    for (const action of ["rebind_prepare", "rebind_commit", "rebind_cancel"]) {
      expect(await authority(admin(), { action })).toMatchObject({
        ok: false,
        code: "not_local_operator",
      });
    }
    expect(service.rebind).not.toHaveBeenCalled();
  });

  it("does not make a personal admin an owner client", async () => {
    expect(await call("openclawId.people", admin(), {})).toMatchObject({
      ok: false,
      code: "not_owner",
    });
    expect(await authority(admin(), { action: "submit", statement: {} })).toMatchObject({
      ok: false,
      code: "not_direct",
    });
    // Membership writes keep the client channel, which a personal connection does not have.
    expect(service.submitStatement).toHaveBeenCalledWith(undefined, {});
  });

  it("gets a link code and publishes new keys for an admin", async () => {
    expect(await authority(admin(), { action: "account_link_code", idToken: "t" })).toMatchObject({
      ok: true,
    });
    expect(await authority(admin(), { action: "publish", enrollmentCode: "c" })).toMatchObject({
      ok: true,
      payload: { publication: { state: "published" } },
    });
    expect(service.publish).toHaveBeenCalledWith("c");
    expect(logGateway.info).toHaveBeenCalledWith(
      expect.stringContaining("remote access link_code success route=personal_admin"),
    );
    expect(logGateway.info).toHaveBeenCalledWith(
      expect.stringContaining("remote access publish success route=personal_admin"),
    );
  });

  it("reports who may turn on remote access, and the publication to a personal admin", async () => {
    expect(await call("openclawId.status", admin(), {})).toMatchObject({
      ok: true,
      payload: {
        remoteAccessSetup: "personal_admin",
        publication: { state: "failed", code: "needs_link_code" },
      },
    });
    const graham = await call("openclawId.status", member(), {});
    expect(graham).toMatchObject({ ok: true, payload: { remoteAccessSetup: null } });
    expect(graham.payload).not.toHaveProperty("publication");
    expect(await call("openclawId.status", loopback(), {})).toMatchObject({
      payload: { remoteAccessSetup: "local" },
    });
  });
});
