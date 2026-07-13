// Gateway-hosted Teams identity routes keep opaque session credentials in HttpOnly cookies.
import type { IncomingMessage, ServerResponse } from "node:http";
import { getRuntimeConfig } from "../config/io.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { isLocalDirectRequest } from "./auth.js";
import { getAuthorizationResourceParent } from "./authorization/resource-operations.js";
import {
  authenticateTeamsLocalAccount,
  createTeamsSession,
  resolveTeamsSession,
  revokeTeamsSession,
  type TeamsSession,
} from "./authorization/teams-identity.js";
import {
  createTeamsInvite,
  listTeamsInvites,
  registerTeamsLocalAccountFromInvite,
  revokeTeamsInvite,
  type TeamsInvite,
} from "./authorization/teams-invites.js";
import {
  readJsonBodyOrError,
  sendInvalidRequest,
  sendJson,
  sendMethodNotAllowed,
  sendRateLimited,
} from "./http-common.js";
import { isTrustedProxyAddress, resolveRequestClientIp } from "./net.js";
import { checkBrowserOrigin } from "./origin-check.js";
import { withSerializedRateLimitAttempt } from "./rate-limit-attempt-serialization.js";
import {
  isExplicitLoopbackHttpDev,
  readTeamsSessionCookie,
  serializeExpiredTeamsSessionCookie,
  serializeTeamsSessionCookie,
} from "./teams-http-cookie.js";

const TEAMS_API_PREFIX = "/api/teams";
const TEAMS_LOGIN_PATH = `${TEAMS_API_PREFIX}/login`;
const TEAMS_LOGOUT_PATH = `${TEAMS_API_PREFIX}/logout`;
const TEAMS_SESSION_PATH = `${TEAMS_API_PREFIX}/session`;
const TEAMS_INVITE_ACCEPT_PATH = `${TEAMS_API_PREFIX}/invites/accept`;
const TEAMS_INVITE_PRESETS_PATH = `${TEAMS_API_PREFIX}/invite-presets`;
const TEAMS_INVITES_PATH = `${TEAMS_API_PREFIX}/invites`;
const TEAMS_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_TEAMS_BODY_BYTES = 16 * 1_024;
const TEAMS_LOGIN_RATE_LIMIT_SCOPE = "teams-login";
const TEAMS_INVITE_RATE_LIMIT_SCOPE = "teams-invite-accept";
const TEAMS_INVITE_CREATE_RATE_LIMIT_SCOPE = "teams-invite-create";
const TEAMS_INVITE_REVOKE_RATE_LIMIT_SCOPE = "teams-invite-revoke";

const TEAMS_INVITE_PRESETS = {
  read: { label: "Read" },
  request: { label: "Request changes" },
  write: { label: "Write" },
} as const;

type TeamsInvitePreset = keyof typeof TEAMS_INVITE_PRESETS;

type TeamsHttpOptions = {
  allowedOrigins?: string[];
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
  sessionTtlMs?: number;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasOnlyKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key))
  );
}

function requiredBodyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function resolveSecureCookie(req: IncomingMessage, options: TeamsHttpOptions): boolean {
  const trustedProxies = options.trustedProxies ?? [];
  const allowRealIpFallback = options.allowRealIpFallback === true;
  const directLocalRequest = isLocalDirectRequest(req, trustedProxies, allowRealIpFallback);
  return !isExplicitLoopbackHttpDev({
    directLocalRequest,
    requestHost: req.headers.host,
    requestOrigin: req.headers.origin,
  });
}

function sendForbidden(res: ServerResponse): void {
  sendJson(res, 403, { error: { message: "Forbidden", type: "forbidden" } });
}

function sendGenericLoginFailure(res: ServerResponse): void {
  sendJson(res, 401, {
    error: { message: "Invalid login credentials", type: "unauthorized" },
  });
}

function sendGenericInviteFailure(res: ServerResponse): void {
  sendJson(res, 400, {
    error: { message: "Invite is invalid or unavailable", type: "invalid_request_error" },
  });
}

