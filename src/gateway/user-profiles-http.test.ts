import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { WorkerTaskError } from "../infra/worker-task-pool.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { repairMergedGatewayOwnerProfile } from "../state/user-profiles-owner-migration.js";
import { UserProfileNotFoundError } from "../state/user-profiles-schema.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { bindHttpResponseAuthority } from "./http-request-authority.js";
import { handleUserProfileAvatarHttpRequest } from "./user-profiles-http.js";

const authorizeControlUiReadRequestOrReply = vi.hoisted(() => vi.fn());
const getRuntimeConfig = vi.hoisted(() => vi.fn());
const avatarFixture = vi.hoisted(() => vi.fn());
const createProfileAvatarReader = vi.hoisted(() => vi.fn());
const getUserProfileAvatarDataReadOnly = vi.hoisted(() => vi.fn());
const isGatewayReadonlyWork = vi.hoisted(() => vi.fn());
const loadAvatarBytes = vi.hoisted(() => vi.fn());
const profileFixture = vi.hoisted(() => vi.fn());
const resolveHostAccountAvatar = vi.hoisted(() => vi.fn());
const resolveVerifiedSystemNativeGitHubAccount = vi.hoisted(() => vi.fn());
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterAll(async () => {
    await closeStateDatabaseForTest();
    cleanup();
  });
});

vi.mock("../infra/host-account-avatar.js", () => ({ resolveHostAccountAvatar }));
vi.mock("../agents/github-tool-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/github-tool-identity.js")>()),
  resolveVerifiedSystemNativeGitHubAccount,
}));

vi.mock("./http-auth-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http-auth-utils.js")>()),
  authorizeControlUiReadRequestOrReply,
}));
vi.mock("../config/io.js", () => ({ getRuntimeConfig }));
vi.mock("../state/user-profiles-avatar.js", () => ({ createProfileAvatarReader }));
vi.mock("../state/user-profile-reads.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/user-profile-reads.js")>()),
  getUserProfileAvatarDataReadOnly,
}));
vi.mock("../process/gateway-work-admission.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/gateway-work-admission.js")>()),
  isGatewayReadonlyWork,
}));

function emailHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

function fetchUrl(input: URL | RequestInfo): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function response() {
  const end = vi.fn();
  const setHeader = vi.fn();
  const writeHead = vi.fn();
  return {
    end,
    response: Object.assign(new EventEmitter(), {
      end,
      setHeader,
      writeHead,
      socket: null,
    }) as unknown as ServerResponse,
    setHeader,
    writeHead,
  };
}

function request(path: string, headers: Record<string, string> = {}) {
  return {
    method: "GET",
    url: path,
    headers,
    socket: new EventEmitter(),
  } as unknown as IncomingMessage;
}

function serveProfile(
  profileId: string,
  res: ReturnType<typeof response>,
  fetchImpl: typeof fetch,
) {
  vi.stubGlobal("fetch", fetchImpl);
  return handleUserProfileAvatarHttpRequest(
    request("/ignored-by-handler"),
    res.response,
    `/api/users/${profileId}/avatar`,
    { auth: {} as never },
  );
}

