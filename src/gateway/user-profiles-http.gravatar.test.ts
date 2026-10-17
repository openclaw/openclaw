import { once } from "node:events";
import { createServer, request, type ClientRequest, type ServerResponse } from "node:http";
import { buffer } from "node:stream/consumers";
import { setImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { bindHttpResponseAuthority } from "./http-request-authority.js";
import { handleUserProfileAvatarHttpRequest } from "./user-profiles-http.js";

const profileFixture = vi.hoisted(() => vi.fn());
const authorizeControlUiReadRequestOrReply = vi.hoisted(() => vi.fn());
vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../infra/host-account-avatar.js", () => ({ resolveHostAccountAvatar: async () => null }));
vi.mock("./http-auth-utils.js", () => ({
  authorizeControlUiReadRequestOrReply,
}));
vi.mock("../state/user-profiles.js", () => ({
  formatUserProfileAvatarEtag: () => "unused-upload-etag",
  UserProfileNotFoundError: class extends Error {},
}));

vi.mock("../state/user-profiles-avatar.js", () => ({
  createProfileAvatarReader: (id: string) => ({
    async inspect() {
      const profile = profileFixture(id);
      return { profile, emails: profile.emails, isCurrent: () => true };
    },
  }),
}));

const imageBytes = new Uint8Array([7, 8, 9]);
const imageResponse = () => new Response(imageBytes, { headers: { "content-type": "image/png" } });
const clients: ClientRequest[] = [];
const handled = new Map<string, { response: ServerResponse; promise: Promise<boolean> }>();
const producers: Array<ReturnType<typeof createDeferred<Response>>> = [];
const fetchImpl = vi.fn<typeof fetch>();
const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  const promise = handleUserProfileAvatarHttpRequest(req, res, pathname, {
    auth: { mode: "none", allowTailscale: false },
  });
  handled.set(pathname, { response: res, promise });
  void promise.catch((error: unknown) => {
    res.destroy(error instanceof Error ? error : new Error(String(error)));
  });
});
let origin: string;

beforeAll(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected loopback HTTP listener");
  }
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(() => server[Symbol.asyncDispose]());

beforeEach(() => {
  fetchImpl.mockReset();
  vi.stubGlobal("fetch", fetchImpl);
  profileFixture
    .mockReset()
    .mockImplementation((id: string) => ({ id, emails: [`${id}@example.test`] }));
  authorizeControlUiReadRequestOrReply
    .mockReset()
    .mockImplementation(({ res }: { res: ServerResponse }) =>
      bindHttpResponseAuthority({}, res, () => true),
    );
});

afterEach(async () => {
  for (const producer of producers) {
    producer.resolve(imageResponse());
  }
  await Promise.allSettled([...handled.values()].map(({ promise }) => promise));
  for (const client of clients) {
    client.destroy();
  }
  clients.length = 0;
  producers.length = 0;
  handled.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function startRequest(profileId: string) {
  const pathname = `/api/users/${profileId}/avatar`;
  const result = createDeferred<{ statusCode?: number; body?: Buffer; error?: Error }>();
  const client = request(`${origin}${pathname}`, { agent: false }, (response) => {
    void buffer(response).then(
      (body) => result.resolve({ statusCode: response.statusCode, body }),
      (error: Error) => result.resolve({ error }),
    );
  });
  client.once("error", (error) => result.resolve({ error }));
  clients.push(client);
  client.end();
  return { client, pathname, result: result.promise };
}

it.each(["deadline", "disconnect"] as const)(
  "keeps a fresh HTTP waiter alive after the older waiter's %s",
  async (cause) => {
    const totalDeadlines: AbortController[] = [];
    if (cause === "deadline") {
      const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
      vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
        if (delay !== 6_000) {
          return nativeTimeout(delay);
        }
        const controller = new AbortController();
        totalDeadlines.push(controller);
        return controller.signal;
      });
    }
    profileFixture.mockImplementation((id: string) => ({
      id,
      emails:
        id === "deadline-older"
          ? ["deadline-primary@example.test", "deadline-shared@example.test"]
          : [`${cause}-shared@example.test`],
    }));
    const shared = createDeferred<Response>();
    producers.push(shared);
    if (cause === "deadline") {
      fetchImpl.mockResolvedValueOnce(new Response(null, { status: 404 }));
    }
    fetchImpl.mockImplementation((_input, init) =>
      racePromiseWithAbortSignal(shared.promise, init?.signal ?? undefined),
    );
    const expectedFetches = cause === "deadline" ? 2 : 1;
    const older = startRequest(`${cause}-older`);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(expectedFetches));
    const fresh = startRequest(`${cause}-fresh`);
    if (cause === "deadline") {
      await vi.waitFor(() => expect(totalDeadlines).toHaveLength(2));
      expectDefined(totalDeadlines[0], "older deadline").abort();
      expect((await older.result).statusCode).toBe(502);
    } else {
      await vi.waitFor(() => expect(handled.has(fresh.pathname)).toBe(true));
      const first = expectDefined(handled.get(older.pathname), "first HTTP waiter");
      const end = vi.spyOn(first.response, "end");
      const writeHead = vi.spyOn(first.response, "writeHead");
      let settled = false;
      void first.promise.then(() => {
        settled = true;
      });
      const closed = once(first.response, "close");
      older.client.destroy();
      await closed;
      await setImmediate();
      expect(settled).toBe(true);
      expect(writeHead).not.toHaveBeenCalled();
      expect(end).not.toHaveBeenCalled();
    }
    shared.resolve(imageResponse());
    expect(await fresh.result).toEqual({ statusCode: 200, body: Buffer.from(imageBytes) });
    expect(fetchImpl).toHaveBeenCalledTimes(expectedFetches);
  },
);

it("does not start a Gravatar fetch for a client already disconnected during authorization", async () => {
  const authorized = createDeferred<ReturnType<typeof bindHttpResponseAuthority> | null>();
  authorizeControlUiReadRequestOrReply.mockReturnValue(authorized.promise);
  fetchImpl.mockResolvedValue(imageResponse());
  const disconnected = startRequest("disconnected-before-lookup");
  try {
    await vi.waitFor(() => expect(handled.has(disconnected.pathname)).toBe(true));
    const first = expectDefined(handled.get(disconnected.pathname), "held authorization");
    const writeHead = vi.spyOn(first.response, "writeHead");
    const end = vi.spyOn(first.response, "end");
    const closed = once(first.response, "close");
    disconnected.client.destroy();
    await closed;
    authorized.resolve(bindHttpResponseAuthority({}, first.response, () => true));
    await expect(first.promise).rejects.toThrow("HTTP request authority expired");

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(writeHead).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  } finally {
    authorized.resolve(null);
  }
});