function sendGenericInviteAdminFailure(res: ServerResponse): void {
  sendJson(res, 400, {
    error: { message: "Invite request is unavailable", type: "invalid_request_error" },
  });
}

function sendUnauthorized(res: ServerResponse): void {
  sendJson(res, 401, { error: { message: "Unauthorized", type: "unauthorized" } });
}

function writeSessionCookie(res: ServerResponse, token: string, secure: boolean): void {
  res.setHeader("Set-Cookie", serializeTeamsSessionCookie(token, secure));
}

function clearSessionCookie(res: ServerResponse, secure: boolean): void {
  res.setHeader("Set-Cookie", serializeExpiredTeamsSessionCookie(secure));
}

function publicSession(session: TeamsSession) {
  return {
    authenticated: true,
    principal: session.principal,
    domainId: session.domainId,
    expiresAt: session.expiresAt,
  } as const;
}

function publicInvite(invite: TeamsInvite) {
  const tabIds = new Set(
    invite.grants
      .filter((grant) => grant.resource.namespace === "workspaces" && grant.resource.type === "tab")
      .map((grant) => grant.resource.id),
  );
  const permissions = new Set(invite.grants.map((grant) => grant.permission));
  const preset: TeamsInvitePreset | undefined =
    permissions.size === 1 && permissions.has("workspaces.tab.read")
      ? "read"
      : permissions.size === 2 &&
          permissions.has("workspaces.tab.read") &&
          permissions.has("workspaces.tab.changeRequest.create")
        ? "request"
        : permissions.size === 2 &&
            permissions.has("workspaces.tab.read") &&
            permissions.has("workspaces.tab.write")
          ? "write"
          : undefined;
  return {
    id: invite.id,
    ...(preset ? { preset } : {}),
    ...(tabIds.size === 1 ? { tabId: [...tabIds][0] } : {}),
    recipientLabel: invite.recipientLabel,
    state: invite.state,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    redeemedAt: invite.redeemedAt,
    revokedAt: invite.revokedAt,
  } as const;
}

function inviteDestination(invite: TeamsInvite): { workspaceId: string; tabId: string } {
  const tabIds = new Set(
    invite.grants
      .filter((grant) => grant.resource.namespace === "workspaces" && grant.resource.type === "tab")
      .map((grant) => grant.resource.id),
  );
  if (tabIds.size !== 1) {
    throw new Error("Teams invite has no exact tab destination");
  }
  const tabId = [...tabIds][0]!;
  const parent = getAuthorizationResourceParent({
    domainId: invite.domainId,
    resource: { namespace: "workspaces", type: "tab", id: tabId },
  });
  if (parent?.namespace !== "workspaces" || parent.type !== "workspace") {
    throw new Error("Teams invite tab destination is unavailable");
  }
  return { workspaceId: parent.id, tabId };
}

function inviteGrants(preset: TeamsInvitePreset, tabId: string) {
  const resource = { namespace: "workspaces", type: "tab", id: tabId } as const;
  const permissions =
    preset === "read"
      ? ["workspaces.tab.read"]
      : preset === "request"
        ? ["workspaces.tab.read", "workspaces.tab.changeRequest.create"]
        : ["workspaces.tab.read", "workspaces.tab.write"];
  return permissions.map((permission) => ({ resource, permission }));
}

function isTeamsInvitePreset(value: unknown): value is TeamsInvitePreset {
  return typeof value === "string" && value in TEAMS_INVITE_PRESETS;
}

function checkSameOrigin(req: IncomingMessage, options: TeamsHttpOptions): boolean {
  const origin = Array.isArray(req.headers.origin) ? undefined : req.headers.origin;
  const directLocalRequest = isLocalDirectRequest(
    req,
    options.trustedProxies ?? [],
    options.allowRealIpFallback === true,
  );
  if (!origin && req.method === "GET") {
    return directLocalRequest || req.headers["sec-fetch-site"] === "same-origin";
  }
  return checkBrowserOrigin({
    requestHost: req.headers.host,
    origin,
    allowedOrigins: options.allowedOrigins,
    isLocalClient: directLocalRequest,
  }).ok;
}

