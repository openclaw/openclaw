import { createServer, IncomingMessage, ServerResponse, type Server } from "node:http";
import { Socket } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveControlUiAuthCandidates } from "../../ui/src/app/control-ui-auth.ts";
import { setAvatarGatewayOrigin } from "../../ui/src/lib/identity-avatar-context.ts";
import { resolveAvatarImageUrl } from "../../ui/src/lib/identity-avatar-loader.ts";
import * as configIo from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { ensureDeviceToken, revokeDeviceToken } from "../infra/device-pairing-tokens.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import * as hostAccountAvatar from "../infra/host-account-avatar.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as writes from "../state/user-profile-writes.worker.js";
import * as profileAvatars from "../state/user-profiles-avatar.js";
import { ensureGatewayOwnerProfile } from "../state/user-profiles.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createGatewayAuthRateLimiter, type AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { authorizeGatewayHttpRequestOrReply } from "./http-auth-utils.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";
import { handleUserProfileAvatarHttpRequest } from "./user-profiles-http.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const SHARED_SECRET = "test-shared-secret";
const jsonResponse = (value: unknown) => new Response(JSON.stringify(value));
const inputUrl = (input: string | URL | Request) =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
function githubProfile(accountId: number, login: string, email: string) {
  return writes.syncGitHubIdentity({
    identity: { accountId, login },
    authenticationAlias: { kind: "email", email },
  });
}
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterAll(async () => {
    await closeStateDatabaseForTest();
    cleanup();
  });
});

// Stub only external identity I/O; retain real auth, pairing, profiles and the UI byte reader.
let server: Server;
let origin: string;
let avatarPath: string;
let auth: ResolvedGatewayAuth;
let cfg: OpenClawConfig;
let rateLimiter: AuthRateLimiter | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      const pathname = new URL(req.url ?? "/", origin).pathname;
      if (pathname === "/generic") {
        if (await authorizeGatewayHttpRequestOrReply({ req, res, auth })) {
          res.end("ok");
        }
        return;
      }
      await handleUserProfileAvatarHttpRequest(req, res, pathname, {
        auth,
        rateLimiter,
        getResolvedAuth: () => auth,
        getRuntimeConfig: () => cfg,
      });
    })().catch(() => {
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected an HTTP listener");
  }
  origin = "http://127.0.0.1:" + address.port;
});

afterAll(() => server[Symbol.asyncDispose]());

beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("personal-avatar-auth-"));
  cfg = {};
  auth = { mode: "token", token: SHARED_SECRET, allowTailscale: false };
  vi.spyOn(configIo, "getRuntimeConfig").mockImplementation(() => cfg);
  const profile = ensureGatewayOwnerProfile("Avatar test owner");
  expect(writes.setAvatar(profile.id, PNG, "image/png").ok).toBe(true);
  avatarPath = "/api/users/gateway-owner/avatar?v=synthetic-png";
});

afterEach(() => {
  setAvatarGatewayOrigin(null);
  rateLimiter?.dispose();
  rateLimiter = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function pairDevice(scopes = ["operator.read"], role = "operator") {
  const deviceId = "avatar-test-device";
  const requested = await requestDevicePairing({
    deviceId,
    publicKey: "test-public-key",
    role,
    scopes,
    clientId: "openclaw-control-ui",
    clientMode: "webchat",
  });
  const approved = await approveDevicePairing(requested.request.requestId, {
    callerScopes: ["operator.admin"],
  });
  expect(approved?.status).toBe("approved");
  const issued = await ensureDeviceToken({
    deviceId,
    role,
    scopes,
    issuer: {
      kind: "shared-gateway-auth",
      generation: resolveSharedGatewaySessionGeneration(auth)!,
    },
  });
  if (!issued) {
    throw new Error("device token issuance failed");
  }
  return { deviceId, token: issued.token };
}

function request(credential?: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (credential) {
    headers.set("Authorization", "Bearer " + credential);
  }
  return fetch(origin + avatarPath, { ...init, headers });
}

it.each(["inspection", "saved", "host", "Gravatar"] as const)(
  "withholds a prepared %s avatar after credentials rotate",
  async (source) => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const hold = <T>(run: () => T) => {
      entered.resolve();
      return release.promise.then(run);
    };
    const createReader = profileAvatars.createProfileAvatarReader;
    vi.spyOn(profileAvatars, "createProfileAvatarReader").mockImplementation((id, options) => {
      const reader = createReader(id, options);
      return {
        async inspect() {
          if (source === "inspection") {
            await hold(() => undefined);
          }
          const prepared = await reader.inspect();
          return {
            ...prepared,
            avatar: source === "host" || source === "Gravatar" ? undefined : prepared.avatar,
            loadBytes: () => hold(() => prepared.loadBytes()),
          };
        },
      };
    });
    if (source === "host") {
      vi.spyOn(hostAccountAvatar, "resolveHostAccountAvatar").mockImplementation(() =>
        hold(() => ({ bytes: PNG, mime: "image/jpeg", sha256: "synthetic-avatar" })),
      );
    } else if (source === "Gravatar") {
      vi.spyOn(hostAccountAvatar, "resolveHostAccountAvatar").mockResolvedValue(null);
      const profile = githubProfile(9871, "avatar-authority", "avatar-authority@example.test");
      avatarPath = `/api/users/${profile.id}/avatar`;
      const fetch = globalThis.fetch;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        if (inputUrl(input).startsWith("https://www.gravatar.com/avatar/")) {
          return hold(() => new Response(PNG, { headers: { "content-type": "image/png" } }));
        }
        return fetch(input, init);
      });
    }
    const pending = request(SHARED_SECRET);
    await entered.promise;
    auth = { ...auth, token: "replacement-token" };
    release.resolve();
    const response = await pending;

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).not.toMatch(/^image\//);
    expect(response.headers.get("etag")).toBeNull();
    expect(Buffer.from(await response.arrayBuffer())).not.toEqual(PNG);
  },
);