describe("profile avatar HTTP endpoint", () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    authorizeControlUiReadRequestOrReply.mockReset();
    getUserProfileAvatarDataReadOnly.mockReset();
    isGatewayReadonlyWork.mockReset().mockReturnValue(false);
    avatarFixture.mockReset();
    loadAvatarBytes.mockReset().mockImplementation(async (avatar) => avatar);
    createProfileAvatarReader.mockReset().mockImplementation((id: string) => ({
      async inspect() {
        const avatar = avatarFixture(id);
        const profile = avatar ? { id, mergedInto: null, emails: [] } : profileFixture(id);
        return {
          profile,
          hasAvatar: Boolean(avatar),
          avatar: avatar && { ...avatar, bytes: undefined, byteLength: avatar.bytes.byteLength },
          emails: profile?.emails ?? [],
          isCurrent: () => true,
          loadBytes: () => loadAvatarBytes(avatar),
        };
      },
    }));
    profileFixture.mockReset();
    getRuntimeConfig.mockReset();
    resolveHostAccountAvatar.mockReset().mockResolvedValue(null);
    resolveVerifiedSystemNativeGitHubAccount.mockReset();
    authorizeControlUiReadRequestOrReply.mockImplementation(({ res }: { res: ServerResponse }) =>
      bindHttpResponseAuthority({}, res, () => true),
    );
    getRuntimeConfig.mockReturnValue({
      gateway: { controlUi: { allowedOrigins: ["https://control.example"] } },
    });
  });

  it.each(["saved", "head", "unchanged", "missing", "revoked"] as const)(
    "serves only stored avatar data under frozen read admission (%s)",
    async (outcome) => {
      isGatewayReadonlyWork.mockReturnValue(true);
      const reached = createDeferred();
      const release = createDeferred();
      let current = true;
      authorizeControlUiReadRequestOrReply.mockImplementation(({ res }: { res: ServerResponse }) =>
        bindHttpResponseAuthority({}, res, () => current),
      );
      const bytes = new Uint8Array([1, 2, 3]);
      const materialize = vi.fn(() => bytes);
      getUserProfileAvatarDataReadOnly.mockImplementationOnce(
        async (_id, _options, shouldLoadBytes) => {
          reached.resolve();
          await release.promise;
          const metadata = { byteLength: bytes.byteLength, mime: "image/png", sha256: "saved" };
          return {
            profile: { id: "gateway-owner", mergedInto: null },
            emails: ["frozen@example.test"],
            avatar:
              outcome === "missing"
                ? undefined
                : { ...metadata, bytes: shouldLoadBytes(metadata) ? materialize() : undefined },
          };
        },
      );
      const res = response();
      const fetchImpl = vi.fn();
      const req = request(
        "/ignored",
        outcome === "unchanged" ? { "if-none-match": '"saved-png"' } : {},
      );
      if (outcome === "head") {
        req.method = "HEAD";
      }
      const handling = handleUserProfileAvatarHttpRequest(
        req,
        res.response,
        "/api/users/gateway-owner/avatar",
        { auth: {} as never, fetchImpl },
      );
      const settled = handling.catch((error: unknown) => error);
      try {
        await reached.promise;
        if (outcome === "revoked") {
          current = false;
        }
        release.resolve();
        if (outcome === "revoked") {
          expect(await settled).toBeInstanceOf(Error);
          expect(res.end).not.toHaveBeenCalledWith(bytes);
        } else {
          expect(await settled).toBe(true);
          if (outcome === "missing") {
            expect(res.response.statusCode).toBe(404);
          } else {
            expect(res.writeHead).toHaveBeenCalledWith(
              outcome === "unchanged" ? 304 : 200,
              expect.any(Object),
            );
            expect(res.end).toHaveBeenCalledWith(outcome === "saved" ? bytes : undefined);
            expect(materialize).toHaveBeenCalledTimes(outcome === "saved" ? 1 : 0);
          }
        }
        expect(createProfileAvatarReader).not.toHaveBeenCalled();
        expect(resolveHostAccountAvatar).not.toHaveBeenCalled();
        expect(resolveVerifiedSystemNativeGitHubAccount).not.toHaveBeenCalled();
        expect(fetchImpl).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await settled;
      }
    },
  );

  it.each([
    { controlUi: { allowedOrigins: ["https://control.example"] } },
    { publicOrigin: "https://control.example" },
  ])("answers credentialed avatar preflights with origin policy %j", async (gateway) => {
    getRuntimeConfig.mockReturnValue({ gateway });
    const res = response();
    const req = {
      method: "OPTIONS",
      url: "/ignored-by-handler",
      headers: { origin: "https://control.example" },
    } as unknown as IncomingMessage;

    await handleUserProfileAvatarHttpRequest(req, res.response, "/api/users/profile-1/avatar", {
      auth: {} as never,
    });

    expect(authorizeControlUiReadRequestOrReply).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith(
      "Access-Control-Allow-Origin",
      "https://control.example",
    );
    expect(res.setHeader).toHaveBeenCalledWith("Access-Control-Allow-Credentials", "true");
    expect(res.setHeader).toHaveBeenCalledWith("Access-Control-Allow-Headers", "Authorization");
    expect(res.writeHead).toHaveBeenCalledWith(204);
  });

  it.each([
    { method: "GET", mime: "image/webp", hash: "first-hash", header: undefined },
    { method: "HEAD", mime: "image/png", hash: "head-hash", header: undefined },
    ...['"current-hash-png"', 'W/"current-hash-png"', '"other", "current-hash-png"', "*"].map(
      (header) => ({ method: "GET", mime: "image/png", hash: "current-hash", header }),
    ),
  ])(
    "serves saved avatars for $method / $header without unnecessary byte reads",
    async ({ method, mime, hash, header }) => {
      const bytes = new Uint8Array([1, 2, 3]);
      avatarFixture.mockReturnValue({ bytes, mime, sha256: hash, updatedAt: 42 });
      const res = response();
      const req = request("/ignored-by-handler", header ? { "if-none-match": header } : {});
      req.method = method;
      await handleUserProfileAvatarHttpRequest(req, res.response, "/api/users/profile%2D1/avatar", {
        auth: {} as never,
      });

      expect(createProfileAvatarReader).toHaveBeenCalledWith("profile-1");
      expect(authorizeControlUiReadRequestOrReply).toHaveBeenCalledWith(
        expect.objectContaining({ requiredOperatorMethod: "users.list" }),
      );
      const etag = `"${hash}-${mime === "image/webp" ? "webp" : "png"}"`;
      if (header) {
        expect(res.writeHead).toHaveBeenCalledWith(304, {
          ETag: etag,
          "Cache-Control": "private, max-age=0, must-revalidate",
        });
        expect(res.end).toHaveBeenCalledWith();
      } else {
        expect(res.writeHead).toHaveBeenCalledWith(
          200,
          expect.objectContaining({ "Content-Type": mime, ETag: etag }),
        );
        expect(res.end).toHaveBeenCalledWith(method === "HEAD" ? undefined : bytes);
      }
      if (method === "HEAD" || header) {
        expect(loadAvatarBytes).not.toHaveBeenCalled();
      }
    },
  );

  it("uses the host photo only for the owner, after auth and saved-avatar precedence", async () => {
    const hostAvatar = { bytes: Buffer.from([4, 5, 6]), mime: "image/jpeg", sha256: "host-photo" };
    resolveHostAccountAvatar.mockResolvedValue(hostAvatar);
    profileFixture.mockImplementation((id: string) => ({
      id,
      mergedInto: null,
      emails: [],
    }));
    const pathname = "/api/users/gateway-owner/avatar";
    const inferred = response();
    await handleUserProfileAvatarHttpRequest(request(pathname), inferred.response, pathname, {
      auth: {} as never,
    });
    expect(inferred.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ "Content-Type": "image/jpeg", ETag: '"host-photo-jpeg"' }),
    );
    expect(inferred.end).toHaveBeenCalledWith(hostAvatar.bytes);
    expect(resolveHostAccountAvatar).toHaveBeenCalledOnce();

    const other = response();
    profileFixture.mockReturnValueOnce({
      id: "gateway-owner",
      mergedInto: null,
      emails: [],
    });
    await handleUserProfileAvatarHttpRequest(
      request(pathname),
      other.response,
      "/api/users/person/avatar",
      {
        auth: {} as never,
      },
    );
    expect(other.response.statusCode).toBe(404);

    avatarFixture.mockReturnValue({
      bytes: Buffer.from([9]),
      mime: "image/png",
      sha256: "saved",
    });
    const saved = response();
    await handleUserProfileAvatarHttpRequest(request(pathname), saved.response, pathname, {
      auth: {} as never,
    });
    expect(saved.end).toHaveBeenCalledWith(Buffer.from([9]));

    authorizeControlUiReadRequestOrReply.mockResolvedValue(null);
    const unauthorized = response();
    await handleUserProfileAvatarHttpRequest(request(pathname), unauthorized.response, pathname, {
      auth: {} as never,
    });
    expect(unauthorized.end).not.toHaveBeenCalled();
    expect(resolveHostAccountAvatar).toHaveBeenCalledOnce();
  });

  it("does not inherit the host photo through a merged owner before Doctor repair", async () => {
    const profiles = await vi.importActual<typeof import("../state/user-profiles.js")>(
      "../state/user-profiles.js",
    );
    const options = { path: join(tempDirs.make("openclaw-owner-avatar-"), "openclaw.sqlite") };
    const owner = profiles.ensureGatewayOwnerProfile("Local Owner", options);
    const person = profiles.ensureProfileForEmail("person@example.test", options);
    openOpenClawStateDatabase(options)
      .db.prepare("UPDATE user_profiles SET merged_into = ? WHERE id = ?")
      .run(person.id, owner.id);
    const catalog = await prepareUserProfileCatalog(options);
    onTestFinished(catalog.release);
    const { createProfileAvatarReader: createReader } = await vi.importActual<
      typeof import("../state/user-profiles-avatar.js")
    >("../state/user-profiles-avatar.js");
    createProfileAvatarReader.mockImplementation((id: string) => createReader(id, options));
    const hostAvatar = { bytes: Buffer.from([4, 5, 6]), mime: "image/jpeg", sha256: "host-photo" };
    resolveHostAccountAvatar.mockResolvedValue(hostAvatar);
    const pathname = "/api/users/gateway-owner/avatar";
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchImpl);
    const before = response();
    await handleUserProfileAvatarHttpRequest(request(pathname), before.response, pathname, {
      auth: {} as never,
    });
    expect(before.response.statusCode).toBe(404);
    expect(resolveHostAccountAvatar).not.toHaveBeenCalled();

    expect(repairMergedGatewayOwnerProfile({ ...options, shouldRepair: true }).repaired).toBe(true);
    const after = response();
    await handleUserProfileAvatarHttpRequest(request(pathname), after.response, pathname, {
      auth: {} as never,
    });
    expect(after.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(after.end).toHaveBeenCalledWith(hostAvatar.bytes);
  });

  it("serves warm GET, HEAD, and conditional avatar bursts without worker reads or main-thread SQL", async () => {
    const profiles = await vi.importActual<typeof import("../state/user-profiles.js")>(
      "../state/user-profiles.js",
    );
    const { setAvatar } = await vi.importActual<
      typeof import("../state/user-profile-writes.worker.js")
    >("../state/user-profile-writes.worker.js");
    const { createProfileAvatarReader: createReader } = await vi.importActual<
      typeof import("../state/user-profiles-avatar.js")
    >("../state/user-profiles-avatar.js");
    const options = { path: join(tempDirs.make("profile-avatar-reader-"), "openclaw.sqlite") };
    const profile = profiles.ensureProfileForEmail("reader@example.test", options);
    const bytes = new Uint8Array(1024).fill(7);
    expect(setAvatar(profile.id, bytes, "image/png", options).ok).toBe(true);
    const catalog = await prepareUserProfileCatalog(options);
    onTestFinished(catalog.release);
    const reader = createReader(profile.id, options);
    const warm = await reader.inspect();
    await warm.loadBytes();
    const etag = profiles.formatUserProfileAvatarEtag(warm.avatar!.sha256, "image/png");
    const materialize = vi.fn();
    createProfileAvatarReader.mockImplementation((id: string) => {
      const selected = createReader(id, options);
      return {
        async inspect() {
          const prepared = await selected.inspect();
          return {
            ...prepared,
            loadBytes() {
              materialize();
              return prepared.loadBytes();
            },
          };
        },
      };
    });
    const sql = observeMainThreadSql();
    const read = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
    try {
      for (const [method, headers, code] of [
        ["HEAD", {}, 200],
        ["GET", { "if-none-match": etag }, 304],
        ["GET", {}, 200],
      ] as const) {
        await Promise.all(
          Array.from({ length: 300 }, async () => {
            const res = response();
            const req = request("/ignored", headers);
            req.method = method;
            await handleUserProfileAvatarHttpRequest(
              req,
              res.response,
              `/api/users/${profile.id}/avatar`,
              { auth: {} as never },
            );
            expect(res.writeHead).toHaveBeenCalledWith(
              code,
              expect.objectContaining({ ETag: etag }),
            );
            if (code === 200) {
              expect(res.writeHead).toHaveBeenCalledWith(
                200,
                expect.objectContaining({ "Content-Length": bytes.byteLength }),
              );
            }
            if (method === "HEAD" || code === 304) {
              expect(materialize).not.toHaveBeenCalled();
            } else {
              expect(res.end).toHaveBeenCalledWith(bytes);
            }
          }),
        );
      }
      expect(materialize).toHaveBeenCalledTimes(300);
      expect(read).not.toHaveBeenCalled();
      sql.expectIdle();
    } finally {
      read.mockRestore();
      sql.restore();
    }
  });

  it.each(["replacement", "merge"] as const)(
    "refreshes metadata after %s before materialization",
    async (change) => {
      const profiles = await vi.importActual<typeof import("../state/user-profiles.js")>(
        "../state/user-profiles.js",
      );
      const { linkEmail, setAvatar } = await vi.importActual<
        typeof import("../state/user-profile-writes.worker.js")
      >("../state/user-profile-writes.worker.js");
      const { createProfileAvatarReader: createReader } = await vi.importActual<
        typeof import("../state/user-profiles-avatar.js")
      >("../state/user-profiles-avatar.js");
      const options = { path: join(tempDirs.make("profile-avatar-change-"), "openclaw.sqlite") };
      const original = profiles.ensureProfileForEmail("original@example.test", options);
      const target = profiles.ensureProfileForEmail("target@example.test", options);
      const next = new Uint8Array([4, 5, 6]);
      setAvatar(original.id, new Uint8Array([1]), "image/png", options);
      setAvatar(target.id, next, "image/webp", options);
      const catalog = await prepareUserProfileCatalog(options);
      onTestFinished(catalog.release);
      const reader = createReader(original.id, options);
      await (await reader.inspect()).loadBytes();
      let changed = false;
      createProfileAvatarReader.mockReturnValue({
        async inspect() {
          const prepared = await reader.inspect();
          return {
            ...prepared,
            async loadBytes() {
              if (!changed) {
                changed = true;
                if (change === "merge") {
                  linkEmail("original@example.test", target.id, options);
                } else {
                  setAvatar(original.id, next, "image/webp", options);
                }
              }
              return prepared.loadBytes();
            },
          };
        },
      });
      const res = response();
      await handleUserProfileAvatarHttpRequest(
        request("/ignored"),
        res.response,
        `/api/users/${original.id}/avatar`,
        { auth: {} as never },
      );
      expect(createProfileAvatarReader).toHaveBeenCalledOnce();
      expect(res.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({
          "Content-Type": "image/webp",
          "Content-Length": next.byteLength,
        }),
      );
      expect(res.end).toHaveBeenCalledWith(next);
    },
  );

  it.each(["missing", "overloaded", "timeout"] as const)(
    "maps avatar lookup failure %s to its HTTP response",
    async (code) => {
      if (code === "missing") {
        profileFixture.mockImplementation(() => {
          throw new UserProfileNotFoundError("gateway-owner");
        });
      } else {
        createProfileAvatarReader.mockReturnValue({
          inspect: () => Promise.reject(new WorkerTaskError("Avatar pressure", code)),
        });
      }
      const res = response();
      const pathname = "/api/users/gateway-owner/avatar";
      await handleUserProfileAvatarHttpRequest(request(pathname), res.response, pathname, {
        auth: {} as never,
      });
      expect(res.response.statusCode).toBe(code === "missing" ? 404 : 503);
      expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
      if (code === "missing") {
        expect(resolveHostAccountAvatar).not.toHaveBeenCalled();
      } else {
        expect(res.setHeader).toHaveBeenCalledWith("Retry-After", "1");
      }
    },
  );

  it.each([
    { method: "POST", pathname: "/api/users/profile-1/avatar", basePath: "", code: 405 },
    {
      method: "GET",
      pathname: "/control/api/users/profile-1/avatar/extra",
      basePath: "/control",
      code: 404,
    },
    {
      method: "GET",
      pathname: "/__openclaw__/workspace-icon/one",
      basePath: "/control",
      code: undefined,
    },
  ])(
    "dispatches $method $pathname before avatar lookup",
    async ({ method, pathname, basePath, code }) => {
      const res = response();
      const req = request(pathname);
      req.method = method;
      const handled = await handleUserProfileAvatarHttpRequest(req, res.response, pathname, {
        auth: {} as never,
        basePath,
      });
      expect(handled).toBe(code !== undefined);
      expect(avatarFixture).not.toHaveBeenCalled();
      expect(profileFixture).not.toHaveBeenCalled();
      if (code === 404) {
        expect(authorizeControlUiReadRequestOrReply).toHaveBeenCalledOnce();
        expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
      } else {
        expect(authorizeControlUiReadRequestOrReply).not.toHaveBeenCalled();
      }
      if (code === undefined) {
        expect(getRuntimeConfig).not.toHaveBeenCalled();
      } else {
        expect(res.response.statusCode).toBe(code);
      }
      if (code === 405) {
        expect(res.setHeader).toHaveBeenCalledWith("Allow", "GET, HEAD");
      }
    },
  );

  it.each([200, 404])("caches a normalized primary-email Gravatar response (%s)", async (code) => {
    const profileId = `profile-gravatar-cache-${code}`;
    const email = code === 200 ? " Ada@Example.com " : "missing-avatar@example.com";
    const hash = emailHash(email);
    const secondaryHash = emailHash("secondary@example.com");
    const bytes = new Uint8Array([4, 5, 6]);
    avatarFixture.mockReturnValue(undefined);
    profileFixture.mockReturnValue({
      id: profileId,
      emails: code === 200 ? [email, "secondary@example.com"] : [email],
      hasAvatar: false,
    });
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) =>
      fetchUrl(input).includes(hash)
        ? new Response(code === 200 ? bytes : null, {
            status: code,
            headers: { "content-type": "image/png" },
          })
        : new Response(new Uint8Array([2, 2, 2]), {
            headers: { "content-type": "image/png" },
          }),
    );
    const first = response();
    const second = response();
    await serveProfile(profileId, first, fetchImpl);
    await serveProfile(profileId, second, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://www.gravatar.com/avatar/${hash}?s=256&d=404`,
      expect.objectContaining({
        headers: { Accept: "image/webp,image/png,image/jpeg,image/gif" },
        signal: expect.any(AbortSignal),
      }),
    );
    if (code === 200) {
      expect(first.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({
          "Content-Type": "image/png",
          "Cache-Control": "private, max-age=0, must-revalidate",
        }),
      );
      expect(first.end).toHaveBeenCalledWith(bytes);
      expect(second.end).toHaveBeenCalledWith(bytes);
      expect(fetchImpl).not.toHaveBeenCalledWith(
        expect.stringContaining(secondaryHash),
        expect.anything(),
      );
    } else {
      expect(first.response.statusCode).toBe(404);
      expect(first.setHeader).toHaveBeenCalledWith(
        "Content-Type",
        "application/json; charset=utf-8",
      );
      // A cached 404 would hide a later upload behind the stable route.
      expect(first.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
      expect(second.response.statusCode).toBe(404);
    }
  });

  it("proxies only the verified Factory account picture through the profile avatar route", async () => {
    const principal = "github:microsoft.ghe.com:1358766";
    const profileId = "profile-factory";
    getRuntimeConfig.mockReturnValue({
      gateway: {
        auth: { mode: "trusted-proxy", trustedProxy: { userHeader: "x-factory-principal" } },
      },
    });
    authorizeControlUiReadRequestOrReply.mockImplementation(({ res }: { res: ServerResponse }) =>
      bindHttpResponseAuthority(
        {
          authMethod: "trusted-proxy",
          authenticatedUserId: principal,
          authenticatedUserProfile: { profileId },
        },
        res,
        () => true,
      ),
    );
    avatarFixture.mockReturnValue(undefined);
    profileFixture.mockReturnValue({
      id: profileId,
      displayName: principal,
      emails: [principal],
      hasAvatar: false,
    });
    resolveVerifiedSystemNativeGitHubAccount.mockResolvedValue({
      accountId: 1358766,
      login: "Galin-Iliev",
      avatarUrl: "https://microsoft.ghe.com/avatars/u/1358766?token=fixture",
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([4, 5, 6]), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    const res = response();
    await handleUserProfileAvatarHttpRequest(
      request("/ignored-by-handler"),
      res.response,
      `/api/users/${profileId}/avatar`,
      { auth: {} as never, fetchImpl },
    );
    expect(resolveVerifiedSystemNativeGitHubAccount).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 1358766, host: "microsoft.ghe.com" }),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://microsoft.ghe.com/avatars/u/1358766?token=fixture",
      expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }),
    );
    expect(res.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=0, must-revalidate",
      }),
    );
    expect(res.end).toHaveBeenCalledWith(new Uint8Array([4, 5, 6]));

    resolveVerifiedSystemNativeGitHubAccount.mockResolvedValue({
      accountId: 1358766,
      login: "Galin-Iliev",
      avatarUrl: "https://evil.example/avatars/u/1358766",
    });
    fetchImpl.mockClear();
    const rejected = response();
    await handleUserProfileAvatarHttpRequest(
      request("/ignored-by-handler"),
      rejected.response,
      `/api/users/${profileId}/avatar`,
      { auth: {} as never, fetchImpl },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(rejected.response.statusCode).toBe(502);
  });

  it("uses the trusted Factory account avatar without a native credential lookup", async () => {
    const principal = "github:microsoft.ghe.com:101";
    const profileId = "profile-factory";
    getRuntimeConfig.mockReturnValue({
      gateway: {
        auth: { mode: "trusted-proxy", trustedProxy: { userHeader: "x-factory-principal" } },
      },
    });
    authorizeControlUiReadRequestOrReply.mockImplementation(({ res }: { res: ServerResponse }) =>
      bindHttpResponseAuthority(
        {
          authMethod: "trusted-proxy",
          authenticatedUserId: principal,
          authenticatedUserProfile: { profileId },
        },
        res,
        () => true,
      ),
    );
    avatarFixture.mockReturnValue(undefined);
    profileFixture.mockReturnValue({
      id: profileId,
      displayName: principal,
      emails: [principal],
      hasAvatar: false,
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([4, 5, 6]), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    const res = response();
    await handleUserProfileAvatarHttpRequest(
      request("/ignored-by-handler", {
        "x-factory-github-login": "first-admin",
        "x-factory-github-avatar-url": "https://microsoft.ghe.com/avatars/u/101",
      }),
      res.response,
      `/api/users/${profileId}/avatar`,
      { auth: {} as never, fetchImpl },
    );
    expect(resolveVerifiedSystemNativeGitHubAccount).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://microsoft.ghe.com/avatars/u/101",
      expect.objectContaining({ redirect: "error" }),
    );
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  });

  it.each([404, 503])(
    "only falls through after a definite Gravatar miss (primary %s)",
    async (primaryStatus) => {
      const fixtureId = `${primaryStatus}-${randomUUID()}`;
      const profileId = `profile-multi-email-${fixtureId}`;
      const primaryEmail = `primary-${fixtureId}@example.test`;
      const primaryHash = emailHash(primaryEmail);
      avatarFixture.mockReturnValue(undefined);
      profileFixture.mockReturnValue({
        id: profileId,
        emails: [primaryEmail, `secondary-${fixtureId}@example.test`],
        hasAvatar: false,
      });
      const fetchImpl = vi.fn(async (input: URL | RequestInfo) =>
        fetchUrl(input).includes(primaryHash)
          ? new Response(null, { status: primaryStatus })
          : new Response(new Uint8Array([2, 2, 2]), {
              status: 200,
              headers: { "content-type": "image/png" },
            }),
      );
      const res = response();

      await serveProfile(profileId, res, fetchImpl);

      expect(fetchImpl).toHaveBeenCalledTimes(primaryStatus === 404 ? 2 : 1);
      if (primaryStatus === 404) {
        expect(res.end).toHaveBeenCalledWith(new Uint8Array([2, 2, 2]));
      } else {
        expect(res.response.statusCode).toBe(502);
        expect(res.end).toHaveBeenCalledWith(
          JSON.stringify({ ok: false, error: { type: "avatar_upstream_unavailable" } }),
        );
      }
    },
  );

  it("caps the Gravatar fan-out so a profile with many linked emails is bounded", async () => {
    const profileId = "profile-many-emails";
    const emails = Array.from({ length: 12 }, (_, index) => `many-${index}@example.com`);
    // Only the last email — beyond the fan-out cap — has a Gravatar.
    const reachableHash = emailHash(emails[emails.length - 1] ?? "");
    avatarFixture.mockReturnValue(undefined);
    profileFixture.mockReturnValue({ id: profileId, emails, hasAvatar: false });
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) =>
      fetchUrl(input).includes(reachableHash)
        ? new Response(new Uint8Array([9, 9, 9]), {
            status: 200,
            headers: { "content-type": "image/png" },
          })
        : new Response(null, { status: 404 }),
    );
    const res = response();

    await serveProfile(profileId, res, fetchImpl);

    // Only the first 8 emails are looked up, so the request never fans out to
    // all 12 and the beyond-cap avatar stays unreachable (404 fallback).
    expect(fetchImpl).toHaveBeenCalledTimes(8);
    expect(res.response.statusCode).toBe(404);
  });

  it.each(["resolve", "reject"])(
    "waits for overflow cancellation to %s before releasing the reader and responding",
    async (outcome) => {
      const profileId = `profile-gravatar-oversized-${outcome}`;
      avatarFixture.mockReturnValue(undefined);
      profileFixture.mockReturnValue({
        id: profileId,
        emails: [`oversized-avatar-${outcome}@example.test`],
        hasAvatar: false,
      });
      const cancellationStarted = createDeferred();
      const cancellation = createDeferred();
      const cancel = vi.fn(() => {
        cancellationStarted.resolve();
        return cancellation.promise;
      });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(600_000));
          controller.enqueue(new Uint8Array(600_000));
        },
        cancel,
      });
      const fetchImpl = vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
      );
      const res = response();
      const handling = serveProfile(profileId, res, fetchImpl);
      try {
        await cancellationStarted.promise;
        // Drain promise work so fire-and-forget cleanup cannot pass by being unobserved.
        await new Promise<void>((resolve) => {
          process.nextTick(resolve);
        });
        expect(res.end).not.toHaveBeenCalled();
        expect(body.locked).toBe(true);
        expect(cancel).toHaveBeenCalledExactlyOnceWith(undefined);

        if (outcome === "resolve") {
          cancellation.resolve();
        } else {
          cancellation.reject(new Error("Gravatar cancellation failed"));
        }
        await expect(handling).resolves.toBe(true);
        expect(res.response.statusCode).toBe(502);
        expect(res.end).toHaveBeenCalledExactlyOnceWith(
          JSON.stringify({ ok: false, error: { type: "avatar_upstream_unavailable" } }),
        );
        expect(body.locked).toBe(false);
        expect(cancel).toHaveBeenCalledExactlyOnceWith(undefined);
      } finally {
        cancellation.resolve();
        await handling;
      }
    },
  );

  it("cancels a Gravatar response rejected by its declared byte size", async () => {
    const profileId = "profile-gravatar-declared-oversized";
    avatarFixture.mockReturnValue(undefined);
    profileFixture.mockReturnValue({
      id: profileId,
      emails: ["declared-oversized-avatar@example.com"],
      hasAvatar: false,
    });
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: {
          "content-length": "1000001",
          "content-type": "image/png",
        },
      }),
    );
    const res = response();

    await serveProfile(profileId, res, fetchImpl);

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(res.response.statusCode).toBe(502);
  });
});
