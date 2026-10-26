import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { makeStallingStream } from "../infra/http-body.test-support.js";
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
vi.mock("../state/user-profiles-avatar.js", () => ({ createProfileAvatarReader }));

function emailHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

function fetchUrl(input: URL | RequestInfo): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function response() {
  const mocks = { end: vi.fn(), setHeader: vi.fn(), writeHead: vi.fn() };
  return {
    ...mocks,
    response: Object.assign(new EventEmitter(), {
      ...mocks,
      socket: null,
    }) as unknown as ServerResponse,
  };
}

function serveProfile(
  profileId: string,
  res: ReturnType<typeof response>,
  fetchImpl: typeof fetch,
) {
  vi.stubGlobal("fetch", fetchImpl);
  return handle(res, `/api/users/${profileId}/avatar`);
}

function handle(
  res: ReturnType<typeof response>,
  pathname = "/api/users/gateway-owner/avatar",
  {
    url = pathname,
    method = "GET",
    headers = {},
    basePath = "",
  }: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    basePath?: string;
  } = {},
) {
  const req = { url, method, headers, socket: new EventEmitter() } as unknown as IncomingMessage;
  return handleUserProfileAvatarHttpRequest(req, res.response, pathname, {
    auth: {} as never,
    basePath,
  });
}

function expectHeader(res: ReturnType<typeof response>, name: string, value: string) {
  expect(res.setHeader).toHaveBeenCalledWith(name, value);
}

function expectHead(
  res: ReturnType<typeof response>,
  code: number,
  headers: Record<string, unknown>,
) {
  expect(res.writeHead).toHaveBeenCalledWith(code, expect.objectContaining(headers));
}

function setProfile(id: string, emails: string[] = [], extra = {}) {
  profileFixture.mockReturnValue({ id, emails, hasAvatar: false, ...extra });
}

function image(bytes: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>, headers = {}) {
  return new Response(bytes, { status: 200, headers: { "content-type": "image/png", ...headers } });
}

async function realProfiles(prefix: string) {
  const profiles = await vi.importActual<typeof import("../state/user-profiles.js")>(
    "../state/user-profiles.js",
  );
  const writes = await vi.importActual<typeof import("../state/user-profile-writes.worker.js")>(
    "../state/user-profile-writes.worker.js",
  );
  const { createProfileAvatarReader: createReader } = await vi.importActual<
    typeof import("../state/user-profiles-avatar.js")
  >("../state/user-profiles-avatar.js");
  const options = { path: join(tempDirs.make(prefix), "openclaw.sqlite") };
  return { profiles, writes, createReader, options };
}

async function prepareCatalog(options: { path: string }) {
  const catalog = await prepareUserProfileCatalog(options);
  onTestFinished(catalog.release);
}

function instrumentReader(
  reader: ReturnType<typeof import("../state/user-profiles-avatar.js").createProfileAvatarReader>,
  beforeLoad: () => void,
) {
  return {
    async inspect() {
      const prepared = await reader.inspect();
      return {
        ...prepared,
        loadBytes() {
          beforeLoad();
          return prepared.loadBytes();
        },
      };
    },
  };
}

