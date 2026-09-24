import { once } from "node:events";
import { createServer, request, type ClientRequest, type ServerResponse } from "node:http";
import { setImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { bindHttpResponseAuthority } from "./http-request-authority.js";
import { handleUserProfileAvatarHttpRequest } from "./user-profiles-http.js";

const getUserProfileListItem = vi.hoisted(() => vi.fn());
const authorizeControlUiReadRequestOrReply = vi.hoisted(() => vi.fn());
vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../infra/host-account-avatar.js", () => ({ resolveHostAccountAvatar: async () => null }));
vi.mock("./http-auth-utils.js", () => ({
  authorizeControlUiReadRequestOrReply,
}));
vi.mock("../state/user-profiles.js", () => ({
  getProfileAvatar: () => undefined,
  getUserProfileListItem,
  formatUserProfileAvatarEtag: () => "unused-upload-etag",
  UserProfileNotFoundError: class extends Error {},
}));

describe("Gravatar HTTP waiter lifetimes", () => {
  const imageBytes = new Uint8Array([7, 8, 9]);
  const clients: ClientRequest[] = [];
  const handled = new Map<string, { response: ServerResponse; promise: Promise<boolean> }>();
  const producers: Array<ReturnType<typeof createDeferred<Response>>> = [];
  const fetchImpl = vi.fn<typeof fetch>();
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const promise = handleUserProfileAvatarHttpRequest(req, res, pathname, {
      auth: { mode: "none", allowTailscale: false },
      fetchImpl,
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

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  beforeEach(() => {
    fetchImpl.mockReset();
    getUserProfileListItem.mockReset();
    authorizeControlUiReadRequestOrReply
      .mockReset()
      .mockImplementation(({ res }: { res: ServerResponse }) =>
        bindHttpResponseAuthority({}, res, () => true),
      );
  });

  afterEach(async () => {
    for (const producer of producers) {
      producer.resolve(new Response(imageBytes, { headers: { "content-type": "image/png" } }));
    }
    await Promise.allSettled([...handled.values()].map(({ promise }) => promise));
    for (const client of clients) {
      client.destroy();
    }
    clients.length = 0;
    producers.length = 0;
    handled.clear();
    vi.restoreAllMocks();
  });

  function startRequest(profileId: string) {
    const pathname = `/api/users/${profileId}/avatar`;
    const result = createDeferred<{ statusCode?: number; body?: Buffer; error?: Error }>();
    const client = request(`${origin}${pathname}`, { agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () =>
        result.resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks) }),
      );
      response.once("error", (error) => result.resolve({ error }));
    });
    client.once("error", (error) => result.resolve({ error }));
    clients.push(client);
    client.end();
    return { client, pathname, result: result.promise };
  }

  function deferredFetch() {
    const deferred = createDeferred<Response>();
    producers.push(deferred);
    return {
      resolve: () =>
        deferred.resolve(new Response(imageBytes, { headers: { "content-type": "image/png" } })),
      fetch: (signal: AbortSignal | null | undefined) =>
        new Promise<Response>((resolve, reject) => {
          const abort = () => reject(new Error("upstream request aborted"));
          if (signal?.aborted) {
            abort();
            return;
          }
          signal?.addEventListener("abort", abort, { once: true });
          void deferred.promise.then((response) => {
            signal?.removeEventListener("abort", abort);
            resolve(response);
          }, reject);
        }),
    };
  }

  it("keeps a fresh HTTP waiter alive after the older waiter's deadline", async () => {
    const totalDeadlines: AbortController[] = [];
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
      if (delay !== 6_000) {
        return nativeTimeout(delay);
      }
      const controller = new AbortController();
      totalDeadlines.push(controller);
      return controller.signal;
    });
    getUserProfileListItem.mockImplementation((id: string) => ({
      id,
      emails:
        id === "deadline-older"
          ? ["deadline-primary@example.test", "deadline-shared@example.test"]
          : ["deadline-shared@example.test"],
    }));
    const shared = deferredFetch();
    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 404 }));
    fetchImpl.mockImplementation((_input, init) => shared.fetch(init?.signal));
    const older = startRequest("deadline-older");
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    const fresh = startRequest("deadline-fresh");
    await vi.waitFor(() => expect(totalDeadlines).toHaveLength(2));

    expectDefined(totalDeadlines[0], "older deadline").abort();
    const olderResult = await older.result;
    shared.resolve();
    const freshResult = await fresh.result;

    expect(olderResult.statusCode).toBe(502);
    expect(freshResult).toEqual({ statusCode: 200, body: Buffer.from(imageBytes) });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("settles a disconnected HTTP waiter without cancelling shared work or writing a response", async () => {
    getUserProfileListItem.mockImplementation((id: string) => ({
      id,
      emails: ["disconnect-shared@example.test"],
    }));
    const shared = deferredFetch();
    fetchImpl.mockImplementation((_input, init) => shared.fetch(init?.signal));
    const disconnected = startRequest("disconnect-first");
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    const remaining = startRequest("disconnect-remaining");
    await vi.waitFor(() => expect(handled.has(remaining.pathname)).toBe(true));
    const first = expectDefined(handled.get(disconnected.pathname), "first HTTP waiter");
    const end = vi.spyOn(first.response, "end");
    const writeHead = vi.spyOn(first.response, "writeHead");
    let settled = false;
    void first.promise.then(() => {
      settled = true;
    });
    const closed = once(first.response, "close");
    disconnected.client.destroy();
    await closed;
    await setImmediate();

    expect(settled).toBe(true);
    expect(writeHead).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    shared.resolve();
    expect(await remaining.result).toEqual({ statusCode: 200, body: Buffer.from(imageBytes) });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not start a Gravatar fetch for a client already disconnected during authorization", async () => {
    const authorized = createDeferred<ReturnType<typeof bindHttpResponseAuthority> | null>();
    authorizeControlUiReadRequestOrReply.mockReturnValue(authorized.promise);
    getUserProfileListItem.mockReturnValue({
      id: "disconnected-before-lookup",
      emails: ["disconnected-before-lookup@example.test"],
    });
    fetchImpl.mockResolvedValue(
      new Response(imageBytes, { headers: { "content-type": "image/png" } }),
    );
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
});