it.each(["password", "trusted-proxy"] as const)(
  "loads the saved personal photo with the connected credentials under %s auth",
  async (mode) => {
    auth = {
      mode,
      password: SHARED_SECRET,
      allowTailscale: false,
      ...(mode === "trusted-proxy" ? { trustedProxy: { userHeader: "x-auth-user" } } : {}),
    };
    cfg = { gateway: { trustedProxies: ["127.0.0.1"] } };
    const { token } = await pairDevice();
    expect((await request(SHARED_SECRET)).status).toBe(200);
    if (mode === "trusted-proxy") {
      // Paired tokens alone must not bypass proxy identity, unlike the tunnel's local password.
      expect((await request(token)).status).toBe(401);
    }
    const candidates = resolveControlUiAuthCandidates({
      hello: { auth: { deviceToken: token } },
      settings: { token: mode === "trusted-proxy" ? "" : SHARED_SECRET },
      password: SHARED_SECRET,
    });
    expect(candidates[0]).toBe(token);
    setAvatarGatewayOrigin(origin, candidates);
    const blobUrl = await resolveAvatarImageUrl(avatarPath);
    expect(blobUrl?.startsWith("blob:")).toBe(true);
    const image = await fetch(blobUrl!);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await image.arrayBuffer())).toEqual(PNG);
  },
);