describe("profile avatar HTTP endpoint", () => {
  afterEach(() => vi.unstubAllGlobals());
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
      bindHttpResponseAuthority({ operatorScopes: ["operator.read"] }, res, () => true),
    );
    getRuntimeConfig.mockReturnValue({
      gateway: { controlUi: { allowedOrigins: ["https://control.example"] } },
    });
  });

  it("answers credentialed avatar preflights with the public origin", async () => {
    getRuntimeConfig.mockReturnValue({ gateway: { publicOrigin: "https://control.example" } });
    const res = response();
    await handle(res, "/api/users/profile-1/avatar", {
      method: "OPTIONS",
      headers: { origin: "https://control.example" },
    });
    expect(authorizeControlUiReadRequestOrReply).not.toHaveBeenCalled();
    expectHeader(res, "Access-Control-Allow-Origin", "https://control.example");
    expectHeader(res, "Access-Control-Allow-Credentials", "true");
    expectHeader(res, "Access-Control-Allow-Headers", "Authorization");
    expect(res.writeHead).toHaveBeenCalledWith(204);
  });

  it.each([false, true])(
    "revalidates stale avatar revisions (conditional=%s)",
    async (conditional) => {
      const bytes = Buffer.from([1, 2, 3]);
      avatarFixture.mockReturnValue({ bytes, mime: "image/png", sha256: "saved" });
      const pathname = "/control/api/users/profile-1/avatar";
      const res = response();
      await handle(res, pathname, {
        url: `${pathname}?v=old-png`,
        headers: {
          origin: "https://control.example",
          ...(conditional ? { "if-none-match": '"saved-png"' } : {}),
        },
        basePath: "/control",
      });
      expectHead(res, conditional ? 304 : 200, {
        ETag: '"saved-png"',
        "Cache-Control": "private, max-age=0, must-revalidate",
      });
      expectHeader(res, "Vary", "Origin, Authorization, Cookie");
      expectHeader(res, "Access-Control-Allow-Origin", "https://control.example");
      if (conditional) {
        expect(loadAvatarBytes).not.toHaveBeenCalled();
      } else {
        expect(res.end).toHaveBeenCalledWith(bytes);
      }
    },
  );

  it("uses the host photo only for the owner, after auth and saved-avatar precedence", async () => {
    const hostAvatar = { bytes: Buffer.from([4, 5, 6]), mime: "image/jpeg", sha256: "host-photo" };
    resolveHostAccountAvatar.mockResolvedValue(hostAvatar);
    profileFixture.mockImplementation((id: string) => ({ id, mergedInto: null, emails: [] }));
    const pathname = "/api/users/gateway-owner/avatar";
    const inferred = response();
    await handle(inferred, pathname, { url: `${pathname}?v=host-photo-jpeg` });
    expectHead(inferred, 200, {
      "Content-Type": "image/jpeg",
      ETag: '"host-photo-jpeg"',
      "Cache-Control": "private, max-age=0, must-revalidate",
    });
    expectHeader(inferred, "Vary", "Origin, Authorization, Cookie");
    expect(inferred.end).toHaveBeenCalledWith(hostAvatar.bytes);
    expect(resolveHostAccountAvatar).toHaveBeenCalledOnce();

    const other = response();
    profileFixture.mockReturnValueOnce({ id: "gateway-owner", mergedInto: null, emails: [] });
    await handle(other, "/api/users/person/avatar", { url: pathname });
    expect(other.response.statusCode).toBe(404);

    avatarFixture.mockReturnValue({ bytes: Buffer.from([9]), mime: "image/png", sha256: "saved" });
    const saved = response();
    await handle(saved, pathname);
    expect(saved.end).toHaveBeenCalledWith(Buffer.from([9]));

    authorizeControlUiReadRequestOrReply.mockResolvedValue(null);
    const unauthorized = response();
    await handle(unauthorized, pathname);
    expect(unauthorized.end).not.toHaveBeenCalled();
    expect(resolveHostAccountAvatar).toHaveBeenCalledOnce();
  });

  it("does not inherit the host photo through a merged owner before Doctor repair", async () => {
    const { profiles, options, createReader } = await realProfiles("openclaw-owner-avatar-");
    const owner = profiles.ensureGatewayOwnerProfile("Local Owner", options);
    const person = profiles.ensureProfileForEmail("person@example.test", options);
    openOpenClawStateDatabase(options)
      .db.prepare("UPDATE user_profiles SET merged_into = ? WHERE id = ?")
      .run(person.id, owner.id);
    await prepareCatalog(options);
    createProfileAvatarReader.mockImplementation((id: string) => createReader(id, options));
    const hostAvatar = { bytes: Buffer.from([4, 5, 6]), mime: "image/jpeg", sha256: "host-photo" };
    resolveHostAccountAvatar.mockResolvedValue(hostAvatar);
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchImpl);
    const before = response();
    await handle(before);
    expect(before.response.statusCode).toBe(404);
    expect(resolveHostAccountAvatar).not.toHaveBeenCalled();

    expect(repairMergedGatewayOwnerProfile({ ...options, shouldRepair: true }).repaired).toBe(true);
    const after = response();
    await handle(after);
    expect(after.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(after.end).toHaveBeenCalledWith(hostAvatar.bytes);
  });

  it("serves warm GET, HEAD, and conditional avatar bursts without worker reads or main-thread SQL", async () => {
    const { profiles, writes, options, createReader } =
      await realProfiles("profile-avatar-reader-");
    const profile = profiles.ensureProfileForEmail("reader@example.test", options);
    const bytes = new Uint8Array(1024).fill(7);
    expect(writes.setAvatar(profile.id, bytes, "image/png", options).ok).toBe(true);
    await prepareCatalog(options);
    const reader = createReader(profile.id, options);
    const warm = await reader.inspect();
    await warm.loadBytes();
    const etag = profiles.formatUserProfileAvatarEtag(warm.avatar!.sha256, "image/png");
    const materialize = vi.fn();
    createProfileAvatarReader.mockImplementation((id: string) =>
      instrumentReader(createReader(id, options), materialize),
    );
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
            const pathname = `/control/api/users/${profile.id}/avatar`;
            await handle(res, pathname, {
              url: `${pathname}?v=${etag.slice(1, -1)}`,
              headers: { ...headers, origin: "https://control.example" },
              method,
              basePath: "/control",
            });
            expectHead(res, code, {
              ETag: etag,
              "Cache-Control": "private, max-age=31536000, immutable",
            });
            expectHeader(res, "Vary", "Origin, Authorization, Cookie");
            expectHeader(res, "Access-Control-Allow-Origin", "https://control.example");
            if (code === 200) {
              expectHead(res, 200, { "Content-Length": bytes.byteLength });
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
      const { profiles, writes, options, createReader } =
        await realProfiles("profile-avatar-change-");
      const original = profiles.ensureProfileForEmail("original@example.test", options);
      const target = profiles.ensureProfileForEmail("target@example.test", options);
      const next = new Uint8Array([4, 5, 6]);
      writes.setAvatar(original.id, new Uint8Array([1]), "image/png", options);
      writes.setAvatar(target.id, next, "image/webp", options);
      await prepareCatalog(options);
      const reader = createReader(original.id, options);
      await (await reader.inspect()).loadBytes();
      let changed = false;
      createProfileAvatarReader.mockReturnValue(
        instrumentReader(reader, () => {
          if (!changed) {
            changed = true;
            if (change === "merge") {
              writes.linkEmail("original@example.test", target.id, options);
            } else {
              writes.setAvatar(original.id, next, "image/webp", options);
            }
          }
        }),
      );
      const res = response();
      await handle(res, `/api/users/${original.id}/avatar`, { url: "/ignored" });
      expect(createProfileAvatarReader).toHaveBeenCalledOnce();
      expectHead(res, 200, { "Content-Type": "image/webp", "Content-Length": next.byteLength });
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
      await handle(res);
      expect(res.response.statusCode).toBe(code === "missing" ? 404 : 503);
      expectHeader(res, "Cache-Control", "no-store");
      if (code === "missing") {
        expect(resolveHostAccountAvatar).not.toHaveBeenCalled();
      } else {
        expectHeader(res, "Retry-After", "1");
      }
    },
  );

  it.each([
    ["POST", "/api/users/profile-1/avatar", "", 405],
    ["GET", "/control/api/users/profile-1/avatar/extra", "/control", 404],
    ["GET", "/__openclaw__/workspace-icon/one", "/control", undefined],
  ] as const)("dispatches %s %s before avatar lookup", async (method, pathname, basePath, code) => {
    const res = response();
    const handled = await handle(res, pathname, { method, basePath });
    expect(handled).toBe(code !== undefined);
    expect(avatarFixture).not.toHaveBeenCalled();
    expect(profileFixture).not.toHaveBeenCalled();
    if (code === 404) {
      expect(authorizeControlUiReadRequestOrReply).toHaveBeenCalledOnce();
      expectHeader(res, "Cache-Control", "no-store");
    } else {
      expect(authorizeControlUiReadRequestOrReply).not.toHaveBeenCalled();
    }
    if (code === undefined) {
      expect(getRuntimeConfig).not.toHaveBeenCalled();
    } else {
      expect(res.response.statusCode).toBe(code);
    }
    if (code === 405) {
      expectHeader(res, "Allow", "GET, HEAD");
    }
  });

  it.each([undefined, "42", "41"])(
    "caches only a current revision's definite miss (%s)",
    async (revision) => {
      const profileId = "profile-negative-cache";
      setProfile(profileId, [], { updatedAt: 42 });
      const pathname = `/api/users/${profileId}/avatar`;
      const missing = response();
      await handle(missing, pathname, {
        url: revision === undefined ? pathname : `${pathname}?v=${revision}`,
      });
      expect(missing.response.statusCode).toBe(404);
      expectHeader(missing, "Cache-Control", "no-store");
      expectHeader(
        missing,
        "Cache-Control",
        revision === "42" ? "private, max-age=60" : "no-store",
      );
      if (revision === "42") {
        expectHeader(missing, "Vary", "Origin, Authorization, Cookie");
      }
    },
  );

  it.each([200, 404])("caches a normalized primary-email Gravatar response (%s)", async (code) => {
    const profileId = `profile-gravatar-cache-${code}`;
    const email = code === 200 ? " Ada@Example.com " : "missing-avatar@example.com";
    const hash = emailHash(email);
    const secondaryHash = emailHash("secondary@example.com");
    const bytes = new Uint8Array([4, 5, 6]);
    setProfile(profileId, code === 200 ? [email, "secondary@example.com"] : [email]);
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) =>
      fetchUrl(input).includes(hash)
        ? new Response(code === 200 ? bytes : null, {
            status: code,
            headers: { "content-type": "image/png" },
          })
        : image(new Uint8Array([2, 2, 2])),
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
      expectHead(first, 200, {
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=0, must-revalidate",
      });
      expect(first.end).toHaveBeenCalledWith(bytes);
      expect(second.end).toHaveBeenCalledWith(bytes);
      expect(fetchImpl).not.toHaveBeenCalledWith(
        expect.stringContaining(secondaryHash),
        expect.anything(),
      );
    } else {
      expect(first.response.statusCode).toBe(404);
      expectHeader(first, "Content-Type", "application/json; charset=utf-8");
      // A cached 404 would hide a later upload behind the stable route.
      expectHeader(first, "Cache-Control", "no-store");
      expect(second.response.statusCode).toBe(404);
    }
  });

  it.each([404, 503])(
    "only falls through after a definite Gravatar miss (primary %s)",
    async (primaryStatus) => {
      const fixtureId = `${primaryStatus}-${randomUUID()}`;
      const profileId = `profile-multi-email-${fixtureId}`;
      const primaryEmail = `primary-${fixtureId}@example.test`;
      const primaryHash = emailHash(primaryEmail);
      setProfile(profileId, [primaryEmail, `secondary-${fixtureId}@example.test`]);
      const fetchImpl = vi.fn(async (input: URL | RequestInfo) =>
        fetchUrl(input).includes(primaryHash)
          ? new Response(null, { status: primaryStatus })
          : image(new Uint8Array([2, 2, 2])),
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
    setProfile(profileId, emails);
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) =>
      fetchUrl(input).includes(reachableHash)
        ? image(new Uint8Array([9, 9, 9]))
        : new Response(null, { status: 404 }),
    );
    const res = response();

    await serveProfile(profileId, res, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(8);
    expect(res.response.statusCode).toBe(404);
  });

  it.each(["resolve", "reject"])(
    "rejects overflow without waiting for best-effort cancellation to %s",
    async (outcome) => {
      const profileId = `profile-gravatar-oversized-${outcome}`;
      setProfile(profileId, [`oversized-avatar-${outcome}@example.test`]);
      const cancellationStarted = createDeferred();
      const cancellation = createDeferred();
      const cancel = vi.fn(() => {
        cancellationStarted.resolve();
        return cancellation.promise;
      });
      const body = makeStallingStream([new Uint8Array(600_000), new Uint8Array(600_000)], cancel);
      const fetchImpl = vi.fn().mockResolvedValue(image(body));
      const res = response();
      const handling = serveProfile(profileId, res, fetchImpl);
      try {
        await cancellationStarted.promise;
        await expect(handling).resolves.toBe(true);
        expect(res.response.statusCode).toBe(502);
        expect(res.end).toHaveBeenCalledExactlyOnceWith(
          JSON.stringify({ ok: false, error: { type: "avatar_upstream_unavailable" } }),
        );
        expect(body.locked).toBe(false);
        expect(cancel).toHaveBeenCalledExactlyOnceWith(undefined);

        if (outcome === "resolve") {
          cancellation.resolve();
        } else {
          cancellation.reject(new Error("Gravatar cancellation failed"));
        }
        await cancellation.promise.catch(() => undefined);
        expect(cancel).toHaveBeenCalledExactlyOnceWith(undefined);
      } finally {
        cancellation.resolve();
        await handling;
      }
    },
  );

  it("cancels a Gravatar response rejected by its declared byte size", async () => {
    const profileId = "profile-gravatar-declared-oversized";
    setProfile(profileId, ["declared-oversized-avatar@example.com"]);
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetchImpl = vi.fn().mockResolvedValue(image(body, { "content-length": "1000001" }));
    const res = response();

    await serveProfile(profileId, res, fetchImpl);

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(res.response.statusCode).toBe(502);
  });
});
