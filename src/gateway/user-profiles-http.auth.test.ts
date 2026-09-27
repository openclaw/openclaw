import { createServer, IncomingMessage, ServerResponse, type Server } from "node:http";
import { Socket } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import * as profileAvatars from "../state/user-profiles-avatar.js";
import {
  ensureGatewayOwnerProfile,
  linkEmail,
  setAvatar,
  setUserProfileRole,
  syncGitHubIdentity,
} from "../state/user-profiles.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
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
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterAll(async () => {
    await closeStateDatabaseForTest();
    cleanup();
  });
});

// Most cases cross real HTTP, auth, device pairing, profile storage and the UI loader.
// Provider-backed cases use in-memory HTTP transport and stub external identity responses,
// while retaining the production authorization handler, profile store and observed byte reader.
describe("personal avatar HTTP authentication", () => {
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

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("personal-avatar-auth-"));
    cfg = {};
    auth = { mode: "token", token: "test-shared-secret", allowTailscale: false };
    vi.spyOn(configIo, "getRuntimeConfig").mockImplementation(() => cfg);
    const profile = ensureGatewayOwnerProfile("Avatar test owner");
    expect(setAvatar(profile.id, PNG, "image/png").ok).toBe(true);
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
      const createReader = profileAvatars.createProfileAvatarReader;
      vi.spyOn(profileAvatars, "createProfileAvatarReader").mockImplementation((id, options) => {
        const reader = createReader(id, options);
        return {
          async inspect() {
            if (source === "inspection") {
              entered.resolve();
              await release.promise;
            }
            const prepared = await reader.inspect();
            return {
              ...prepared,
              avatar: source === "host" || source === "Gravatar" ? undefined : prepared.avatar,
              async loadBytes() {
                entered.resolve();
                await release.promise;
                return prepared.loadBytes();
              },
            };
          },
        };
      });
      if (source === "host") {
        vi.spyOn(hostAccountAvatar, "resolveHostAccountAvatar").mockImplementation(async () => {
          entered.resolve();
          await release.promise;
          return { bytes: PNG, mime: "image/jpeg", sha256: "synthetic-avatar" };
        });
      } else if (source === "Gravatar") {
        vi.spyOn(hostAccountAvatar, "resolveHostAccountAvatar").mockResolvedValue(null);
        const profile = syncGitHubIdentity({
          identity: { accountId: 9871, login: "avatar-authority" },
          authenticationAlias: { kind: "email", email: "avatar-authority@example.test" },
        });
        avatarPath = `/api/users/${profile.id}/avatar`;
        const fetch = globalThis.fetch;
        vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (url.startsWith("https://www.gravatar.com/avatar/")) {
            entered.resolve();
            await release.promise;
            return new Response(PNG, { headers: { "content-type": "image/png" } });
          }
          return fetch(input, init);
        });
      }
      const pending = request("test-shared-secret");
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

  it.each(["token", "password", "trusted-proxy"] as const)(
    "loads the saved personal photo with the connected credentials under %s auth",
    async (mode) => {
      auth =
        mode === "trusted-proxy"
          ? {
              mode,
              password: "test-shared-secret",
              trustedProxy: { userHeader: "x-auth-user" },
              allowTailscale: false,
            }
          : { mode, [mode]: "test-shared-secret", allowTailscale: false };
      cfg = { gateway: { trustedProxies: ["127.0.0.1"] } };
      const { token } = await pairDevice();
      expect((await request("test-shared-secret")).status).toBe(200);
      if (mode === "trusted-proxy") {
        // A tunnel may use the configured local password; paired HTTP tokens
        // must not bypass the proxy identity boundary on their own.
        expect((await request(token)).status).toBe(401);
      }
      // The live hello credential wins even with saved shared credentials.
      const candidates = resolveControlUiAuthCandidates({
        hello: { auth: { deviceToken: token } },
        settings: { token: mode === "trusted-proxy" ? "" : "test-shared-secret" },
        password: "test-shared-secret",
      });
      expect(candidates[0] === token).toBe(true);
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
    const metadata = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: identity.id,
            login: identity.id === 510 ? "person" : "person-work",
          }),
        ),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(accessOrigin)) {
        return Promise.resolve(
          new Response(JSON.stringify({ ...identity, idp: { type: "github" } })),
        );
      }
      if (url.startsWith("https://api.github.com/")) {
        return metadata();
      }
      return nativeFetch(input, init);
    });
    const primary = syncGitHubIdentity({
      identity: { accountId: 510, login: "person" },
      authenticationAlias: { kind: "email", email: "personal@example.test" },
    });
    syncGitHubIdentity({
      identity: { accountId: 511, login: "person-work" },
      authenticationAlias: { kind: "email", email: "work@example.test" },
    });
    linkEmail("work@example.test", primary.id);
    setAvatar(primary.id, PNG, "image/png");
    setUserProfileRole(primary.id, "reader");
    avatarPath = "/api/users/" + primary.id + "/avatar";
    const readAvatar = vi.spyOn(profileAvatars, "createProfileAvatarReader");
    const send = async (email = identity.email) => {
      const req = new IncomingMessage(new Socket());
      Object.defineProperty(req.socket, "remoteAddress", { value: "127.0.0.1" });
      req.method = "GET";
      req.url = avatarPath;
      req.headers = {
        "cf-access-authenticated-user-email": email,
        "cf-access-jwt-assertion":
          "header." +
          Buffer.from(JSON.stringify({ iss: accessOrigin })).toString("base64url") +
          ".signature",
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
    setUserProfileRole(primary.id, null);
    invalidateOperatorRolePolicy(primary.id);
    expect((await send()).status).toBe(403);
    expect(metadata).toHaveBeenCalledTimes(2);
    expect(readAvatar).not.toHaveBeenCalled();
    setUserProfileRole(primary.id, "reader");
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
    const unchanged = await request(token, {
      headers: { "If-None-Match": response.headers.get("etag")! },
    });
    expect(unchanged.status).toBe(304);
    expect(
      (await request(undefined, { headers: { "If-None-Match": response.headers.get("etag")! } }))
        .status,
    ).toBe(401);
    // The same paired credential must not become a generic HTTP credential.
    expect(
      (await fetch(origin + "/generic", { headers: { Authorization: "Bearer " + token } })).status,
    ).toBe(401);
  });

  it.each([
    "missing",
    "invalid",
    "query-only",
    "revoked",
    "stale-generation",
    "no-read-scope",
    "node-role",
  ])("rejects %s credentials before returning avatar bytes", async (kind) => {
    const { deviceId, token } = await pairDevice(
      kind === "no-read-scope"
        ? ["operator.approvals"]
        : kind === "node-role"
          ? []
          : ["operator.read"],
      kind === "node-role" ? "node" : "operator",
    );
    if (kind === "revoked") {
      await revokeDeviceToken({ deviceId, role: "operator" });
    }
    if (kind === "stale-generation") {
      auth = { ...auth, token: "rotated-test-secret" };
    }
    if (kind === "query-only") {
      avatarPath += "&token=" + encodeURIComponent(token);
    }
    const credential =
      kind === "missing" || kind === "query-only"
        ? undefined
        : kind === "invalid"
          ? "invalid-test-token"
          : token;
    const response = await request(credential, {
      headers: { "x-openclaw-scopes": "operator.admin" },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).not.toBe("image/png");
  });

  it("fails closed for unbound device identities when profile roles are configured", async () => {
    const { token } = await pairDevice();
    cfg = { gateway: { roles: { definitions: {} } } };
    expect((await request(token)).status).toBe(401);
    expect((await request("test-shared-secret")).status).toBe(200);
  });

  it("does not spend the shared-secret failure budget on valid paired reads", async () => {
    const { token } = await pairDevice();
    rateLimiter = createGatewayAuthRateLimiter({ maxAttempts: 1, exemptLoopback: false });
    expect((await request(token)).status).toBe(200);
    expect((await request(token)).status).toBe(200);
    expect((await request("test-shared-secret")).status).toBe(200);
    expect((await request("invalid-test-token")).status).toBe(401);
    expect((await request("invalid-test-token")).status).toBe(429);
  });
});
