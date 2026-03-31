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

function mockRedirectExchange(params: { location?: string }) {
  const { req, res } = createMockHttpExchange();
  res.statusCode = 302;
  res.headers = params.location ? { location: params.location } : {};
  return {
    req,
    send(cb: (value: unknown) => void) {
      setImmediate(() => {
        cb(res as unknown);
        res.end();
      });
    },
  };
}

function mockSuccessfulTextExchange(params: { text: string; contentType: string }) {
  const { req, res } = createMockHttpExchange();
  res.statusCode = 200;
  res.headers = { "content-type": params.contentType };
  return {
    req,
    send(cb: (value: unknown) => void) {
      setImmediate(() => {
        cb(res as unknown);
        res.write(params.text);
        res.end();
      });
    },
  };
}

async function expectRedirectSaveResult(params: {
  expectedText: string;
  expectedContentType: string;
  expectedExtension: string;
}) {
  const saved = await saveMediaSource("https://example.com/start");
  expect(mockRequest).toHaveBeenCalledTimes(2);
  expect(saved.contentType).toBe(params.expectedContentType);
  expect(path.extname(saved.path)).toBe(params.expectedExtension);
  expect(await fs.readFile(saved.path, "utf8")).toBe(params.expectedText);
  const stat = await fs.stat(saved.path);
  const expectedMode = process.platform === "win32" ? 0o666 : 0o644 & ~process.umask();
  expect(stat.mode & 0o777).toBe(expectedMode);
}

async function expectRedirectSaveFailure(expectedMessage: string) {
  await expect(saveMediaSource("https://example.com/start")).rejects.toThrow(expectedMessage);
  expect(mockRequest).toHaveBeenCalledTimes(1);
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
      if (call === 1) {
        const exchange = mockRedirectExchange({ location: "https://example.com/final" });
        exchange.send(cb);
        return exchange.req;
      }

      const exchange = mockSuccessfulTextExchange({
        text: "redirected",
        contentType: "text/plain",
      });
      exchange.send(cb);
      return exchange.req;
    });

    await expectRedirectSaveResult({
      expectedText: "redirected",
      expectedContentType: "text/plain",
      expectedExtension: ".txt",
    });
  });

  it("fails when redirect response omits location header", async () => {
    mockRequest.mockImplementationOnce((_url, _opts, cb) => {
      const exchange = mockRedirectExchange({});
      exchange.send(cb);
      return exchange.req;
    });
    await expectRedirectSaveFailure("Redirect loop or missing Location header");
  });
});
