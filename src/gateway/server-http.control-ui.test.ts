import fsSync from "node:fs";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import nodePath from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { saveMediaBuffer } from "../media/store.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  AUTH_NONE,
  AUTH_TOKEN,
  sendRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";

type Request = Parameters<typeof sendRequest>[1];
type ServerOptions = Parameters<typeof withGatewayServer>[0];
type Check = (
  path: string,
  status: number,
  options?: Omit<Request, "path"> & { body?: unknown },
) => ReturnType<typeof sendRequest>;

function withUiServer(
  run: (check: Check) => Promise<void>,
  overrides: ServerOptions["overrides"] = {},
  resolvedAuth = AUTH_NONE,
) {
  return withGatewayServer({
    prefix: "control-ui",
    resolvedAuth,
    overrides: { controlUiEnabled: true, controlUiBasePath: "", ...overrides },
    run: async (server) =>
      run(async (path: string, status: number, { body, ...options }: Parameters<Check>[2] = {}) => {
        const response = await sendRequest(server, { path, ...options });
        expect(response.res.statusCode, `${options.method ?? "GET"} ${path}`).toBe(status);
        if (body !== undefined) {
          expect(response.getBody()).toEqual(body);
        }
        return response;
      }),
  });
}

function withUiRoot(
  run: (check: Check, root: string) => Promise<void>,
  configure: (root: string) => ServerOptions["overrides"] | Promise<ServerOptions["overrides"]>,
) {
  return withTempDir("openclaw-http-ui-", async (directory) => {
    const root = await fs.realpath(directory);
    await fs.writeFile(nodePath.join(root, "index.html"), "<html>spa fallback</html>\n");
    await fs.mkdir(nodePath.join(root, "assets"));
    await fs.writeFile(nodePath.join(root, "assets", "app.js"), "// synthetic asset\n");
    await withUiServer((check) => run(check, root), {
      controlUiRoot: { kind: "resolved", path: root },
      ...(await configure(root)),
    });
  });
}

it.each([
  { basePath: "", enabled: true },
  { basePath: "/console/", enabled: false },
])("authenticates media at $basePath with UI enabled=$enabled", ({ basePath, enabled }) =>
  withUiServer(
    async (check) => {
      const base = basePath.replace(/\/$/, "");
      const media = await saveMediaBuffer(
        createSolidPngBuffer(4, 2, { r: 24, g: 64, b: 128 }),
        "image/png",
      );
      const query = new URLSearchParams({ meta: "1", source: `media://inbound/${media.id}` });
      const mediaPath = `${base}/__openclaw__/assistant-media?${query}`;
      for (const [method, path] of [
        ["GET", mediaPath],
        ["POST", `${mediaPath}&allow=1`],
      ] as const) {
        await check(path, 401, { method });
      }
      const metadata = await check(mediaPath, 200, {
        authorization: `Bearer ${AUTH_TOKEN.token}`,
      });
      expect(JSON.parse(metadata.getBody())).toMatchObject({
        available: true,
        mimeType: "image/png",
        mediaTicket: expect.any(String),
      });
      await check(`${base}/avatar/main?meta=1`, enabled ? 401 : 404);
      if (!enabled) {
        await check(`${base}/`, 404);
      }
    },
    { controlUiEnabled: enabled, controlUiBasePath: basePath },
    AUTH_TOKEN,
  ),
);

it("rejects UI POST before startup fallback", () =>
  withUiServer(
    async (check) => {
      const response = await check("/ui", 404, { method: "POST", body: "Not Found" });
      expect(response.setHeader).toHaveBeenCalledWith(
        "Permissions-Policy",
        "camera=(self), microphone=*, geolocation=*, clipboard-write=*",
      );
    },
    { isStartupPluginRuntimeReady: () => false },
  ));

it.each(["", "/console/"])("leaves unclaimed media writes to startup at base %j", (basePath) =>
  withUiServer(
    async (check) => {
      const base = basePath.replace(/\/$/, "");
      for (const query of ["meta=1", "allow=1", "meta=1&allow=0"]) {
        await check(`${base}/__openclaw__/assistant-media?${query}&source=missing.png`, 503, {
          method: "POST",
          body: "Plugin runtime is starting",
        });
      }
    },
    { controlUiBasePath: basePath, isStartupPluginRuntimeReady: () => false },
    AUTH_TOKEN,
  ),
);

it("applies dashboard enablement to subsequent requests without replacing the listener", async () => {
  let enabled: boolean | undefined = false;
  await withUiRoot(
    async (check) => {
      for (const next of [false, true, false, undefined]) {
        enabled = next;
        for (const path of ["/", "/chat", "/assets/app.js", "/control-ui-config.json"]) {
          await check(path, enabled === false ? 404 : 200);
        }
        await check("/healthz", 200);
      }
    },
    () => ({
      controlUiEnabled: undefined,
      getRuntimeConfig: () => ({ gateway: { controlUi: { enabled } } }),
    }),
  );
});

