import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { AUTH_NONE, sendRequest, withGatewayServer } from "./server-http.test-harness.js";

it.each([
  { basePath: "", pathname: "/new", accept: "text/html" },
  { basePath: "/console", pathname: "/console/new", accept: "text/html" },
  { basePath: "/console", pathname: "/console", accept: "text/html" },
  {
    basePath: "/console",
    pathname: "/console/__openclaw__/session-entry?path=%2Fconsole%2Fchat%2Fmain%2F~key%2Fproof",
    accept: "*/*",
  },
])(
  "serves a fresh maintenance document before request runtime is ready at $pathname",
  async ({ basePath, pathname, accept }) => {
    const runtime = createDeferred();
    await withGatewayServer({
      prefix: "control-ui-maintenance",
      resolvedAuth: AUTH_NONE,
      overrides: {
        controlUiEnabled: true,
        controlUiBasePath: basePath,
        getStartup: () => ({
          ok: false,
          status: "starting",
          uptimeMs: 1,
          pendingReason: "startup-sidecars",
        }),
        waitForRequestRuntime: () => runtime.promise,
      },
      run: async (server) => {
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Missing HTTP fixture port");
        }
        const url = "http://127.0.0.1:" + address.port + pathname;
        try {
          const response = await fetch(url, {
            headers: { Accept: accept },
            signal: AbortSignal.timeout(2_000),
          });
          expect(response.status).toBe(503);
          expect(response.headers.get("content-type")).toContain("text/html");
          expect(response.headers.get("cache-control")).toContain("no-store");
          expect(response.headers.get("retry-after")).toBe("1");
          const document = await response.text();
          expect(document).toContain("OpenClaw is starting");
          expect(document).not.toContain("<button");
          expect(document).not.toContain('src="/assets/');
          const head = await fetch(url, {
            method: "HEAD",
            headers: { Accept: accept },
            signal: AbortSignal.timeout(2_000),
          });
          expect(head.status).toBe(503);
          expect(await head.text()).toBe("");
        } finally {
          runtime.resolve();
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        }
      },
    });
  },
);

it.each(["", "/console"])(
  "serves the normal app and static assets before runtime readiness at %s",
  async (basePath) => {
    await withTempDir("control-ui-cold-app-", async (root) => {
      await fs.mkdir(path.join(root, "assets"));
      await fs.writeFile(
        path.join(root, "index.html"),
        "<!doctype html><html><body><openclaw-app></openclaw-app></body></html>",
      );
      await fs.writeFile(path.join(root, "assets", "app.js"), "// app bytes");
      const runtime = createDeferred();
      await withGatewayServer({
        prefix: "control-ui-cold-app",
        resolvedAuth: AUTH_NONE,
        overrides: {
          controlUiEnabled: true,
          controlUiBasePath: basePath,
          controlUiRoot: { kind: "resolved", path: root },
          getStartup: () => ({
            ok: false,
            status: "starting",
            uptimeMs: 1,
            pendingReason: "startup-sidecars",
          }),
          isRequestRuntimeReady: () => false,
          waitForRequestRuntime: () => runtime.promise,
        },
        run: async (server) => {
          server.listen(0, "127.0.0.1");
          await once(server, "listening");
          const address = server.address();
          if (!address || typeof address === "string") {
            throw new Error("Missing fixture listener");
          }
          const origin = "http://127.0.0.1:" + address.port;
          try {
            const document = await fetch(origin + basePath + "/new", {
              headers: { accept: "text/html" },
              signal: AbortSignal.timeout(3000),
            });
            expect(document.status).toBe(200);
            expect(await document.text()).toContain("<openclaw-app>");
            const asset = await fetch(origin + basePath + "/assets/app.js", {
              signal: AbortSignal.timeout(3000),
            });
            expect(asset.status).toBe(200);
            expect(await asset.text()).toBe("// app bytes");
          } finally {
            runtime.resolve();
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => {
              server.close((error) => {
                if (error) {
                  reject(error);
                } else {
                  resolve();
                }
              });
            });
          }
        },
      });
    });
  },
);

it("retains callback ownership and retries missing resolved documents during startup", async () => {
  await withTempDir("control-ui-startup-recovery-", async (root) => {
    const index = path.join(root, "index.html");
    await fs.writeFile(index, "<!doctype html><openclaw-app></openclaw-app>");
    let runtimeEntries = 0;
    await withGatewayServer({
      prefix: "control-ui-startup-recovery",
      resolvedAuth: AUTH_NONE,
      overrides: {
        controlUiEnabled: true,
        controlUiBasePath: "",
        controlUiRoot: { kind: "resolved", path: root },
        getStartup: () => ({
          ok: false,
          status: "starting",
          uptimeMs: 1,
          pendingReason: "startup-sidecars",
        }),
        isRequestRuntimeReady: () => false,
        waitForRequestRuntime: async () => {
          runtimeEntries++;
        },
        handleMcpOAuthCallbackRequest: async (_req, res) => {
          res.end("callback owner");
          return true;
        },
      },
      run: async (server) => {
        const request = (pathname: string) =>
          sendRequest(server, {
            path: pathname,
            method: "GET",
            host: "127.0.0.1",
            headers: { accept: "text/html" },
          });
        const callback = await request("/oauth/mcp/callback?code=synthetic");
        expect.soft(callback.getBody()).toBe("callback owner");
        expect.soft(runtimeEntries).toBe(1);
        for (const missing of [index, root]) {
          await fs.rm(missing, { recursive: true });
          const document = await request("/new");
          expect.soft(document.res.statusCode).toBe(503);
          expect.soft(document.getBody()).toContain('id="openclaw-maintenance"');
        }
      },
    });
  });
});
