import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthorizationResourceParent } from "./authorization/resource-operations.js";
import {
  authenticateTeamsLocalAccount,
  createTeamsSession,
  resolveTeamsSession,
  revokeTeamsSession,
} from "./authorization/teams-identity.js";
import {
  createTeamsInvite,
  listTeamsInvites,
  registerTeamsLocalAccountFromInvite,
  revokeTeamsInvite,
} from "./authorization/teams-invites.js";
import { handleTeamsHttpRequest } from "./teams-http.js";

vi.mock("./authorization/teams-identity.js", () => ({
  authenticateTeamsLocalAccount: vi.fn(),
  createTeamsSession: vi.fn(),
  resolveTeamsSession: vi.fn(),
  revokeTeamsSession: vi.fn(),
}));

vi.mock("./authorization/teams-invites.js", () => ({
  createTeamsInvite: vi.fn(),
  listTeamsInvites: vi.fn(),
  registerTeamsLocalAccountFromInvite: vi.fn(),
  revokeTeamsInvite: vi.fn(),
}));

vi.mock("./authorization/resource-operations.js", () => ({
  getAuthorizationResourceParent: vi.fn(),
}));

const account = Object.freeze({
  id: "account-1",
  principalId: "principal-1",
  loginLabel: "member@example.com",
  createdAt: 1,
});
const session = Object.freeze({
  id: "session-1",
  accountId: account.id,
  principalId: account.principalId,
  principal: Object.freeze({
    issuer: "openclaw-local",
    subject: account.loginLabel,
    kind: "human" as const,
  }),
  domainId: "domain-1",
  state: "active" as const,
  createdAt: 1,
  expiresAt: 86_400_001,
  revokedAt: null,
  revokedByPrincipalId: null,
});
const ownerInvite = Object.freeze({
  id: "invite-2",
  domainId: session.domainId,
  createdByPrincipalId: session.principalId,
  recipientLabel: "person@example.com",
  state: "active" as const,
  createdAt: 2,
  expiresAt: 3,
  redeemedAt: null,
  redeemedByPrincipalId: null,
  revokedAt: null,
  grants: [
    {
      resource: { namespace: "workspaces", type: "tab", id: "tab-1" },
      permission: "workspaces.tab.read",
    },
  ],
});

function createRequest(params: {
  path: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  remoteAddress?: string;
  includeOrigin?: boolean;
  encrypted?: boolean;
}): IncomingMessage {
  const body = params.body === undefined ? "" : JSON.stringify(params.body);
  const req = Readable.from(body ? [body] : []) as IncomingMessage;
  req.method = params.method ?? "GET";
  req.url = params.path;
  req.headers = {
    host: "gateway.example.com",
    ...(params.includeOrigin === false ? {} : { origin: "https://gateway.example.com" }),
    ...(body ? { "content-type": "application/json", "content-length": String(body.length) } : {}),
    ...params.headers,
  };
  Object.defineProperty(req, "socket", {
    value: {
      remoteAddress: params.remoteAddress ?? "203.0.113.8",
      encrypted: params.encrypted ?? true,
    },
  });
  return req;
}

function createResponse(): {
  res: ServerResponse;
  headers: Map<string, string | number | readonly string[]>;
  body: () => string;
} {
  const headers = new Map<string, string | number | readonly string[]>();
  let body = "";
  const res = {
    statusCode: 200,
    setHeader: (name: string, value: string | number | readonly string[]) => {
      headers.set(name.toLowerCase(), value);
      return res;
    },
    end: (chunk?: string) => {
      body = chunk ?? "";
      return res;
    },
  } as unknown as ServerResponse;
  return { res, headers, body: () => body };
}

async function dispatch(
  req: IncomingMessage,
  opts: Partial<Parameters<typeof handleTeamsHttpRequest>[2]> = {},
) {
  const response = createResponse();
  const handled = await handleTeamsHttpRequest(req, response.res, {
    allowedOrigins: ["https://gateway.example.com"],
    trustedProxies: [],
    allowRealIpFallback: false,
    ...opts,
  });
  return { handled, ...response };
}

