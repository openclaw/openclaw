import { once } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { handleControlUiHttpRequest } from "./control-ui.js";
import type { ControlUiRootState } from "./server-control-ui-root.js";

const assetBody = Buffer.from('console.log("conditional fixture");\n');
const modifiedAt = new Date("2024-01-01T00:00:00.000Z");
const lastModified = modifiedAt.toUTCString();
const laterModifiedSince = new Date("2024-01-02T00:00:00.000Z").toUTCString();
const earlierModifiedSince = new Date("2023-12-31T00:00:00.000Z").toUTCString();
type Headers = Record<string, string | string[]>;
const since = (value: string | string[]): Headers => ({ "If-Modified-Since": value });
const conditionalCases: [string, Headers, number][] = [
  ["HTTP-date rejects ISO timestamp", since("2024-01-02T00:00:00.000Z"), 200],
  ["rejects duplicate dates", since([laterModifiedSince, earlierModifiedSince]), 200],
  ["equal date", since(lastModified), 304],
  ["older date", since(earlierModifiedSince), 200],
  [
    "quoted star supersedes date",
    { ...since(lastModified), "If-None-Match": '"client,*,tag"' },
    200,
  ],
  ["wildcard supersedes date", { ...since(earlierModifiedSince), "If-None-Match": "*" }, 304],
];