function isSecureTeamsTransport(req: IncomingMessage, options: TeamsHttpOptions): boolean {
  if ((req.socket as IncomingMessage["socket"] & { encrypted?: boolean }).encrypted === true) {
    return true;
  }
  const directLocalRequest = isLocalDirectRequest(
    req,
    options.trustedProxies ?? [],
    options.allowRealIpFallback === true,
  );
  if (
    isExplicitLoopbackHttpDev({
      directLocalRequest,
      requestHost: req.headers.host,
      requestOrigin: Array.isArray(req.headers.origin) ? undefined : req.headers.origin,
    })
  ) {
    return true;
  }
  const forwardedProto = req.headers["x-forwarded-proto"];
  return (
    typeof forwardedProto === "string" &&
    forwardedProto.trim().toLowerCase() === "https" &&
    isTrustedProxyAddress(req.socket.remoteAddress, options.trustedProxies)
  );
}

function requireJsonContentType(req: IncomingMessage, res: ServerResponse): boolean {
  const contentType = req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType === "application/json") {
    return true;
  }
  sendJson(res, 415, {
    error: { message: "Content-Type must be application/json", type: "invalid_request_error" },
  });
  return false;
}

async function readStrictJsonRecord(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<JsonRecord | undefined> {
  if (!requireJsonContentType(req, res)) {
    return undefined;
  }
  const value = await readJsonBodyOrError(req, res, MAX_TEAMS_BODY_BYTES);
  if (!isRecord(value)) {
    if (value !== undefined) {
      sendInvalidRequest(res, "request body must be a JSON object");
    }
    return undefined;
  }
  return value;
}

async function withRateLimit<T>(params: {
  limiter: AuthRateLimiter | undefined;
  ip: string | undefined;
  scope: string;
  res: ServerResponse;
  attempt: () => Promise<T | undefined>;
}): Promise<T | undefined> {
  return await withSerializedRateLimitAttempt({
    ip: params.ip,
    scope: params.scope,
    run: async () => {
      const limit = params.limiter?.check(params.ip, params.scope);
      if (limit && !limit.allowed) {
        sendRateLimited(params.res, limit.retryAfterMs);
        return undefined;
      }
      return await params.attempt();
    },
  });
}

/** Resolves the current request's valid Teams session without exposing its opaque cookie token. */
export function resolveTeamsSessionFromRequest(req: IncomingMessage): TeamsSession | undefined {
  const token = readTeamsSessionCookie(req);
  return token ? resolveTeamsSession({ token }) : undefined;
}

function requireTeamsSession(req: IncomingMessage, res: ServerResponse): TeamsSession | undefined {
  const session = resolveTeamsSessionFromRequest(req);
  if (!session) {
    sendUnauthorized(res);
  }
  return session;
}

async function handleLogin(
  req: IncomingMessage,
  res: ServerResponse,
  options: TeamsHttpOptions,
): Promise<void> {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return;
  }
  const body = await readStrictJsonRecord(req, res);
  if (!body) {
    return;
  }
  if (!hasExactKeys(body, ["loginLabel", "password", "domainId"])) {
    sendInvalidRequest(res, "invalid login request");
    return;
  }
  const loginLabel = requiredBodyString(body.loginLabel);
  const password = requiredBodyString(body.password);
  const domainId = requiredBodyString(body.domainId);
  if (!loginLabel || !password || !domainId) {
    sendInvalidRequest(res, "invalid login request");
    return;
  }

  const clientIp = resolveRequestClientIp(
    req,
    options.trustedProxies ?? [],
    options.allowRealIpFallback === true,
  );
  await withRateLimit({
    limiter: options.rateLimiter,
    ip: clientIp,
    scope: TEAMS_LOGIN_RATE_LIMIT_SCOPE,
    res,
    attempt: async () => {
      try {
        const account = await authenticateTeamsLocalAccount({ loginLabel, password });
        if (!account) {
          options.rateLimiter?.recordFailure(clientIp, TEAMS_LOGIN_RATE_LIMIT_SCOPE);
          sendGenericLoginFailure(res);
          return;
        }
        // createTeamsSession performs the authoritative current membership check.
        const created = createTeamsSession({
          accountId: account.id,
          domainId,
          ttlMs: options.sessionTtlMs ?? TEAMS_SESSION_TTL_MS,
        });
        options.rateLimiter?.reset(clientIp, TEAMS_LOGIN_RATE_LIMIT_SCOPE);
        writeSessionCookie(res, created.token, resolveSecureCookie(req, options));
        sendJson(res, 200, { ok: true, session: publicSession(created.session) });
      } catch {
        options.rateLimiter?.recordFailure(clientIp, TEAMS_LOGIN_RATE_LIMIT_SCOPE);
        sendGenericLoginFailure(res);
      }
    },
  });
}

