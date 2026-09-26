import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { WorkerTaskError } from "../infra/worker-task-pool.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { retainUserProfileCatalog } from "../state/user-profile-list.js";
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
const loadAvatarBytes = vi.hoisted(() => vi.fn());
const profileFixture = vi.hoisted(() => vi.fn());
const resolveHostAccountAvatar = vi.hoisted(() => vi.fn());
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterAll(async () => {
    await closeStateDatabaseForTest();
    cleanup();
  });
});

vi.mock("../infra/host-account-avatar.js", () => ({ resolveHostAccountAvatar }));

vi.mock("./http-auth-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http-auth-utils.js")>()),
  authorizeControlUiReadRequestOrReply,
}));
vi.mock("../config/io.js", () => ({ getRuntimeConfig }));
vi.mock("../state/user-profiles.js", async () => ({
  formatUserProfileAvatarEtag: (sha256: string, mime: string) =>
    `"${sha256}-${mime.slice("image/".length)}"`,
  UserProfileNotFoundError: (await import("../state/user-profiles-schema.js"))
    .UserProfileNotFoundError,
}));

vi.mock("../state/user-profiles-avatar.js", () => ({ createProfileAvatarReader }));

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

describe("profile avatar HTTP endpoint", () => {
  beforeEach(() => {
    authorizeControlUiReadRequestOrReply.mockReset();
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
    authorizeControlUiReadRequestOrReply.mockImplementation(({ res }: { res: ServerResponse }) =>
      bindHttpResponseAuthority({}, res, () => true),
    );
    getRuntimeConfig.mockReturnValue({
      gateway: { controlUi: { allowedOrigins: ["https://control.example"] } },
    });
  });

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

  it("serves avatars with their stored MIME type and representation ETag", async () => {
    avatarFixture.mockReturnValue({
      bytes: new Uint8Array([1, 2, 3]),
      mime: "image/webp",
      sha256: "first-hash",
      updatedAt: 42,
    });
    const res = response();

    await handleUserProfileAvatarHttpRequest(
      request("/ignored-by-handler"),
      res.response,
      "/api/users/profile-1/avatar",
      { auth: {} as never },
    );

    expect(authorizeControlUiReadRequestOrReply).toHaveBeenCalledWith(
      expect.objectContaining({ requiredOperatorMethod: "users.list" }),
    );
    expect(res.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ "Content-Type": "image/webp", ETag: '"first-hash-webp"' }),
    );
    expect(res.end).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
  });

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

  it("rejects mutating methods before avatar authentication", async () => {
    const res = response();
    const req = { method: "POST", headers: {} } as unknown as IncomingMessage;

    await handleUserProfileAvatarHttpRequest(req, res.response, "/api/users/profile-1/avatar", {
      auth: {} as never,
    });

    expect(res.response.statusCode).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith("Allow", "GET, HEAD");
    expect(authorizeControlUiReadRequestOrReply).not.toHaveBeenCalled();
    expect(avatarFixture).not.toHaveBeenCalled();
  });

  it("does not infer a host avatar for a missing owner profile", async () => {
    profileFixture.mockImplementation(() => {
      throw new UserProfileNotFoundError("gateway-owner");
    });
    const res = response();
    const pathname = "/api/users/gateway-owner/avatar";
    await handleUserProfileAvatarHttpRequest(request(pathname), res.response, pathname, {
      auth: {} as never,
    });
    expect(res.response.statusCode).toBe(404);
    expect(resolveHostAccountAvatar).not.toHaveBeenCalled();
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
    const { createProfileAvatarReader: createReader } = await vi.importActual<
      typeof import("../state/user-profiles-avatar.js")
    >("../state/user-profiles-avatar.js");
    createProfileAvatarReader.mockImplementation((id: string) => createReader(id, options));
    const hostAvatar = { bytes: Buffer.from([4, 5, 6]), mime: "image/jpeg", sha256: "host-photo" };
    resolveHostAccountAvatar.mockResolvedValue(hostAvatar);
    const pathname = "/api/users/gateway-owner/avatar";
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    const before = response();
    await handleUserProfileAvatarHttpRequest(request(pathname), before.response, pathname, {
      auth: {} as never,
      fetchImpl,
    });
    expect(before.response.statusCode).toBe(404);
    expect(resolveHostAccountAvatar).not.toHaveBeenCalled();

    expect(repairMergedGatewayOwnerProfile({ ...options, shouldRepair: true }).repaired).toBe(true);
    const after = response();
    await handleUserProfileAvatarHttpRequest(request(pathname), after.response, pathname, {
      auth: {} as never,
      fetchImpl,
    });
    expect(after.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(after.end).toHaveBeenCalledWith(hostAvatar.bytes);
  });

  it("serves warm GET, HEAD, and conditional avatar bursts without worker reads or main-thread SQL", async () => {
    const profiles = await vi.importActual<typeof import("../state/user-profiles.js")>(
      "../state/user-profiles.js",
    );
    const { createProfileAvatarReader: createReader } = await vi.importActual<
      typeof import("../state/user-profiles-avatar.js")
    >("../state/user-profiles-avatar.js");
    const options = { path: join(tempDirs.make("profile-avatar-reader-"), "openclaw.sqlite") };
    const profile = profiles.ensureProfileForEmail("reader@example.test", options);
    const bytes = new Uint8Array(1024).fill(7);
    expect(profiles.setAvatar(profile.id, bytes, "image/png", options).ok).toBe(true);
    const release = retainUserProfileCatalog(options);
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
      release();
    }
  });

  it.each(["replacement", "merge"] as const)(
    "refreshes metadata after %s before materialization",
    async (change) => {
      const profiles = await vi.importActual<typeof import("../state/user-profiles.js")>(
        "../state/user-profiles.js",
      );
      const { createProfileAvatarReader: createReader } = await vi.importActual<
        typeof import("../state/user-profiles-avatar.js")
      >("../state/user-profiles-avatar.js");
      const options = { path: join(tempDirs.make("profile-avatar-change-"), "openclaw.sqlite") };
      const original = profiles.ensureProfileForEmail("original@example.test", options);
      const target = profiles.ensureProfileForEmail("target@example.test", options);
      const next = new Uint8Array([4, 5, 6]);
      profiles.setAvatar(original.id, new Uint8Array([1]), "image/png", options);
      profiles.setAvatar(target.id, next, "image/webp", options);
      const release = retainUserProfileCatalog(options);
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
                  profiles.linkEmail("original@example.test", target.id, options);
                } else {
                  profiles.setAvatar(original.id, next, "image/webp", options);
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
      release();
    },
  );

  it.each(["overloaded", "timeout"] as const)(
    "returns retryable 503 for avatar %s",
    async (code) => {
      createProfileAvatarReader.mockReturnValue({
        inspect: () => Promise.reject(new WorkerTaskError("Avatar pressure", code)),
      });
      const res = response();
      await handleUserProfileAvatarHttpRequest(
        request("/ignored"),
        res.response,
        "/api/users/profile/avatar",
        { auth: {} as never },
      );
      expect(res.response.statusCode).toBe(503);
      expect(res.setHeader).toHaveBeenCalledWith("Retry-After", "1");
      expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    },
  );

  it("authenticates and claims a malformed configured-base avatar route without profile lookup", async () => {
    const res = response();
    const pathname = "/control/api/users/profile-1/avatar/extra";

    const handled = await handleUserProfileAvatarHttpRequest(
      request(pathname),
      res.response,
      pathname,
      { auth: {} as never, basePath: "/control" },
    );

    expect(handled).toBe(true);
    expect(authorizeControlUiReadRequestOrReply).toHaveBeenCalledOnce();
    expect(res.response.statusCode).toBe(404);
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(avatarFixture).not.toHaveBeenCalled();
    expect(profileFixture).not.toHaveBeenCalled();
  });

  it("leaves unrelated paths unhandled", async () => {
    const res = response();

    const handled = await handleUserProfileAvatarHttpRequest(
      request("/__openclaw__/workspace-icon/one"),
      res.response,
      "/__openclaw__/workspace-icon/one",
      { auth: {} as never, basePath: "/control" },
    );

    expect(handled).toBe(false);
    expect(getRuntimeConfig).not.toHaveBeenCalled();
    expect(authorizeControlUiReadRequestOrReply).not.toHaveBeenCalled();
  });

  it("answers a matching ETag without a body", async () => {
    avatarFixture.mockReturnValue({
      bytes: new Uint8Array([1]),
      mime: "image/png",
      sha256: "current-hash",
      updatedAt: 42,
    });
    const res = response();

    await handleUserProfileAvatarHttpRequest(
      request("/ignored-by-handler", { "if-none-match": '"current-hash-png"' }),
      res.response,
      "/api/users/profile-1/avatar",
      { auth: {} as never },
    );

    expect(res.writeHead).toHaveBeenCalledWith(304, {
      ETag: '"current-hash-png"',
      "Cache-Control": "private, max-age=0, must-revalidate",
    });
    expect(res.end).toHaveBeenCalledWith();
    expect(loadAvatarBytes).not.toHaveBeenCalled();
  });

  it("decodes profile IDs from the scoped pathname", async () => {
    avatarFixture.mockReturnValue({
      bytes: new Uint8Array([1]),
      mime: "image/png",
      sha256: "current-hash",
      updatedAt: 42,
    });

    await handleUserProfileAvatarHttpRequest(
      request("/ignored-by-handler"),
      response().response,
      "/api/users/profile%2D1/avatar",
      { auth: {} as never },
    );

    expect(createProfileAvatarReader).toHaveBeenCalledWith("profile-1");
  });

  it("serves HEAD as GET without a body", async () => {
    avatarFixture.mockReturnValue({
      bytes: new Uint8Array([1, 2, 3]),
      mime: "image/png",
      sha256: "head-hash",
      updatedAt: 42,
    });
    const res = response();

    await handleUserProfileAvatarHttpRequest(
      { method: "HEAD", url: "/ignored-by-handler", headers: {} } as unknown as IncomingMessage,
      res.response,
      "/api/users/profile-1/avatar",
      { auth: {} as never },
    );

    expect(res.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ "Content-Type": "image/png", ETag: '"head-hash-png"' }),
    );
    expect(res.end).toHaveBeenCalledWith(undefined);
    expect(loadAvatarBytes).not.toHaveBeenCalled();
  });

  it.each(['W/"current-hash-png"', '"other", "current-hash-png"', "*"])(
    "revalidates If-None-Match form %s",
    async (header) => {
      avatarFixture.mockReturnValue({
        bytes: new Uint8Array([1]),
        mime: "image/png",
        sha256: "current-hash",
        updatedAt: 42,
      });
      const res = response();

      await handleUserProfileAvatarHttpRequest(
        request("/ignored-by-handler", { "if-none-match": header }),
        res.response,
        "/api/users/profile-1/avatar",
        { auth: {} as never },
      );

      expect(res.writeHead).toHaveBeenCalledWith(304, {
        ETag: '"current-hash-png"',
        "Cache-Control": "private, max-age=0, must-revalidate",
      });
    },
  );

  it("proxies and caches Gravatar by a profile's normalized email", async () => {
    const profileId = "profile-gravatar-cache";
    const hash = emailHash(" Ada@Example.com ");
    avatarFixture.mockReturnValue(undefined);
    profileFixture.mockReturnValue({
      id: profileId,
      emails: [" Ada@Example.com "],
      hasAvatar: false,
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([4, 5, 6]), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );

    const first = response();
    const second = response();
    await handleUserProfileAvatarHttpRequest(
      request("/ignored-by-handler"),
      first.response,
      `/api/users/${profileId}/avatar`,
      { auth: {} as never, fetchImpl },
    );
    await handleUserProfileAvatarHttpRequest(
      request("/ignored-by-handler"),
      second.response,
      `/api/users/${profileId}/avatar`,
      { auth: {} as never, fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://www.gravatar.com/avatar/${hash}?s=256&d=404`,
      expect.objectContaining({
        headers: { Accept: "image/webp,image/png,image/jpeg,image/gif" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(first.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=0, must-revalidate",
      }),
    );
    expect(first.end).toHaveBeenCalledWith(new Uint8Array([4, 5, 6]));
    expect(second.end).toHaveBeenCalledWith(new Uint8Array([4, 5, 6]));
  });

  it("negative-caches a Gravatar 404 so the UI can fall back to initials", async () => {
    const profileId = "profile-gravatar-miss";
    avatarFixture.mockReturnValue(undefined);
    profileFixture.mockReturnValue({
      id: profileId,
      emails: ["missing-avatar@example.com"],
      hasAvatar: false,
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));

    const first = response();
    const second = response();
    await handleUserProfileAvatarHttpRequest(
      request("/ignored-by-handler"),
      first.response,
      `/api/users/${profileId}/avatar`,
      { auth: {} as never, fetchImpl },
    );
    await handleUserProfileAvatarHttpRequest(
      request("/ignored-by-handler"),
      second.response,
      `/api/users/${profileId}/avatar`,
      { auth: {} as never, fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first.response.statusCode).toBe(404);
    expect(first.setHeader).toHaveBeenCalledWith("Content-Type", "application/json; charset=utf-8");
    // A cached 404 would hide a later uploaded avatar behind the stable route.
    expect(first.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(second.response.statusCode).toBe(404);
  });

  it("serves the primary email's Gravatar when several linked emails resolve", async () => {
    const profileId = "profile-multi-email-primary";
    const primaryHash = emailHash("primary@example.com");
    avatarFixture.mockReturnValue(undefined);
    profileFixture.mockReturnValue({
      id: profileId,
      emails: ["primary@example.com", "secondary@example.com"],
      hasAvatar: false,
    });
    const secondaryHash = emailHash("secondary@example.com");
    // The primary email has a Gravatar, so its lookup short-circuits — the
    // secondary email's hash must never be disclosed to Gravatar.
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) =>
      fetchUrl(input).includes(primaryHash)
        ? new Response(new Uint8Array([1, 1, 1]), {
            status: 200,
            headers: { "content-type": "image/png" },
          })
        : new Response(new Uint8Array([2, 2, 2]), {
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

    expect(res.end).toHaveBeenCalledWith(new Uint8Array([1, 1, 1]));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalledWith(
      expect.stringContaining(secondaryHash),
      expect.anything(),
    );
  });

  it("falls through to a later linked email when the primary has no Gravatar", async () => {
    const profileId = "profile-multi-email-fallthrough";
    const primaryHash = emailHash("primary-miss@example.com");
    avatarFixture.mockReturnValue(undefined);
    profileFixture.mockReturnValue({
      id: profileId,
      emails: ["primary-miss@example.com", "secondary-hit@example.com"],
      hasAvatar: false,
    });
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) =>
      fetchUrl(input).includes(primaryHash)
        ? new Response(null, { status: 404 })
        : new Response(new Uint8Array([2, 2, 2]), {
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

    // A definite miss on the primary lets the request fall through to the
    // secondary email under the shared deadline; the secondary hit is served.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(res.end).toHaveBeenCalledWith(new Uint8Array([2, 2, 2]));
  });

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

    await handleUserProfileAvatarHttpRequest(
      request("/ignored-by-handler"),
      res.response,
      `/api/users/${profileId}/avatar`,
      { auth: {} as never, fetchImpl },
    );

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
      const cancellationStarted = Promise.withResolvers<void>();
      const cancellation = Promise.withResolvers<void>();
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
      const handling = handleUserProfileAvatarHttpRequest(
        request("/ignored-by-handler"),
        res.response,
        `/api/users/${profileId}/avatar`,
        { auth: {} as never, fetchImpl },
      );
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

    await handleUserProfileAvatarHttpRequest(
      request("/ignored-by-handler"),
      res.response,
      `/api/users/${profileId}/avatar`,
      { auth: {} as never, fetchImpl },
    );

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(res.response.statusCode).toBe(502);
  });

  it("evicts older Gravatar images when the cache reaches its byte budget", async () => {
    avatarFixture.mockReturnValue(undefined);
    const imageBytes = new Uint8Array(1_000_000);
    const fetchImpl = vi.fn(
      async () =>
        new Response(imageBytes.slice(), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );
    const emails = Array.from({ length: 17 }, (_, index) => `cache-${index}@example.com`);
    const profiles = emails.map((email, index) => ({
      id: `profile-cache-${index}`,
      emails: [email],
      hasAvatar: false,
    }));
    profileFixture.mockImplementation((profileId: string) =>
      profiles.find((profile) => profile.id === profileId),
    );

    for (const profile of profiles) {
      await handleUserProfileAvatarHttpRequest(
        request("/ignored-by-handler"),
        response().response,
        `/api/users/${profile.id}/avatar`,
        { auth: {} as never, fetchImpl },
      );
    }
    await handleUserProfileAvatarHttpRequest(
      request("/ignored-by-handler"),
      response().response,
      `/api/users/${profiles[0]?.id}/avatar`,
      { auth: {} as never, fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(18);
  });
});