function requestAsset(
  url: string,
  method: "GET" | "HEAD",
  headers: Headers = {},
): Promise<{ response: IncomingMessage; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve({ response, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

afterEach(() => vi.restoreAllMocks());

describe.each([
  { kind: "bundled", basePath: "", cacheControl: "public, max-age=31536000, immutable" },
  { kind: "resolved", basePath: "/dashboard", cacheControl: "no-cache" },
] as const)("$kind $basePath conditional HTTP", ({ kind, basePath, cacheControl }) => {
  const tempDirs = createTempDirTracker();
  let server: Server | undefined;
  let assetUrl: string;
  let baseUrl: string;

  beforeAll(async () => {
    const root = tempDirs.make("openclaw-ui-conditional-");
    const write = async (filename: string, body: string | Buffer, date?: Date) => {
      const target = path.join(root, filename);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, body);
      if (date) {
        await fs.utimes(target, date, date);
      }
    };
    await write("assets/app-fixture.js", assetBody, modifiedAt);
    await write("assets/app-fixture.js.gz", gzipSync(assetBody));
    await write("assets/app-fixture.js.br", brotliCompressSync(assetBody));
    await write("assets/cold.js", assetBody);
    for (const publicAsset of ["themes/absolutely.css", "sw.js"]) {
      await write(publicAsset, assetBody, modifiedAt);
    }
    await write(
      "index.html",
      `<html data-openclaw-control-ui-build-id="source-build"><head><script>const fragment = 'href="unfinished';</script><script src="./assets/app-fixture.js"></script><link href="./assets/app.css"><link rel="icon" href="./favicon.svg"><link rel="icon" href="${basePath}/favicon-32.png"></head></html>`,
    );
    const rootState: ControlUiRootState = {
      kind,
      path: root,
      realPath: root,
      ...(kind === "bundled" ? { publicAssetBuildId: "fixture-build" } : {}),
    };
    server = createServer((req, res) => {
      res.setHeader(
        "X-Test-If-Modified-Since-Count",
        String(req.headersDistinct["if-modified-since"]?.length ?? 0),
      );
      void handleControlUiHttpRequest(req, res, {
        basePath,
        config: {},
        root: rootState,
      }).catch((error: unknown) => {
        res.statusCode = 500;
        res.end(error instanceof Error ? error.message : String(error));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP listener for the static asset fixture");
    }
    baseUrl = `http://127.0.0.1:${address.port}${basePath}`;
    assetUrl = `${baseUrl}/assets/app-fixture.js`;
  });

  if (kind === "bundled" && basePath === "") {
    it("serves warm representations and admits cold files without main-thread filesystem work", async () => {
      await requestAsset(assetUrl, "GET");
      const operations = [
        "openSync",
        "readSync",
        "readFileSync",
        "lstatSync",
        "statSync",
        "fstatSync",
        "realpathSync",
      ] as const;
      const spies = operations.map((operation) => vi.spyOn(fsSync, operation));
      for (const encoding of ["br", "gzip"] as const) {
        const response = await requestAsset(assetUrl, "GET", { "Accept-Encoding": encoding });
        expect(response.response.headers["content-encoding"]).toBe(encoding);
        expect((encoding === "br" ? brotliDecompressSync : gunzipSync)(response.body)).toEqual(
          assetBody,
        );
        const head = await requestAsset(assetUrl, "HEAD", { "Accept-Encoding": encoding });
        expect(head.body.byteLength).toBe(0);
        expect(head.response.headers["content-length"]).toBe(String(response.body.byteLength));
        const unchanged = await requestAsset(assetUrl, "GET", {
          "Accept-Encoding": encoding,
          "If-Modified-Since": lastModified,
        });
        expect(unchanged.response.statusCode).toBe(304);
      }
      expect((await requestAsset(`${baseUrl}/assets/cold.js`, "GET")).body).toEqual(assetBody);
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    });
  }

  afterAll(async () => {
    try {
      if (server?.listening) {
        const activeServer = server;
        await promisify(activeServer.close.bind(activeServer))();
      }
    } finally {
      tempDirs.cleanup();
    }
  });

  describe.each(["GET", "HEAD"] as const)("%s", (method) => {
    it.each(["themes/absolutely.css", "sw.js"])(
      "versions public %s only for the active bundled build",
      async (asset) => {
        for (const query of ["", "?v=", "?v=old-build", "?v=fixture-build"]) {
          for (const conditional of [false, true]) {
            const { response, body } = await requestAsset(
              `${baseUrl}/${asset}${query}`,
              method,
              conditional ? { "If-Modified-Since": lastModified } : {},
            );
            const immutable =
              kind === "bundled" && asset !== "sw.js" && query === "?v=fixture-build";
            expect(response.statusCode).toBe(conditional ? 304 : 200);
            expect(response.headers["cache-control"]).toBe(
              immutable ? "public, max-age=31536000, immutable" : "no-cache",
            );
            expect(response.headers["last-modified"]).toBe(lastModified);
            expect(body).toEqual(!conditional && method === "GET" ? assetBody : Buffer.alloc(0));
          }
        }
      },
    );

    it("keeps versioned documents revalidating and missing public files uncached", async () => {
      const document = await requestAsset(`${baseUrl}/index.html?v=fixture-build`, method, {});
      expect(document.response.statusCode).toBe(200);
      expect(document.response.headers["cache-control"]).toBe("no-cache");
      if (method === "GET") {
        const html = document.body.toString();
        expect(html).toContain(`<script>const fragment = 'href="unfinished';</script>`);
        expect(html).toContain(`src="${basePath}/assets/app-fixture.js"`);
        expect(html).toContain(`href="${basePath}/assets/app.css"`);
        expect(html).not.toContain("source-build");
        expect(html.includes('data-openclaw-control-ui-build-id="fixture-build"')).toBe(
          kind === "bundled",
        );
        const version = kind === "bundled" ? "?v=fixture-build" : "";
        for (const icon of ["favicon.svg", "favicon-32.png"]) {
          expect(html).toContain(`href="${basePath}/${icon}${version}"`);
        }
      }
      const missing = await requestAsset(`${baseUrl}/themes/missing.css?v=fixture-build`, method);
      expect(missing.response.statusCode).toBe(404);
      expect(missing.response.headers["cache-control"] ?? "").not.toContain("immutable");
    });

    it.each(conditionalCases)("%s", async (_name, headers, status) => {
      const { response, body } = await requestAsset(assetUrl, method, headers);

      if (Array.isArray(headers["If-Modified-Since"])) {
        expect(response.headers["x-test-if-modified-since-count"]).toBe("2");
      }
      expect(response.statusCode, `TZ=${process.env.TZ ?? "system"}`).toBe(status);
      expect(response.headers).toMatchObject({
        "last-modified": lastModified,
        "cache-control": cacheControl,
        vary: "Accept-Encoding",
      });
      expect(response.headers.etag).toBeUndefined();
      expect(response.headers["content-length"]).toBe(
        status === 304 ? undefined : String(assetBody.length),
      );
      expect(body).toEqual(status === 200 && method === "GET" ? assetBody : Buffer.alloc(0));
    });

    it("rejects unacceptable encodings before evaluating conditional headers", async () => {
      const { response, body } = await requestAsset(assetUrl, method, {
        "If-None-Match": "*",
        "If-Modified-Since": laterModifiedSince,
        "Accept-Encoding": "identity;q=0, *;q=0",
      });

      expect(response.statusCode).toBe(406);
      expect(response.headers).toMatchObject({
        "cache-control": "no-store",
        vary: "Accept-Encoding",
        "content-length": String(Buffer.byteLength("Not Acceptable")),
      });
      expect(response.headers["last-modified"]).toBeUndefined();
      expect(response.headers.etag).toBeUndefined();
      expect(body.toString()).toBe(method === "GET" ? "Not Acceptable" : "");
    });
  });
});