describe("Teams HTTP account sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateTeamsLocalAccount).mockResolvedValue(account);
    vi.mocked(createTeamsSession).mockReturnValue({ token: "opaque-session-secret", session });
    vi.mocked(resolveTeamsSession).mockReturnValue(session);
    vi.mocked(registerTeamsLocalAccountFromInvite).mockResolvedValue({
      account,
      invite: {
        id: "invite-1",
        domainId: session.domainId,
        createdByPrincipalId: "owner-1",
        recipientLabel: null,
        state: "redeemed",
        createdAt: 1,
        expiresAt: 2,
        redeemedAt: 1,
        redeemedByPrincipalId: account.principalId,
        revokedAt: null,
        grants: ownerInvite.grants,
      },
      session: { token: "invite-session-secret", session },
      validation: { workspaceId: "default", tabId: "tab-1" },
    });
    vi.mocked(createTeamsInvite).mockReturnValue({
      code: "opaque-invite-code",
      invite: ownerInvite,
    });
    vi.mocked(listTeamsInvites).mockReturnValue([]);
    vi.mocked(getAuthorizationResourceParent).mockReturnValue({
      namespace: "workspaces",
      type: "workspace",
      id: "default",
    });
  });

  it("logs in only to a server-validated domain and returns the token only in a secure cookie", async () => {
    const result = await dispatch(
      createRequest({
        path: "/api/teams/login",
        method: "POST",
        body: {
          loginLabel: account.loginLabel,
          password: "correct horse battery staple",
          domainId: session.domainId,
        },
      }),
    );

    expect(result.handled).toBe(true);
    expect(result.res.statusCode).toBe(200);
    expect(authenticateTeamsLocalAccount).toHaveBeenCalledWith({
      loginLabel: account.loginLabel,
      password: "correct horse battery staple",
    });
    expect(createTeamsSession).toHaveBeenCalledWith({
      accountId: account.id,
      domainId: session.domainId,
      ttlMs: 24 * 60 * 60 * 1_000,
    });
    expect(result.headers.get("set-cookie")).toBe(
      "openclaw_teams_session=opaque-session-secret; Path=/; HttpOnly; Secure; SameSite=Strict",
    );
    expect(result.body()).not.toContain("opaque-session-secret");
    expect(JSON.parse(result.body())).toEqual({
      ok: true,
      session: {
        authenticated: true,
        principal: session.principal,
        domainId: session.domainId,
        expiresAt: session.expiresAt,
      },
    });
  });

  it("accepts an origin-less same-origin browser GET but rejects a cross-site fetch", async () => {
    const sameOrigin = await dispatch(
      createRequest({
        path: "/api/teams/session",
        includeOrigin: false,
        headers: { "sec-fetch-site": "same-origin" },
      }),
    );
    expect(sameOrigin.res.statusCode).toBe(200);

    const crossSite = await dispatch(
      createRequest({
        path: "/api/teams/session",
        includeOrigin: false,
        headers: { "sec-fetch-site": "cross-site" },
      }),
    );
    expect(crossSite.res.statusCode).toBe(403);
  });

  it("uses a non-Secure cookie only for explicit direct loopback HTTP development", async () => {
    const result = await dispatch(
      createRequest({
        path: "/api/teams/login",
        method: "POST",
        remoteAddress: "127.0.0.1",
        encrypted: false,
        headers: { host: "127.0.0.1:18789", origin: "http://127.0.0.1:18789" },
        body: {
          loginLabel: account.loginLabel,
          password: "correct horse battery staple",
          domainId: session.domainId,
        },
      }),
      { allowedOrigins: ["http://127.0.0.1:18789"] },
    );

    expect(result.headers.get("set-cookie")).toBe(
      "openclaw_teams_session=opaque-session-secret; Path=/; HttpOnly; SameSite=Strict",
    );
  });

  it("rejects remote plaintext login and invite credentials before processing them", async () => {
    const login = await dispatch(
      createRequest({
        path: "/api/teams/login",
        method: "POST",
        encrypted: false,
        headers: { host: "192.168.1.20:18789", origin: "http://192.168.1.20:18789" },
        body: {
          loginLabel: account.loginLabel,
          password: "correct horse battery staple",
          domainId: session.domainId,
        },
      }),
      { allowedOrigins: ["http://192.168.1.20:18789"] },
    );
    const invite = await dispatch(
      createRequest({
        path: "/api/teams/invites/accept",
        method: "POST",
        encrypted: false,
        headers: { host: "192.168.1.20:18789", origin: "http://192.168.1.20:18789" },
        body: { code: "one-time-code", loginLabel: account.loginLabel, password: "password" },
      }),
      { allowedOrigins: ["http://192.168.1.20:18789"] },
    );

    expect(login.res.statusCode).toBe(403);
    expect(invite.res.statusCode).toBe(403);
    expect(authenticateTeamsLocalAccount).not.toHaveBeenCalled();
    expect(registerTeamsLocalAccountFromInvite).not.toHaveBeenCalled();
  });

  it("trusts forwarded HTTPS only from a configured immediate proxy", async () => {
    const body = {
      loginLabel: account.loginLabel,
      password: "correct horse battery staple",
      domainId: session.domainId,
    };
    const spoofed = await dispatch(
      createRequest({
        path: "/api/teams/login",
        method: "POST",
        encrypted: false,
        headers: { "x-forwarded-proto": "https" },
        body,
      }),
    );
    const trusted = await dispatch(
      createRequest({
        path: "/api/teams/login",
        method: "POST",
        encrypted: false,
        remoteAddress: "10.0.0.1",
        headers: { "x-forwarded-proto": "https" },
        body,
      }),
      { trustedProxies: ["10.0.0.1"] },
    );

    expect(spoofed.res.statusCode).toBe(403);
    expect(trusted.res.statusCode).toBe(200);
    expect(trusted.headers.get("set-cookie")).toContain("; Secure;");
  });

  it("rejects hostile origins before credential verification", async () => {
    const result = await dispatch(
      createRequest({
        path: "/api/teams/login",
        method: "POST",
        headers: { origin: "https://evil.example" },
        body: {
          loginLabel: account.loginLabel,
          password: "correct horse battery staple",
          domainId: session.domainId,
        },
      }),
    );

    expect(result.res.statusCode).toBe(403);
    expect(result.body()).toBe('{"error":{"message":"Forbidden","type":"forbidden"}}');
    expect(authenticateTeamsLocalAccount).not.toHaveBeenCalled();
  });

  it("returns one generic error for invalid credentials and invalid domain membership", async () => {
    vi.mocked(authenticateTeamsLocalAccount).mockResolvedValueOnce(undefined);
    const invalidCredentials = await dispatch(
      createRequest({
        path: "/api/teams/login",
        method: "POST",
        body: { loginLabel: account.loginLabel, password: "wrong", domainId: session.domainId },
      }),
    );
    vi.mocked(createTeamsSession).mockImplementationOnce(() => {
      throw new Error("Teams session account principal must be a human domain member");
    });
    const invalidDomain = await dispatch(
      createRequest({
        path: "/api/teams/login",
        method: "POST",
        body: {
          loginLabel: account.loginLabel,
          password: "correct horse battery staple",
          domainId: "attacker-selected-domain",
        },
      }),
    );

    expect(invalidCredentials.res.statusCode).toBe(401);
    expect(invalidDomain.res.statusCode).toBe(401);
    expect(invalidCredentials.body()).toBe(invalidDomain.body());
    expect(invalidDomain.body()).not.toContain("domain");
  });

  it("accepts invite codes only from a POST body and never returns the issued token", async () => {
    const queryAttempt = await dispatch(
      createRequest({
        path: "/api/teams/invites/accept?code=leaked-in-history",
        method: "POST",
        body: {
          loginLabel: account.loginLabel,
          password: "correct horse battery staple",
        },
      }),
    );
    expect(queryAttempt.res.statusCode).toBe(400);
    expect(registerTeamsLocalAccountFromInvite).not.toHaveBeenCalled();

    const accepted = await dispatch(
      createRequest({
        path: "/api/teams/invites/accept",
        method: "POST",
        body: {
          code: "invite-code-from-fragment-post-body",
          loginLabel: account.loginLabel,
          password: "correct horse battery staple",
        },
      }),
    );
    expect(accepted.res.statusCode).toBe(201);
    expect(accepted.headers.get("set-cookie")).toContain(
      "openclaw_teams_session=invite-session-secret",
    );
    expect(accepted.body()).not.toContain("invite-session-secret");
    expect(JSON.parse(accepted.body())).toMatchObject({
      destination: { workspaceId: "default", tabId: "tab-1" },
    });
    expect(accepted.body()).not.toContain("workspaces.tab.read");
    expect(registerTeamsLocalAccountFromInvite).toHaveBeenCalledWith({
      code: "invite-code-from-fragment-post-body",
      loginLabel: account.loginLabel,
      password: "correct horse battery staple",
      sessionTtlMs: 24 * 60 * 60 * 1_000,
      validateInvite: expect.any(Function),
    });
  });

  it("reports expired or revoked cookies as unauthenticated and clears them", async () => {
    vi.mocked(resolveTeamsSession).mockReturnValueOnce(undefined);
    const result = await dispatch(
      createRequest({
        path: "/api/teams/session",
        headers: { cookie: "openclaw_teams_session=expired-secret" },
      }),
    );

    expect(result.res.statusCode).toBe(200);
    expect(result.body()).toBe('{"ok":true,"session":{"authenticated":false}}');
    expect(result.headers.get("set-cookie")).toContain(
      "openclaw_teams_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
    );
  });

  it("revokes the current session on logout without echoing its cookie token", async () => {
    const result = await dispatch(
      createRequest({
        path: "/api/teams/logout",
        method: "POST",
        headers: { cookie: "openclaw_teams_session=current-secret" },
        body: {},
      }),
    );

    expect(revokeTeamsSession).toHaveBeenCalledWith({
      id: session.id,
      revokedByPrincipalId: session.principalId,
    });
    expect(result.res.statusCode).toBe(200);
    expect(result.body()).toBe('{"ok":true}');
    expect(result.body()).not.toContain("current-secret");
    expect(result.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("enforces method, JSON content type, and bounded request bodies", async () => {
    const wrongMethod = await dispatch(createRequest({ path: "/api/teams/login" }));
    expect(wrongMethod.res.statusCode).toBe(405);

    const wrongType = await dispatch(
      createRequest({
        path: "/api/teams/login",
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: { loginLabel: "a", password: "b", domainId: "c" },
      }),
    );
    expect(wrongType.res.statusCode).toBe(415);

    const oversized = await dispatch(
      createRequest({
        path: "/api/teams/login",
        method: "POST",
        body: { loginLabel: "a".repeat(20_000), password: "b", domainId: "c" },
      }),
    );
    expect(oversized.res.statusCode).toBe(413);
  });

  it("issues an owner invite from a closed preset without accepting caller-selected grants", async () => {
    const created = await dispatch(
      createRequest({
        path: "/api/teams/invites",
        method: "POST",
        headers: { cookie: "openclaw_teams_session=current-secret" },
        body: {
          workspaceId: "default",
          tabId: "tab-1",
          preset: "read",
          recipientLabel: "person@example.com",
          ttlMs: 60_000,
        },
      }),
    );

    expect(created.res.statusCode).toBe(201);
    expect(createTeamsInvite).toHaveBeenCalledWith({
      domainId: session.domainId,
      createdByPrincipalId: session.principalId,
      recipientLabel: "person@example.com",
      ttlMs: 60_000,
      grants: [
        {
          resource: { namespace: "workspaces", type: "tab", id: "tab-1" },
          permission: "workspaces.tab.read",
        },
      ],
    });
    expect(created.body()).toContain("opaque-invite-code");
    expect(created.body()).toContain('"preset":"read"');
    expect(created.body()).toContain('"tabId":"tab-1"');
    expect(created.body()).not.toContain("workspaces.tab.read");

    vi.mocked(createTeamsInvite).mockClear();
    const rejected = await dispatch(
      createRequest({
        path: "/api/teams/invites",
        method: "POST",
        headers: { cookie: "openclaw_teams_session=current-secret" },
        body: {
          workspaceId: "default",
          tabId: "tab-1",
          preset: "read",
          grants: [{ permission: "workspaces.tab.write" }],
        },
      }),
    );
    expect(rejected.res.statusCode).toBe(400);
    expect(createTeamsInvite).not.toHaveBeenCalled();

    vi.mocked(getAuthorizationResourceParent).mockReturnValue({
      namespace: "workspaces",
      type: "workspace",
      id: "another-workspace",
    });
    const wrongParent = await dispatch(
      createRequest({
        path: "/api/teams/invites",
        method: "POST",
        headers: { cookie: "openclaw_teams_session=current-secret" },
        body: { workspaceId: "default", tabId: "tab-1", preset: "read" },
      }),
    );
    expect(wrongParent.res.statusCode).toBe(400);
    expect(createTeamsInvite).not.toHaveBeenCalled();
  });

  it("does not disclose an invite code in owner list, revoke, or preset responses", async () => {
    vi.mocked(listTeamsInvites).mockReturnValueOnce([ownerInvite]);
    const headers = {
      cookie: "openclaw_teams_session=current-secret",
      "content-type": "application/json",
    };
    const [presets, listed, revoked] = await Promise.all([
      dispatch(createRequest({ path: "/api/teams/invite-presets", headers })),
      dispatch(createRequest({ path: "/api/teams/invites", headers })),
      dispatch(
        createRequest({
          path: "/api/teams/invites/invite-2",
          method: "DELETE",
          headers,
          body: {},
        }),
      ),
    ]);

    expect(presets.res.statusCode).toBe(200);
    expect(presets.body()).toContain('"read"');
    expect(presets.body()).not.toContain("workspaces.tab.read");
    expect(listed.res.statusCode).toBe(200);
    expect(listed.body()).toContain('"preset":"read"');
    expect(listed.body()).toContain('"tabId":"tab-1"');
    expect(revoked.res.statusCode).toBe(200);
    expect(revokeTeamsInvite).toHaveBeenCalledWith({
      id: "invite-2",
      domainId: session.domainId,
      revokedByPrincipalId: session.principalId,
    });
    for (const result of [presets, listed, revoked]) {
      expect(result.body()).not.toContain("opaque-invite-code");
      expect(result.body()).not.toContain("workspaces.tab.read");
    }
  });
});