it("checks linked-account authority before avatar I/O, including revocation and alias reassignment", async () => {
  vi.stubEnv("GH_TOKEN", undefined);
  vi.stubEnv("GITHUB_TOKEN", undefined);
  const accessOrigin = "https://team.cloudflareaccess.com";
  const identity = { id: 510, email: "personal@example.test" };
  const trustedProxy = {
    userHeader: "cf-access-authenticated-user-email",
    requiredHeaders: ["cf-access-jwt-assertion"],
    allowLoopback: true,
  };
  auth = { mode: "trusted-proxy", trustedProxy, allowTailscale: false };
  cfg = {
    gateway: {
      auth: { mode: "trusted-proxy", trustedProxy },
      trustedProxies: ["127.0.0.1"],
      roles: {
        default: "guest",
        definitions: {
          reader: { agents: "*", sessions: { others: "view" }, scopes: ["operator.read"] },
          guest: { agents: [], sessions: { others: "none" }, scopes: [] },
        },
      },
    },
  };
  const nativeFetch = globalThis.fetch;
  const metadata = vi.fn(async () =>
    jsonResponse({
      id: identity.id,
      login: identity.id === 510 ? "person" : "person-work",
    }),
  );
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = inputUrl(input);
    if (url.startsWith(accessOrigin)) {
      return Promise.resolve(jsonResponse({ ...identity, idp: { type: "github" } }));
    }
    if (url.startsWith("https://api.github.com/")) {
      return metadata();
    }
    return nativeFetch(input, init);
  });
  const primary = githubProfile(510, "person", "personal@example.test");
  githubProfile(511, "person-work", "work@example.test");
  writes.linkEmail("work@example.test", primary.id);
  writes.setAvatar(primary.id, PNG, "image/png");
  writes.setUserProfileRole(primary.id, "reader");
  avatarPath = "/api/users/" + primary.id + "/avatar";
  const readAvatar = vi.spyOn(profileAvatars, "createProfileAvatarReader");
  const assertion = `header.${Buffer.from(JSON.stringify({ iss: accessOrigin })).toString("base64url")}.signature`;
  const send = async (email = identity.email) => {
    const req = new IncomingMessage(new Socket());
    Object.defineProperty(req.socket, "remoteAddress", { value: "127.0.0.1" });
    req.method = "GET";
    req.url = avatarPath;
    req.headers = {
      "cf-access-authenticated-user-email": email,
      "cf-access-jwt-assertion": assertion,
      "x-forwarded-for": "203.0.113.10",
      "x-openclaw-scopes": "operator.read,operator.admin",
    };
    const res = new ServerResponse(req);
    let bytes = Buffer.alloc(0);
    vi.spyOn(res, "end").mockImplementation((chunk?: unknown) => {
      if (typeof chunk === "string") {
        bytes = Buffer.from(chunk);
      } else if (chunk instanceof Uint8Array) {
        bytes = Buffer.from(chunk);
      }
      return res;
    });
    try {
      await handleUserProfileAvatarHttpRequest(req, res, avatarPath, { auth });
      return { status: res.statusCode, bytes };
    } finally {
      req.destroy();
    }
  };
  for (const account of [
    { id: 510, email: "personal@example.test" },
    { id: 511, email: "work@example.test" },
  ]) {
    Object.assign(identity, account);
    const response = await send();
    expect(response.status, response.bytes.toString()).toBe(200);
    expect(response.bytes).toEqual(PNG);
  }
  expect(metadata).toHaveBeenCalledTimes(2);
  expect(readAvatar).toHaveBeenCalledTimes(2);
  readAvatar.mockClear();
  writes.setUserProfileRole(primary.id, null);
  invalidateOperatorRolePolicy(primary.id);
  expect((await send()).status).toBe(403);
  expect(metadata).toHaveBeenCalledTimes(2);
  expect(readAvatar).not.toHaveBeenCalled();
  writes.setUserProfileRole(primary.id, "reader");
  invalidateOperatorRolePolicy(primary.id);
  identity.id = 512;
  expect((await send()).status).toBe(403);
  expect(metadata).toHaveBeenCalledTimes(3);
  expect(readAvatar).not.toHaveBeenCalled();
  identity.email = "mismatched@example.test";
  expect((await send("work@example.test")).status).toBe(401);
  expect(readAvatar).not.toHaveBeenCalled();
});

it("allows device-only clients and authenticates HEAD and ETag revalidation", async () => {
  const { token } = await pairDevice();
  const response = await request(token);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
  const head = await request(token, { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
  const revalidation = { headers: { "If-None-Match": response.headers.get("etag")! } };
  expect((await request(token, revalidation)).status).toBe(304);
  expect((await request(undefined, revalidation)).status).toBe(401);
  // The same paired credential must not become a generic HTTP credential.
  expect(
    (await fetch(origin + "/generic", { headers: { Authorization: "Bearer " + token } })).status,
  ).toBe(401);
});

it.each<[string, string[]?, string?]>([
  ["query-only"],
  ["revoked"],
  ["stale-generation"],
  ["no-read-scope", ["operator.approvals"]],
  ["node-role", [], "node"],
])("rejects %s credentials before returning avatar bytes", async (kind, scopes, role) => {
  const { deviceId, token } = await pairDevice(scopes, role);
  if (kind === "revoked") {
    await revokeDeviceToken({ deviceId, role: "operator" });
  }
  if (kind === "stale-generation") {
    auth = { ...auth, token: "rotated-test-secret" };
  }
  if (kind === "query-only") {
    avatarPath += "&token=" + encodeURIComponent(token);
  }
  const response = await request(kind === "query-only" ? undefined : token, {
    headers: { "x-openclaw-scopes": "operator.admin" },
  });
  expect(response.status).toBe(401);
  expect(response.headers.get("content-type")).not.toBe("image/png");
});

it("fails closed for unbound device identities when profile roles are configured", async () => {
  const { token } = await pairDevice();
  cfg = { gateway: { roles: { definitions: {} } } };
  expect((await request(token)).status).toBe(401);
  expect((await request(SHARED_SECRET)).status).toBe(200);
});

it("does not spend the shared-secret failure budget on valid paired reads", async () => {
  const { token } = await pairDevice();
  rateLimiter = createGatewayAuthRateLimiter(
    { maxAttempts: 1, exemptLoopback: false },
    { scheduler: createTestGatewayScheduler() },
  );
  expect((await request(token)).status).toBe(200);
  expect((await request(token)).status).toBe(200);
  expect((await request(SHARED_SECRET)).status).toBe(200);
  expect((await request("invalid-test-token")).status).toBe(401);
  expect((await request("invalid-test-token")).status).toBe(429);
});