async function handleInviteAcceptance(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: TeamsHttpOptions,
): Promise<void> {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return;
  }
  if (url.search) {
    sendInvalidRequest(res, "invite code must be submitted in the request body");
    return;
  }
  const body = await readStrictJsonRecord(req, res);
  if (!body) {
    return;
  }
  if (!hasExactKeys(body, ["code", "loginLabel", "password"])) {
    sendInvalidRequest(res, "invalid invite request");
    return;
  }
  const code = requiredBodyString(body.code);
  const loginLabel = requiredBodyString(body.loginLabel);
  const password = requiredBodyString(body.password);
  if (!code || !loginLabel || !password) {
    sendInvalidRequest(res, "invalid invite request");
    return;
  }

  const clientIp = resolveRequestClientIp(
    req,
    options.trustedProxies ?? [],
    options.allowRealIpFallback === true,
  );
  await withRateLimit({
    limiter: options.rateLimiter,
    ip: clientIp,
    scope: TEAMS_INVITE_RATE_LIMIT_SCOPE,
    res,
    attempt: async () => {
      try {
        const registered = await registerTeamsLocalAccountFromInvite({
          code,
          loginLabel,
          password,
          sessionTtlMs: options.sessionTtlMs ?? TEAMS_SESSION_TTL_MS,
          validateInvite: inviteDestination,
        });
        options.rateLimiter?.reset(clientIp, TEAMS_INVITE_RATE_LIMIT_SCOPE);
        const destination = registered.validation as ReturnType<typeof inviteDestination>;
        writeSessionCookie(res, registered.session.token, resolveSecureCookie(req, options));
        sendJson(res, 201, {
          ok: true,
          session: publicSession(registered.session.session),
          destination,
        });
      } catch {
        options.rateLimiter?.recordFailure(clientIp, TEAMS_INVITE_RATE_LIMIT_SCOPE);
        sendGenericInviteFailure(res);
      }
    },
  });
}

async function handleLogout(
  req: IncomingMessage,
  res: ServerResponse,
  options: TeamsHttpOptions,
): Promise<void> {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return;
  }
  const body = await readStrictJsonRecord(req, res);
  if (!body) {
    return;
  }
  if (!hasExactKeys(body, [])) {
    sendInvalidRequest(res, "invalid logout request");
    return;
  }
  const session = resolveTeamsSessionFromRequest(req);
  if (session) {
    revokeTeamsSession({ id: session.id, revokedByPrincipalId: session.principalId });
  }
  clearSessionCookie(res, resolveSecureCookie(req, options));
  sendJson(res, 200, { ok: true });
}

function handleSessionStatus(
  req: IncomingMessage,
  res: ServerResponse,
  options: TeamsHttpOptions,
): void {
  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return;
  }
  const session = resolveTeamsSessionFromRequest(req);
  if (!session) {
    clearSessionCookie(res, resolveSecureCookie(req, options));
    sendJson(res, 200, { ok: true, session: { authenticated: false } });
    return;
  }
  sendJson(res, 200, { ok: true, session: publicSession(session) });
}

