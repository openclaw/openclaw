import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinnedLookup } from "../infra/net/ssrf.js";
import { captureEnv } from "../test-utils/env.js";
import { saveMediaSource, setMediaStoreNetworkDepsForTest } from "./store.js";

const HOME = path.join(os.tmpdir(), "openclaw-home-redirect");
const mockRequest = vi.fn();

function createMockHttpExchange() {
  const res = Object.assign(new PassThrough(), {
    statusCode: 0,
    headers: {} as Record<string, string>,
  });
  const req = {
    on: (event: string, handler: (...args: unknown[]) => void) => {
      if (event === "error") {
        res.on("error", handler);
      }
      return req;
    },
    end: () => undefined,
    destroy: () => res.destroy(),
  } as const;
  return { req, res };
}

describe("media store redirects", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeAll(async () => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    await fs.rm(HOME, { recursive: true, force: true });
    process.env.OPENCLAW_STATE_DIR = HOME;
  });

  beforeEach(() => {
    mockRequest.mockClear();
    setMediaStoreNetworkDepsForTest({
      httpRequest: (...args) => mockRequest(...args),
      httpsRequest: (...args) => mockRequest(...args),
      resolvePinnedHostname: async (hostname) => ({
        hostname,
        addresses: ["93.184.216.34"],
        lookup: createPinnedLookup({ hostname, addresses: ["93.184.216.34"] }),
      }),
    });
  });

  afterAll(async () => {
    await fs.rm(HOME, { recursive: true, force: true });
    envSnapshot.restore();
    setMediaStoreNetworkDepsForTest();
    vi.clearAllMocks();
  });

  it("follows redirects and keeps detected mime/extension", async () => {
    let call = 0;
    mockRequest.mockImplementation((_url, _opts, cb) => {
      call += 1;
      const { req, res } = createMockHttpExchange();

      if (call === 1) {
        res.statusCode = 302;
        res.headers = { location: "https://example.com/final" };
        setImmediate(() => {
          cb(res as unknown);
          res.end();
        });
      } else {
        res.statusCode = 200;
        res.headers = { "content-type": "text/plain" };
        setImmediate(() => {
          cb(res as unknown);
          res.write("redirected");
          res.end();
        });
      }

      return req;
    });

    const saved = await saveMediaSource("https://example.com/start");

    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(saved.contentType).toBe("text/plain");
    expect(path.extname(saved.path)).toBe(".txt");
    expect(await fs.readFile(saved.path, "utf8")).toBe("redirected");
    const stat = await fs.stat(saved.path);
    const expectedMode = process.platform === "win32" ? 0o666 : 0o644;
    expect(stat.mode & 0o777).toBe(expectedMode);
  });

  it("strips all sensitive headers on cross-origin redirect", async () => {
    const requestCalls: Array<{ url: URL; headers?: Record<string, string> }> = [];
    mockRequest.mockImplementation((url, opts, cb) => {
      const parsed = typeof url === "string" ? new URL(url) : (url as URL);
      requestCalls.push({
        url: parsed,
        headers: opts?.headers as Record<string, string> | undefined,
      });

      const { req, res } = createMockHttpExchange();
      if (requestCalls.length === 1) {
        res.statusCode = 302;
        res.headers = { location: "https://other.example.com/final" };
        setImmediate(() => {
          cb(res as unknown);
          res.end();
        });
      } else {
        res.statusCode = 200;
        res.headers = { "content-type": "text/plain" };
        setImmediate(() => {
          cb(res as unknown);
          res.write("ok");
          res.end();
        });
      }
      return req;
    });

    await saveMediaSource("https://example.com/start", {
      Authorization: "Bearer secret",
      "Proxy-Authorization": "Basic cHJveHk=",
      Cookie: "session=abc",
      Cookie2: "legacy=1",
      "X-Custom": "keep",
    });

    expect(requestCalls).toHaveLength(2);

    const first = requestCalls[0]!.headers!;
    expect(first["Authorization"]).toBe("Bearer secret");
    expect(first["Proxy-Authorization"]).toBe("Basic cHJveHk=");
    expect(first["Cookie"]).toBe("session=abc");
    expect(first["Cookie2"]).toBe("legacy=1");
    expect(first["X-Custom"]).toBe("keep");

    const second = requestCalls[1]!.headers!;
    expect(second["Authorization"]).toBeUndefined();
    expect(second["Proxy-Authorization"]).toBeUndefined();
    expect(second["Cookie"]).toBeUndefined();
    expect(second["Cookie2"]).toBeUndefined();
    expect(second["X-Custom"]).toBe("keep");
  });

  it("keeps all headers when redirect stays on same origin", async () => {
    const requestCalls: Array<{ url: URL; headers?: Record<string, string> }> = [];
    mockRequest.mockImplementation((url, opts, cb) => {
      const parsed = typeof url === "string" ? new URL(url) : (url as URL);
      requestCalls.push({
        url: parsed,
        headers: opts?.headers as Record<string, string> | undefined,
      });

      const { req, res } = createMockHttpExchange();
      if (requestCalls.length === 1) {
        res.statusCode = 302;
        res.headers = { location: "https://example.com/final" };
        setImmediate(() => {
          cb(res as unknown);
          res.end();
        });
      } else {
        res.statusCode = 200;
        res.headers = { "content-type": "text/plain" };
        setImmediate(() => {
          cb(res as unknown);
          res.write("ok");
          res.end();
        });
      }
      return req;
    });

    await saveMediaSource("https://example.com/start", {
      Authorization: "Bearer token",
      Cookie: "session=keep",
    });

    expect(requestCalls).toHaveLength(2);
    expect(requestCalls[0]!.headers?.["Authorization"]).toBe("Bearer token");
    expect(requestCalls[0]!.headers?.["Cookie"]).toBe("session=keep");
    expect(requestCalls[1]!.headers?.["Authorization"]).toBe("Bearer token");
    expect(requestCalls[1]!.headers?.["Cookie"]).toBe("session=keep");
  });

  it("keeps headers stripped through a multi-hop chain", async () => {
    const requestCalls: Array<{ url: URL; headers?: Record<string, string> }> = [];
    mockRequest.mockImplementation((url, opts, cb) => {
      const parsed = typeof url === "string" ? new URL(url) : (url as URL);
      requestCalls.push({
        url: parsed,
        headers: opts?.headers as Record<string, string> | undefined,
      });

      const { req, res } = createMockHttpExchange();
      const hop = requestCalls.length;
      if (hop === 1) {
        // Hop 1: same-origin redirect (headers preserved)
        res.statusCode = 302;
        res.headers = { location: "https://example.com/mid" };
      } else if (hop === 2) {
        // Hop 2: cross-origin redirect (headers stripped)
        res.statusCode = 302;
        res.headers = { location: "https://cdn.other.com/final" };
      } else {
        // Hop 3: final response
        res.statusCode = 200;
        res.headers = { "content-type": "text/plain" };
      }
      setImmediate(() => {
        cb(res as unknown);
        if (hop >= 3) res.write("done");
        res.end();
      });
      return req;
    });

    await saveMediaSource("https://example.com/start", {
      Authorization: "Bearer secret",
    });

    expect(requestCalls).toHaveLength(3);
    // Hop 1: same origin → headers preserved
    expect(requestCalls[0]!.headers?.["Authorization"]).toBe("Bearer secret");
    // Hop 2: still same origin from hop 1 → headers still present
    expect(requestCalls[1]!.headers?.["Authorization"]).toBe("Bearer secret");
    // Hop 3: was cross-origin from hop 2 → stripped
    expect(requestCalls[2]!.headers?.["Authorization"]).toBeUndefined();
  });

  it("fails when redirect response omits location header", async () => {
    mockRequest.mockImplementationOnce((_url, _opts, cb) => {
      const { req, res } = createMockHttpExchange();
      res.statusCode = 302;
      res.headers = {};
      setImmediate(() => {
        cb(res as unknown);
        res.end();
      });
      return req;
    });

    await expect(saveMediaSource("https://example.com/start")).rejects.toThrow(
      "Redirect loop or missing Location header",
    );
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });
});
