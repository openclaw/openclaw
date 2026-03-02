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