function handleInvitePresets(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return;
  }
  if (!requireTeamsSession(req, res)) {
    return;
  }
  sendJson(res, 200, {
    ok: true,
    presets: Object.entries(TEAMS_INVITE_PRESETS).map(([id, preset]) => ({
      id,
      label: preset.label,
    })),
  });
}

function handleInviteList(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return;
  }
  const session = requireTeamsSession(req, res);
  if (!session) {
    return;
  }
  try {
    const invites = listTeamsInvites({
      domainId: session.domainId,
      requestedByPrincipalId: session.principalId,
    });
    sendJson(res, 200, { ok: true, invites: invites.map(publicInvite) });
  } catch {
    sendGenericInviteAdminFailure(res);
  }
}

async function handleInviteCreate(
  req: IncomingMessage,
  res: ServerResponse,
  options: TeamsHttpOptions,
): Promise<void> {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return;
  }
  const session = requireTeamsSession(req, res);
  if (!session) {
    return;
  }
  const body = await readStrictJsonRecord(req, res);
  if (!body) {
    return;
  }
  if (!hasOnlyKeys(body, ["workspaceId", "tabId", "preset"], ["recipientLabel", "ttlMs"])) {
    sendInvalidRequest(res, "invalid invite request");
    return;
  }
  const workspaceId = requiredBodyString(body.workspaceId);
  const tabId = requiredBodyString(body.tabId);
  const preset = isTeamsInvitePreset(body.preset) ? body.preset : undefined;
  const recipientLabel =
    body.recipientLabel === undefined ? undefined : requiredBodyString(body.recipientLabel);
  const ttlMs =
    body.ttlMs === undefined
      ? undefined
      : typeof body.ttlMs === "number" && Number.isSafeInteger(body.ttlMs)
        ? body.ttlMs
        : undefined;
  if (
    !workspaceId ||
    !tabId ||
    !preset ||
    (body.recipientLabel !== undefined && !recipientLabel) ||
    (body.ttlMs !== undefined && (ttlMs === undefined || ttlMs <= 0))
  ) {
    sendInvalidRequest(res, "invalid invite request");
    return;
  }
  const parent = getAuthorizationResourceParent({
    domainId: session.domainId,
    resource: { namespace: "workspaces", type: "tab", id: tabId },
  });
  if (
    parent?.namespace !== "workspaces" ||
    parent.type !== "workspace" ||
    parent.id !== workspaceId
  ) {
    sendGenericInviteAdminFailure(res);
    return;
  }

  const clientIp = resolveRequestClientIp(
    req,
    options.trustedProxies ?? [],
    options.allowRealIpFallback === true,
  );
  await withRateLimit({
    limiter: options.rateLimiter,
    ip: clientIp,
    scope: TEAMS_INVITE_CREATE_RATE_LIMIT_SCOPE,
    res,
    attempt: async () => {
      try {
        // The session fixes the domain and human creator; the preset fixes the exact tab grants.
        const created = createTeamsInvite({
          domainId: session.domainId,
          createdByPrincipalId: session.principalId,
          recipientLabel,
          ttlMs: ttlMs ?? TEAMS_SESSION_TTL_MS,
          grants: inviteGrants(preset, tabId),
        });
        options.rateLimiter?.reset(clientIp, TEAMS_INVITE_CREATE_RATE_LIMIT_SCOPE);
        sendJson(res, 201, { ok: true, code: created.code, invite: publicInvite(created.invite) });
      } catch {
        options.rateLimiter?.recordFailure(clientIp, TEAMS_INVITE_CREATE_RATE_LIMIT_SCOPE);
        sendGenericInviteAdminFailure(res);
      }
    },
  });
}