it("resolves identity for documents and bootstrap, not assets", () =>
  withUiRoot(
    async (check, workspace) => {
      const identityRuntime = await import("../agents/identity-file-runtime.js");
      const prepareIdentity = vi.spyOn(identityRuntime, "prepareIdentityFile");
      const realpath = vi.spyOn(fsSync, "realpathSync");
      onTestFinished(() => {
        prepareIdentity.mockRestore();
        realpath.mockRestore();
      });
      const identityReads = () =>
        realpath.mock.calls.filter(([file]) => nodePath.basename(String(file)) === "IDENTITY.md");
      await check("/assets/app.js", 200);
      await check("/assets/app.js", 200, { method: "HEAD", body: "" });
      expect(identityReads()).toHaveLength(0);
      expect(prepareIdentity).not.toHaveBeenCalled();

      for (const path of ["/", "/chat"]) {
        const response = await check(path, 200);
        for (const fragment of [
          'data-openclaw-bootstrap-config="',
          "&quot;assistantAgentId&quot;:&quot;research&quot;",
          "&quot;assistantName&quot;:&quot;Synthetic assistant&quot;",
        ]) {
          expect(response.getBody()).toContain(fragment);
        }
        expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
      }

      const bootstrap = await check("/control-ui-config.json", 200);
      expect(JSON.parse(bootstrap.getBody())).toMatchObject({
        assistantAgentId: "research",
        assistantName: "Synthetic assistant",
      });
      expect(prepareIdentity).toHaveBeenCalledWith(nodePath.join(workspace, "IDENTITY.md"));
      expect(identityReads()).toHaveLength(0);
    },
    async (workspace) => {
      await fs.writeFile(nodePath.join(workspace, "IDENTITY.md"), "- Name: Synthetic assistant\n");
      return {
        getRuntimeConfig: () => ({
          agents: {
            ownership: "explicit",
            entries: { ops: {}, research: { workspace } },
            defaults: { systemAgent: { agentId: "research" } },
          },
        }),
      };
    },
  ));
it("serves marketplace documents without claiming plugin HTTP routes", () =>
  withUiRoot(
    async (check) => {
      const browserRequest: Check = (path, status, options) =>
        check(path, status, { headers: { accept: "text/html" }, ...options });
      const documentPaths = ["", "/", "/ch_bWF0cml4", "/local_bWVtb3J5"].map(
        (path) => `/plugins${path}`,
      );
      for (const pathname of documentPaths) {
        await browserRequest(pathname, 200, { body: expect.stringContaining("spa fallback") });
        await browserRequest(pathname, 200, { method: "HEAD", body: "" });
      }
      for (const [path, method, accept] of [
        ...documentPaths.flatMap((pathname) => [
          [pathname, "GET", "application/json"] as const,
          [pathname, "GET", "text/html;q=0"] as const,
          [pathname, "POST", "text/html"] as const,
        ]),
        ...["/plugins/unclaimed", "/plugins/ch_a", "/plugins/ch_bWF0cml4/extra"].map(
          (pathname) => [pathname, "GET", "text/html"] as const,
        ),
      ]) {
        await browserRequest(path, 404, { method, headers: { accept }, body: "Not Found" });
      }
      await browserRequest("/plugins/webhook", 202, { body: "plugin response" });
      await browserRequest("/settings/plugins", 200, {
        body: expect.stringContaining("spa fallback"),
      });
    },
    () => ({
      handlePluginRequest: async (req, res) => {
        if (req.url !== "/plugins/webhook") {
          return false;
        }
        res.statusCode = 202;
        res.end("plugin response");
        return true;
      },
      shouldEnforcePluginGatewayAuth: () => false,
      isStartupPluginRuntimeReady: () => true,
    }),
  ));

it.each(["", "/claw"])(
  "serves the configured GitLab callback before an overlapping hook at %s",
  async (basePath) => {
    const hooks = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 405;
      res.end("hook");
      return true;
    });
    await withUiRoot(
      async (check) => {
        const callback = await check(
          `${basePath}/oauth/gitlab/callback?code=synthetic&state=synthetic`,
          200,
          {
            headers: { accept: "text/html" },
          },
        );
        expect(callback.getBody()).toContain("spa fallback");
        expect(callback.setHeader).toHaveBeenCalledWith("Referrer-Policy", "no-referrer");
        expect(hooks).not.toHaveBeenCalled();
        await check(`${basePath}/oauth/unrelated`, 405);
        expect(hooks).toHaveBeenCalledOnce();
      },
      () => ({
        controlUiBasePath: basePath,
        handleHooksRequest: hooks,
        getRuntimeConfig: () => ({
          gateway: {
            gitlab: {
              issuer: "https://gitlab.example.test",
              clientId: "public-fixture",
              redirectUri: `https://gateway.example.test${basePath}/oauth/gitlab/callback`,
            },
          },
        }),
      }),
    );
  },
);
