import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { readHttp, startControlUiFixture } from "./control-ui-fixture.test-support.js";
import { handleControlUiHttpRequest } from "./control-ui.js";
import { markGatewayIngressTransport } from "./ingress-attribution.js";
import { createRemoteControlUiIngressTestContext } from "./remote-control-ui.test-support.js";

const policy =
  "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; script-src 'none'; connect-src 'none'; worker-src 'none'; form-action 'none'";
const worker = "self.postMessage({ type: 'ready' });";

describe.each([
  { basePath: "", remote: false },
  { basePath: "/dashboard", remote: false },
  { basePath: "/dashboard", remote: true },
])("PDF worker policy $basePath remote=$remote", ({ basePath, remote }) => {
  const ingress = remote ? createRemoteControlUiIngressTestContext() : undefined;
  const ancestors = ingress
    ? [ingress.publicOrigin, ...ingress.frameAncestors].join(" ")
    : "'self'";
  const dirs = createTempDirTracker();
  let server: Awaited<ReturnType<typeof startControlUiFixture>>;
  beforeAll(async () => {
    const root = dirs.make("openclaw-pdf-worker-");
    await Promise.all([
      fs.writeFile(path.join(root, "pdf-preview-worker.js"), worker),
      fs.writeFile(path.join(root, "sw.js"), "self.skipWaiting();"),
      fs.writeFile(path.join(root, "index.html"), "<!doctype html><html><body>App</body></html>"),
    ]);
    const listener = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((req, res) => {
          if (ingress) {
            markGatewayIngressTransport(req, { kind: "remote-forwarded", context: ingress });
          }
          void handleControlUiHttpRequest(req, res, {
            basePath,
            root: { kind: "bundled", path: root, publicAssetBuildId: "fixture" },
          })
            .then((handled) => {
              if (!handled) {
                res.statusCode = 404;
                res.end();
              }
            })
            .catch((error: unknown) => {
              res.statusCode = 500;
              res.end(String(error));
            });
        }),
    });
    const close = async () => {
      listener.listener.closeAllConnections();
      try {
        await listener.releaseListener();
      } finally {
        await listener.claim.release();
      }
    };
    server = {
      origin: "http://127.0.0.1:" + listener.claim.port,
      close,
      [Symbol.asyncDispose]: close,
    };
  });
  afterAll(async () => {
    await server.close().finally(() => dirs.cleanup());
  });
  it.each(["", "/__openclaw__"])(
    "scopes GET, HEAD and 304 to the fixed worker at %j",
    async (namespace) => {
      const url = server.origin + basePath + namespace + "/pdf-preview-worker.js?v=fixture";
      for (const method of ["GET", "HEAD"]) {
        for (const conditional of [false, true]) {
          const response = await readHttp(url, {
            method,
            headers: conditional ? { "If-None-Match": "*" } : {},
          });
          expect(response.status).toBe(conditional ? 304 : 200);
          expect(response.headers).toHaveProperty(
            "content-security-policy",
            policy.replace("frame-ancestors 'self'", "frame-ancestors " + ancestors),
          );
          expect(response.headers).toHaveProperty("x-frame-options", "DENY");
          expect(response.headers).toHaveProperty("x-content-type-options", "nosniff");
          expect(response.headers["cache-control"]).toBe(
            remote ? "private, no-store" : "public, max-age=31536000, immutable",
          );
          if (!conditional) {
            expect(response.headers["content-type"]).toBe("application/javascript; charset=utf-8");
          }
          expect(response.text).toBe(method === "GET" && !conditional ? worker : "");
        }
      }
    },
  );
  it("keeps app and service-worker policy unchanged and unknown workers missing", async () => {
    for (const asset of ["index.html", "sw.js"]) {
      const response = await readHttp(server.origin + basePath + "/" + asset);
      expect(response.status).toBe(200);
      expect(response.headers).toHaveProperty(
        "content-security-policy",
        expect.stringContaining(
          "frame-ancestors " + (ingress ? ingress.frameAncestors.join(" ") : "'none'"),
        ),
      );
      expect(response.headers).toHaveProperty(
        "content-security-policy",
        expect.stringContaining("object-src 'none'"),
      );
      if (remote) {
        expect(response.headers).not.toHaveProperty("x-frame-options");
      } else {
        expect(response.headers).toHaveProperty("x-frame-options", "DENY");
      }
    }
    const missing = await readHttp(server.origin + basePath + "/nested/pdf-preview-worker.js");
    expect(missing.status).toBe(404);
    expect(missing.headers).toHaveProperty(
      "content-security-policy",
      expect.stringContaining(
        "frame-ancestors " + (ingress ? ingress.frameAncestors.join(" ") : "'none'"),
      ),
    );
  });
});

it("keeps an absent fixed worker a 404 without a creator policy or SPA document", async () => {
  const dirs = createTempDirTracker();
  const root = dirs.make("openclaw-missing-pdf-worker-");
  const server = await startControlUiFixture({ root: { kind: "bundled", path: root } });
  try {
    for (const pathname of ["/pdf-preview-worker.js", "/__openclaw__/pdf-preview-worker.js"]) {
      const response = await readHttp(server.origin + pathname);
      expect(response.status).toBe(404);
      expect(response.headers).toHaveProperty(
        "content-security-policy",
        expect.stringContaining("frame-ancestors 'none'"),
      );
      expect(response.headers["cache-control"] ?? "").not.toContain("immutable");
    }
  } finally {
    await server.close().finally(() => dirs.cleanup());
  }
});