async function handleInviteRevoke(
  req: IncomingMessage,
  res: ServerResponse,
  inviteId: string,
  options: TeamsHttpOptions,
): Promise<void> {
  if (req.method !== "DELETE") {
    sendMethodNotAllowed(res, "DELETE");
    return;
  }
  const session = requireTeamsSession(req, res);
  if (!session) {
    return;
  }
  const body = await readStrictJsonRecord(req, res);
  if (!body) {
    return;
  }
  if (!hasExactKeys(body, [])) {
    sendInvalidRequest(res, "invalid invite revoke request");
    return;
  }
  const clientIp = resolveRequestClientIp(
    req,
    options.trustedProxies ?? [],
    options.allowRealIpFallback === true,
  );
  await withRateLimit({
    limiter: options.rateLimiter,
    ip: clientIp,
    scope: TEAMS_INVITE_REVOKE_RATE_LIMIT_SCOPE,
    res,
    attempt: async () => {
      try {
        revokeTeamsInvite({
          id: inviteId,
          domainId: session.domainId,
          revokedByPrincipalId: session.principalId,
        });
        options.rateLimiter?.reset(clientIp, TEAMS_INVITE_REVOKE_RATE_LIMIT_SCOPE);
        sendJson(res, 200, { ok: true });
      } catch {
        options.rateLimiter?.recordFailure(clientIp, TEAMS_INVITE_REVOKE_RATE_LIMIT_SCOPE);
        sendGenericInviteAdminFailure(res);
      }
    },
  });
}

/** Handles gateway-hosted Teams login/logout/invite/session routes before the SPA catch-all. */
export async function handleTeamsHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  input: TeamsHttpOptions = {},
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (
    url.pathname !== TEAMS_LOGIN_PATH &&
    url.pathname !== TEAMS_LOGOUT_PATH &&
    url.pathname !== TEAMS_SESSION_PATH &&
    url.pathname !== TEAMS_INVITE_ACCEPT_PATH &&
    url.pathname !== TEAMS_INVITE_PRESETS_PATH &&
    url.pathname !== TEAMS_INVITES_PATH &&
    !/^\/api\/teams\/invites\/[^/]+$/.test(url.pathname)
  ) {
    return false;
  }
  const config = getRuntimeConfig();
  const options: TeamsHttpOptions = {
    trustedProxies: input.trustedProxies ?? config.gateway?.trustedProxies ?? [],
    allowRealIpFallback: input.allowRealIpFallback ?? config.gateway?.allowRealIpFallback ?? false,
    allowedOrigins: input.allowedOrigins ?? config.gateway?.controlUi?.allowedOrigins,
    rateLimiter: input.rateLimiter,
    sessionTtlMs: input.sessionTtlMs,
  };
  if (!checkSameOrigin(req, options)) {
    sendForbidden(res);
    return true;
  }
  if (!isSecureTeamsTransport(req, options)) {
    sendForbidden(res);
    return true;
  }

  if (url.pathname === TEAMS_LOGIN_PATH) {
    await handleLogin(req, res, options);
  } else if (url.pathname === TEAMS_INVITE_ACCEPT_PATH) {
    await handleInviteAcceptance(req, res, url, options);
  } else if (url.pathname === TEAMS_INVITE_PRESETS_PATH) {
    handleInvitePresets(req, res);
  } else if (url.pathname === TEAMS_INVITES_PATH) {
    if (req.method === "GET") {
      handleInviteList(req, res);
    } else {
      await handleInviteCreate(req, res, options);
    }
  } else if (url.pathname.startsWith(`${TEAMS_INVITES_PATH}/`)) {
    const inviteId = url.pathname.slice(`${TEAMS_INVITES_PATH}/`.length);
    if (!requiredBodyString(inviteId)) {
      sendInvalidRequest(res, "invalid invite request");
    } else {
      await handleInviteRevoke(req, res, inviteId, options);
    }
  } else if (url.pathname === TEAMS_LOGOUT_PATH) {
    await handleLogout(req, res, options);
  } else {
    handleSessionStatus(req, res, options);
  }
  return true;
}
